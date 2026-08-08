import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import engDataUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import { assignGroupsBySpacing, type DetectedTile, type Rect, type TileColor } from './domain';

type PixelRect = { x: number; y: number; width: number; height: number };

type TileCandidate = {
  pixelBounds: PixelRect;
  bounds: Rect;
  color: TileColor;
  shapeConfidence: number;
};

export type FrameQuality = {
  brightness: number;
  sharpness: number;
  message: string | null;
};

export type RecognitionResult = {
  tiles: DetectedTile[];
  quality: FrameQuality;
};

let workerPromise: Promise<Worker> | null = null;

async function getWorker(onProgress?: (progress: number) => void) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const languageFile = new URL(engDataUrl, window.location.href).toString();
      const langPath = languageFile.slice(0, languageFile.lastIndexOf('/'));
      const worker = await createWorker(
        'eng',
        OEM.LSTM_ONLY,
        {
          langPath,
          gzip: true,
          logger: (message) => {
            if (message.status === 'recognizing text') onProgress?.(message.progress);
          },
        },
      );
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_WORD,
        tessedit_char_whitelist: '0123456789',
        preserve_interword_spaces: '1',
        user_defined_dpi: '180',
      });
      return worker;
    })();
  }

  return workerPromise;
}

export async function disposeRecognitionWorker() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } finally {
    workerPromise = null;
  }
}

export function captureVisibleVideo(video: HTMLVideoElement, targetWidth = 640) {
  const displayWidth = video.clientWidth || window.innerWidth;
  const displayHeight = video.clientHeight || window.innerHeight;
  const displayAspect = displayWidth / Math.max(1, displayHeight);
  const sourceAspect = video.videoWidth / Math.max(1, video.videoHeight);
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;

  if (sourceAspect > displayAspect) {
    sourceWidth = video.videoHeight * displayAspect;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = video.videoWidth / displayAspect;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = Math.round(targetWidth / displayAspect);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Kamera karesi okunamadı.');
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

const pixelIsTile = (red: number, green: number, blue: number) => {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
  return luminance > 142 && maximum - minimum < 100 && red > blue - 34;
};

function closeMask(mask: Uint8Array, width: number, height: number) {
  const dilated = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      let isOn = 0;
      for (let oy = -1; oy <= 1 && !isOn; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (mask[index + oy * width + ox]) {
            isOn = 1;
            break;
          }
        }
      }
      dilated[index] = isOn;
    }
  }

  const closed = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      let isOn = 1;
      for (let oy = -1; oy <= 1 && isOn; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!dilated[index + oy * width + ox]) {
            isOn = 0;
            break;
          }
        }
      }
      closed[index] = isOn;
    }
  }
  return closed;
}

function dominantInkColor(image: ImageData, bounds: PixelRect): TileColor {
  const counts: Record<TileColor, number> = { red: 0, blue: 0, black: 0, yellow: 0 };
  const startX = Math.round(bounds.x + bounds.width * 0.16);
  const endX = Math.round(bounds.x + bounds.width * 0.84);
  const startY = Math.round(bounds.y + bounds.height * 0.12);
  const endY = Math.round(bounds.y + bounds.height * 0.88);

  for (let y = startY; y < endY; y += 2) {
    for (let x = startX; x < endX; x += 2) {
      const index = (y * image.width + x) * 4;
      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;

      if (luminance < 88 && maximum - minimum < 46) counts.black += 1;
      else if (red > 130 && green > 72 && blue < 118 && red - blue > 50 && green - blue > 34) counts.yellow += 1;
      else if (red > 118 && red > green * 1.26 && red > blue * 1.28) counts.red += 1;
      else if (blue > 92 && blue > red * 1.17 && blue > green * 1.04) counts.blue += 1;
    }
  }

  return (Object.entries(counts) as Array<[TileColor, number]>).sort((a, b) => b[1] - a[1])[0][0];
}

function analyzeFrameQuality(image: ImageData): FrameQuality {
  let luminanceTotal = 0;
  let sampleCount = 0;
  let laplacianTotal = 0;
  const width = image.width;
  const startY = Math.round(image.height * 0.25);
  const endY = Math.round(image.height * 0.73);

  const luminanceAt = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    return image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
  };

  for (let y = startY + 2; y < endY - 2; y += 4) {
    for (let x = 2; x < width - 2; x += 4) {
      const center = luminanceAt(x, y);
      luminanceTotal += center;
      laplacianTotal += Math.abs(
        luminanceAt(x - 2, y) + luminanceAt(x + 2, y) + luminanceAt(x, y - 2) + luminanceAt(x, y + 2) - 4 * center,
      );
      sampleCount += 1;
    }
  }

  const brightness = luminanceTotal / Math.max(1, sampleCount);
  const sharpness = laplacianTotal / Math.max(1, sampleCount);
  const message = brightness < 52
    ? 'Biraz daha ışık gerekli'
    : sharpness < 8
      ? 'Telefonu sabit tut'
      : null;
  return { brightness, sharpness, message };
}

function findTileCandidates(canvas: HTMLCanvasElement): { candidates: TileCandidate[]; quality: FrameQuality } {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { candidates: [], quality: { brightness: 0, sharpness: 0, message: 'Kare okunamadı' } };
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const roiY = Math.round(canvas.height * 0.25);
  const roiHeight = Math.round(canvas.height * 0.48);
  const mask = new Uint8Array(canvas.width * roiHeight);

  for (let y = 0; y < roiHeight; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const imageIndex = ((y + roiY) * canvas.width + x) * 4;
      mask[y * canvas.width + x] = pixelIsTile(
        image.data[imageIndex],
        image.data[imageIndex + 1],
        image.data[imageIndex + 2],
      ) ? 1 : 0;
    }
  }

  const closed = closeMask(mask, canvas.width, roiHeight);
  const queue = new Int32Array(closed.length);
  const pixelRects: Array<PixelRect & { area: number }> = [];

  for (let start = 0; start < closed.length; start += 1) {
    if (!closed[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    closed[start] = 0;
    let minX = start % canvas.width;
    let maxX = minX;
    let minY = Math.floor(start / canvas.width);
    let maxY = minY;
    let area = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % canvas.width;
      const y = Math.floor(index / canvas.width);
      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const neighbors = [index - 1, index + 1, index - canvas.width, index + canvas.width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= closed.length || !closed[neighbor]) continue;
        const neighborX = neighbor % canvas.width;
        if (Math.abs(neighborX - x) > 1) continue;
        closed[neighbor] = 0;
        queue[tail++] = neighbor;
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const aspect = width / Math.max(1, height);
    const fill = area / Math.max(1, width * height);
    if (
      width >= canvas.width * 0.025 &&
      width <= canvas.width * 0.15 &&
      height >= roiHeight * 0.2 &&
      height <= roiHeight * 0.92 &&
      aspect >= 0.25 &&
      aspect <= 0.88 &&
      fill > 0.47
    ) {
      pixelRects.push({ x: minX, y: minY + roiY, width, height, area });
    }
  }

  const candidates = pixelRects
    .sort((a, b) => b.area - a.area)
    .filter((rect, index, rects) => !rects.slice(0, index).some((other) => {
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      return centerX > other.x && centerX < other.x + other.width && centerY > other.y && centerY < other.y + other.height;
    }))
    .slice(0, 28)
    .map((pixelBounds) => ({
      pixelBounds,
      bounds: {
        x: pixelBounds.x / canvas.width,
        y: pixelBounds.y / canvas.height,
        width: pixelBounds.width / canvas.width,
        height: pixelBounds.height / canvas.height,
      },
      color: dominantInkColor(image, pixelBounds),
      shapeConfidence: Math.min(0.96, 0.58 + (pixelBounds.area / (pixelBounds.width * pixelBounds.height)) * 0.4),
    }))
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);

  return { candidates, quality: analyzeFrameQuality(image) };
}

function buildOcrCells(source: HTMLCanvasElement, candidates: TileCandidate[]) {
  const cellWidth = 128;
  const cellHeight = 116;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('OCR karesi hazırlanamadı.');
  const cells: HTMLCanvasElement[] = [];

  candidates.forEach((candidate, index) => {
    const { pixelBounds } = candidate;
    const scratch = document.createElement('canvas');
    scratch.width = 96;
    scratch.height = 104;
    const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
    if (!scratchContext) return;
    scratchContext.drawImage(
      source,
      pixelBounds.x + pixelBounds.width * 0.025,
      pixelBounds.y + pixelBounds.height * 0.035,
      pixelBounds.width * 0.95,
      pixelBounds.height * 0.93,
      0,
      0,
      scratch.width,
      scratch.height,
    );
    const pixels = scratchContext.getImageData(0, 0, scratch.width, scratch.height);
    let minX = scratch.width;
    let minY = scratch.height;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < scratch.height; y += 1) {
      for (let x = 0; x < scratch.width; x += 1) {
        const offset = (y * scratch.width + x) * 4;
        const red = pixels.data[offset];
        const green = pixels.data[offset + 1];
        const blue = pixels.data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        const isInk = luminance < 112 || (maximum - minimum > 54 && luminance < 215);
        const nearEdge = x < 3 || x > scratch.width - 4 || y < 3 || y > scratch.height - 4;
        const black = isInk && !nearEdge;
        pixels.data[offset] = black ? 0 : 255;
        pixels.data[offset + 1] = black ? 0 : 255;
        pixels.data[offset + 2] = black ? 0 : 255;
        pixels.data[offset + 3] = 255;
        if (black) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    scratchContext.putImageData(pixels, 0, 0);

    if (maxX > minX && maxY > minY) {
      const inkWidth = maxX - minX + 1;
      const inkHeight = maxY - minY + 1;
      const scale = Math.min(90 / inkWidth, 88 / inkHeight);
      const drawWidth = inkWidth * scale;
      const drawHeight = inkHeight * scale;
      const cell = document.createElement('canvas');
      cell.width = cellWidth;
      cell.height = cellHeight;
      const cellContext = cell.getContext('2d');
      if (!cellContext) return;
      cellContext.fillStyle = '#fff';
      cellContext.fillRect(0, 0, cellWidth, cellHeight);
      cellContext.imageSmoothingEnabled = true;
      cellContext.drawImage(
        scratch,
        minX,
        minY,
        inkWidth,
        inkHeight,
        (cellWidth - drawWidth) / 2,
        (cellHeight - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
      cells[index] = cell;
    }
  });

  return cells;
}

export async function recognizeRack(
  source: HTMLCanvasElement,
  onProgress?: (progress: number) => void,
): Promise<RecognitionResult> {
  const { candidates, quality } = findTileCandidates(source);
  if (!candidates.length) return { tiles: [], quality };

  const cells = buildOcrCells(source, candidates);
  const worker = await getWorker(onProgress);
  const recognizedByCell = new Map<number, { value: number; confidence: number }>();

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (!cell) continue;
    const result = await worker.recognize(cell);
    const digits = result.data.text.replace(/\D/g, '');
    const value = Number.parseInt(digits, 10);
    if (!Number.isInteger(value) || value < 1 || value > 13) continue;
    recognizedByCell.set(index, { value, confidence: result.data.confidence / 100 });
  }

  const tiles = candidates.map((candidate, index): DetectedTile => {
    const recognized = recognizedByCell.get(index);
    return {
      id: `tile-${Math.round(candidate.bounds.x * 1000)}-${Math.round(candidate.bounds.y * 1000)}`,
      number: recognized?.value ?? null,
      color: candidate.color,
      confidence: recognized
        ? Math.max(0, Math.min(1, recognized.confidence * 0.72 + candidate.shapeConfidence * 0.28))
        : candidate.shapeConfidence * 0.35,
      bounds: candidate.bounds,
      groupIndex: 0,
    };
  });

  return { tiles: assignGroupsBySpacing(tiles), quality };
}
