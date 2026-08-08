import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import engDataUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import { assignGroupsBySpacing, type DetectedTile, type Rect, type TileColor } from './domain';
import { OKEY_GLYPH_TEMPLATES } from './okeyGlyphTemplates';

type PixelRect = { x: number; y: number; width: number; height: number };

type TileCandidate = {
  pixelBounds: PixelRect;
  ocrBounds?: PixelRect;
  bounds: Rect;
  color: TileColor;
  shapeConfidence: number;
  isJoker?: boolean;
  templateValue?: number;
  templateConfidence?: number;
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
  const startX = Math.max(0, Math.round(bounds.x));
  const endX = Math.min(image.width, Math.round(bounds.x + bounds.width));
  const startY = Math.max(0, Math.round(bounds.y));
  const endY = Math.min(image.height, Math.round(bounds.y + bounds.height));
  const samples: Array<{ red: number; green: number; blue: number; luminance: number }> = [];

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * image.width + x) * 4;
      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      samples.push({ red, green, blue, luminance });
    }
  }

  if (!samples.length) return 'black';
  const luminances = samples.map((sample) => sample.luminance).sort((a, b) => a - b);
  const background = luminances[Math.floor(luminances.length * 0.82)] ?? 255;

  for (const { red, green, blue, luminance } of samples) {
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const chroma = maximum - minimum;
    if (luminance > background - 13 && chroma < 22) continue;

    if (chroma < 13 || maximum < 42) counts.black += 1;
    else if (red > blue + 21 && green > blue + 10 && red >= green) counts.yellow += 1;
    else if (red > green + 10 && red > blue + 10) counts.red += 1;
    else if (green > red + 8 && blue > red + 7) counts.blue += 1;
  }

  const sorted = (Object.entries(counts) as Array<[TileColor, number]>).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'black';
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

function findBodyTileCandidates(canvas: HTMLCanvasElement): { candidates: TileCandidate[]; quality: FrameQuality } {
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

type InkComponent = PixelRect & {
  area: number;
  centerX: number;
  centerY: number;
  parts: PixelRect[];
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function openInkMask(mask: Uint8Array, width: number, height: number) {
  const eroded = new Uint8Array(mask.length);
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const index = y * width + x;
      if (mask[index] && mask[index + 1] && mask[index + width] && mask[index + width + 1]) {
        eroded[index] = 1;
      }
    }
  }

  const opened = new Uint8Array(mask.length);
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!eroded[index]) continue;
      opened[index] = 1;
      opened[index + 1] = 1;
      opened[index + width] = 1;
      opened[index + width + 1] = 1;
    }
  }
  return opened;
}

function buildInkMask(image: ImageData, roiY: number, roiHeight: number) {
  const { width, height } = image;
  const luminance = new Float32Array(width * height);
  const integral = new Float64Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = image.data[offset] * 0.299
        + image.data[offset + 1] * 0.587
        + image.data[offset + 2] * 0.114;
      luminance[y * width + x] = value;
      rowTotal += value;
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowTotal;
    }
  }

  const radius = Math.max(7, Math.round(width * 0.018));
  const mask = new Uint8Array(width * roiHeight);
  for (let localY = 0; localY < roiHeight; localY += 1) {
    const y = localY + roiY;
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const localTotal = integral[(y1 + 1) * (width + 1) + x1 + 1]
        - integral[y0 * (width + 1) + x1 + 1]
        - integral[(y1 + 1) * (width + 1) + x0]
        + integral[y0 * (width + 1) + x0];
      const localMean = localTotal / area;
      const offset = (y * width + x) * 4;
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      const value = luminance[y * width + x];
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const isInk = (value < localMean - 17 && value < 168)
        || (chroma > 18 && value < 142 && value < localMean - 3)
        || (value < 72 && value < localMean - 8);
      mask[localY * width + x] = isInk ? 1 : 0;
    }
  }
  return { mask: openInkMask(mask, width, roiHeight), luminance };
}

function findInkComponents(mask: Uint8Array, width: number, height: number, offsetY: number) {
  const working = new Uint8Array(mask);
  const queue = new Int32Array(working.length);
  const components: InkComponent[] = [];
  const minimumHeight = Math.max(6, width * 0.012);
  const maximumHeight = width * 0.085;

  for (let start = 0; start < working.length; start += 1) {
    if (!working[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    working[start] = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let area = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      area += 1;

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= working.length || !working[neighbor]) continue;
        if (Math.abs((neighbor % width) - x) > 1) continue;
        working[neighbor] = 0;
        queue[tail++] = neighbor;
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const fill = area / (componentWidth * componentHeight);
    if (
      componentHeight >= minimumHeight
      && componentHeight <= maximumHeight
      && componentWidth >= Math.max(2, width * 0.003)
      && componentWidth <= width * 0.055
      && componentWidth >= componentHeight * 0.26
      && area >= Math.max(9, width * width * 0.00002)
      && fill >= 0.2
    ) {
      const y = minY + offsetY;
      components.push({
        x: minX,
        y,
        width: componentWidth,
        height: componentHeight,
        area,
        centerX: minX + componentWidth / 2,
        centerY: y + componentHeight / 2,
        parts: [{ x: minX, y, width: componentWidth, height: componentHeight }],
      });
    }
  }
  return components;
}

function mergeDigitComponents(components: InkComponent[]) {
  if (!components.length) return [];
  const typicalHeight = median(components.map((component) => component.height));
  const sorted = [...components].sort((a, b) => a.x - b.x);
  const tokens: InkComponent[] = [];

  for (const component of sorted) {
    const previous = tokens[tokens.length - 1];
    const gap = previous ? component.x - (previous.x + previous.width) : Number.POSITIVE_INFINITY;
    const centersAlign = previous
      ? Math.abs(component.centerY - previous.centerY) <= typicalHeight * 0.38
      : false;
    const combinedWidth = previous ? component.x + component.width - previous.x : 0;
    if (previous && gap <= typicalHeight * 0.34 && centersAlign && combinedWidth <= typicalHeight * 1.65) {
      const right = Math.max(previous.x + previous.width, component.x + component.width);
      const bottom = Math.max(previous.y + previous.height, component.y + component.height);
      previous.x = Math.min(previous.x, component.x);
      previous.y = Math.min(previous.y, component.y);
      previous.width = right - previous.x;
      previous.height = bottom - previous.y;
      previous.area += component.area;
      previous.centerX = previous.x + previous.width / 2;
      previous.centerY = previous.y + previous.height / 2;
      previous.parts.push(...component.parts);
    } else {
      tokens.push({ ...component });
    }
  }
  return tokens;
}

const GLYPH_WIDTH = 16;
const GLYPH_HEIGHT = 24;

function normalizeGlyph(mask: Uint8Array, maskWidth: number, roiY: number, bounds: PixelRect) {
  let minX = Math.max(0, Math.floor(bounds.x));
  let maxX = Math.min(maskWidth - 1, Math.ceil(bounds.x + bounds.width) - 1);
  let minY = Math.max(0, Math.floor(bounds.y - roiY));
  let maxY = Math.min(Math.floor(mask.length / maskWidth) - 1, Math.ceil(bounds.y + bounds.height - roiY) - 1);
  let found = false;
  let inkMinX = maxX;
  let inkMaxX = minX;
  let inkMinY = maxY;
  let inkMaxY = minY;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!mask[y * maskWidth + x]) continue;
      found = true;
      inkMinX = Math.min(inkMinX, x);
      inkMaxX = Math.max(inkMaxX, x);
      inkMinY = Math.min(inkMinY, y);
      inkMaxY = Math.max(inkMaxY, y);
    }
  }
  if (!found) return new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT);

  minX = inkMinX;
  maxX = inkMaxX;
  minY = inkMinY;
  maxY = inkMaxY;
  const sourceWidth = maxX - minX + 1;
  const sourceHeight = maxY - minY + 1;
  const scale = Math.min((GLYPH_WIDTH - 2) / sourceWidth, (GLYPH_HEIGHT - 2) / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const offsetX = Math.floor((GLYPH_WIDTH - drawWidth) / 2);
  const offsetY = Math.floor((GLYPH_HEIGHT - drawHeight) / 2);
  const normalized = new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT);

  for (let y = 0; y < drawHeight; y += 1) {
    const sourceY = minY + Math.min(sourceHeight - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < drawWidth; x += 1) {
      const sourceX = minX + Math.min(sourceWidth - 1, Math.floor((x + 0.5) / scale));
      normalized[(y + offsetY) * GLYPH_WIDTH + x + offsetX] = mask[sourceY * maskWidth + sourceX];
    }
  }
  return normalized;
}

function glyphSimilarity(candidate: Uint8Array, template: Uint8Array) {
  let candidateArea = 0;
  let templateArea = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    candidateArea += candidate[index];
    templateArea += template[index];
  }
  let best = 0;
  for (let shiftY = -1; shiftY <= 1; shiftY += 1) {
    for (let shiftX = -1; shiftX <= 1; shiftX += 1) {
      let intersection = 0;
      for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
        const templateY = y - shiftY;
        if (templateY < 0 || templateY >= GLYPH_HEIGHT) continue;
        for (let x = 0; x < GLYPH_WIDTH; x += 1) {
          const templateX = x - shiftX;
          if (templateX < 0 || templateX >= GLYPH_WIDTH) continue;
          if (candidate[y * GLYPH_WIDTH + x] && template[templateY * GLYPH_WIDTH + templateX]) {
            intersection += 1;
          }
        }
      }
      best = Math.max(best, (2 * intersection) / Math.max(1, candidateArea + templateArea));
    }
  }
  return best;
}

function classifyGlyph(candidate: Uint8Array) {
  const scores = new Map<number, number>();
  for (const template of OKEY_GLYPH_TEMPLATES) {
    scores.set(
      template.digit,
      Math.max(scores.get(template.digit) ?? 0, glyphSimilarity(candidate, template.pixels)),
    );
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  let [digit, score] = ranked[0];
  let runnerUp = ranked[1]?.[1] ?? 0;
  let structuralOverride = false;

  const eightScore = scores.get(8) ?? 0;
  let middleInk = 0;
  let middlePixels = 0;
  for (let y = Math.floor(GLYPH_HEIGHT * 0.4); y < Math.ceil(GLYPH_HEIGHT * 0.65); y += 1) {
    for (let x = 0; x < GLYPH_WIDTH; x += 1) {
      middleInk += candidate[y * GLYPH_WIDTH + x];
      middlePixels += 1;
    }
  }
  if (
    (digit === 0 || digit === 6)
    && score - eightScore < 0.04
    && middleInk / middlePixels > 0.59
  ) {
    digit = 8;
    score = eightScore;
    runnerUp = Math.max(
      ...[...scores.entries()]
        .filter(([value]) => value !== 0 && value !== 8)
        .map(([, value]) => value),
    );
    structuralOverride = true;
  }

  return score >= 0.82 && (structuralOverride || score - runnerUp >= 0.014)
    ? { digit, score }
    : null;
}

function classifyTileToken(mask: Uint8Array, maskWidth: number, roiY: number, token: InkComponent) {
  const parts = [...token.parts].sort((a, b) => a.x - b.x);
  if (!parts.length || parts.length > 2) return null;
  const digits = parts.map((part) => classifyGlyph(normalizeGlyph(mask, maskWidth, roiY, part)));
  if (digits.some((digit) => !digit)) return null;
  const value = Number.parseInt(digits.map((digit) => digit?.digit).join(''), 10);
  if (!Number.isInteger(value) || value < 1 || value > 13) return null;
  return {
    value,
    confidence: digits.reduce((total, digit) => total + (digit?.score ?? 0), 0) / digits.length,
  };
}

function boundaryScore(
  luminance: Float32Array,
  imageWidth: number,
  imageHeight: number,
  x: number,
  centerY: number,
  tileHeight: number,
  searchRadius: number,
) {
  const y0 = clamp(Math.round(centerY - tileHeight * 0.43), 0, imageHeight - 1);
  const y1 = clamp(Math.round(centerY + tileHeight * 0.43), y0 + 1, imageHeight);
  let best = 0;
  for (let candidateX = Math.round(x - searchRadius); candidateX <= Math.round(x + searchRadius); candidateX += 1) {
    if (candidateX < 0 || candidateX >= imageWidth - 1) continue;
    let total = 0;
    for (let y = y0; y < y1; y += 1) {
      total += Math.abs(luminance[y * imageWidth + candidateX + 1] - luminance[y * imageWidth + candidateX]);
    }
    best = Math.max(best, total / Math.max(1, y1 - y0));
  }
  return best;
}

function looksLikeBlankJoker(
  luminance: Float32Array,
  imageWidth: number,
  imageHeight: number,
  centerX: number,
  centerY: number,
  tileWidth: number,
  tileHeight: number,
) {
  const searchRadius = Math.max(3, tileWidth * 0.18);
  const left = boundaryScore(
    luminance,
    imageWidth,
    imageHeight,
    centerX - tileWidth / 2,
    centerY,
    tileHeight,
    searchRadius,
  );
  const right = boundaryScore(
    luminance,
    imageWidth,
    imageHeight,
    centerX + tileWidth / 2,
    centerY,
    tileHeight,
    searchRadius,
  );
  if (Math.min(left, right) < 8 || left + right < 21) return false;

  const x0 = clamp(Math.round(centerX - tileWidth * 0.38), 0, imageWidth - 1);
  const x1 = clamp(Math.round(centerX + tileWidth * 0.38), x0 + 1, imageWidth);
  const y0 = clamp(Math.round(centerY - tileHeight * 0.39), 0, imageHeight - 1);
  const y1 = clamp(Math.round(centerY + tileHeight * 0.15), y0 + 1, imageHeight);
  const samples: number[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) samples.push(luminance[y * imageWidth + x]);
  }
  samples.sort((a, b) => a - b);
  const background = samples[Math.floor(samples.length * 0.8)] ?? 255;
  const darkFraction = samples.filter((value) => value < background - 25).length / Math.max(1, samples.length);
  return darkFraction < 0.065;
}

function findDigitTileCandidates(canvas: HTMLCanvasElement): TileCandidate[] {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const roiY = Math.round(canvas.height * 0.22);
  const roiHeight = Math.round(canvas.height * 0.54);
  const { mask, luminance } = buildInkMask(image, roiY, roiHeight);
  const components = findInkComponents(mask, canvas.width, roiHeight, roiY);
  if (components.length < 3) return [];

  const rowBands = components
    .map((seed) => {
      const tolerance = Math.max(canvas.width * 0.008, seed.height * 0.4);
      const members = components.filter((component) => Math.abs(component.centerY - seed.centerY) <= tolerance);
      const left = Math.min(...members.map((component) => component.x));
      const right = Math.max(...members.map((component) => component.x + component.width));
      const area = members.reduce((total, component) => total + component.area, 0);
      return {
        centerY: median(members.map((component) => component.centerY)),
        members,
        span: right - left,
        score: members.length * 1000 + area + right - left,
      };
    })
    .filter((band) => band.members.length >= 3 && band.span >= canvas.width * 0.15)
    .sort((a, b) => b.score - a.score);

  const selectedBands: typeof rowBands = [];
  for (const band of rowBands) {
    const bandHeight = median(band.members.map((component) => component.height));
    if (selectedBands.some((selected) => Math.abs(selected.centerY - band.centerY) < bandHeight * 1.35)) continue;
    selectedBands.push(band);
    if (selectedBands.length === 2) break;
  }

  const candidates: TileCandidate[] = [];
  for (const band of selectedBands.sort((a, b) => a.centerY - b.centerY)) {
    const initialHeight = median(band.members.map((component) => component.height));
    const rowComponents = components.filter(
      (component) => Math.abs(component.centerY - band.centerY) <= Math.max(canvas.width * 0.009, initialHeight * 0.48),
    );
    const tokens = mergeDigitComponents(rowComponents).filter(
      (token) => token.width >= token.height * 0.36 && token.height >= initialHeight * 0.72,
    );
    if (tokens.length < 2) continue;

    const tokenCenters = tokens.map((token) => token.centerX).sort((a, b) => a - b);
    const rawGaps = tokenCenters.slice(1).map((center, index) => center - tokenCenters[index]);
    const gapMedian = median(rawGaps);
    const compactGaps = rawGaps.filter((gap) => gap <= gapMedian * 1.35 && gap >= initialHeight * 1.05);
    const pitch = clamp(
      median(compactGaps.length ? compactGaps : rawGaps),
      initialHeight * 1.35,
      initialHeight * 3.1,
    );
    const tileWidth = clamp(pitch * 1.03, initialHeight * 1.5, initialHeight * 2.85);
    const tileHeight = Math.max(tileWidth * 1.38, initialHeight * 2.35);
    const rowCenterY = median(tokens.map((token) => token.centerY)) + initialHeight * 0.12;

    for (const token of tokens) {
      const templateReading = classifyTileToken(mask, canvas.width, roiY, token);
      const centerX = token.centerX + tileWidth * 0.055;
      const pixelBounds = {
        x: clamp(centerX - tileWidth / 2, 0, canvas.width - tileWidth),
        y: clamp(rowCenterY - tileHeight / 2, 0, canvas.height - tileHeight),
        width: tileWidth,
        height: tileHeight,
      };
      candidates.push({
        pixelBounds,
        ocrBounds: token,
        bounds: {
          x: pixelBounds.x / canvas.width,
          y: pixelBounds.y / canvas.height,
          width: pixelBounds.width / canvas.width,
          height: pixelBounds.height / canvas.height,
        },
        color: dominantInkColor(image, token),
        shapeConfidence: 0.84,
        templateValue: templateReading?.value,
        templateConfidence: templateReading?.confidence,
      });
    }

    const tryJoker = (centerX: number) => {
      if (centerX < tileWidth / 2 || centerX > canvas.width - tileWidth / 2) return false;
      if (tokens.some((token) => Math.abs(token.centerX - centerX) < pitch * 0.58)) return false;
      if (!looksLikeBlankJoker(
        luminance,
        canvas.width,
        canvas.height,
        centerX,
        rowCenterY,
        tileWidth,
        tileHeight,
      )) return false;
      const pixelBounds = {
        x: centerX - tileWidth / 2,
        y: clamp(rowCenterY - tileHeight / 2, 0, canvas.height - tileHeight),
        width: tileWidth,
        height: tileHeight,
      };
      candidates.push({
        pixelBounds,
        bounds: {
          x: pixelBounds.x / canvas.width,
          y: pixelBounds.y / canvas.height,
          width: pixelBounds.width / canvas.width,
          height: pixelBounds.height / canvas.height,
        },
        color: 'black',
        shapeConfidence: 0.82,
        isJoker: true,
      });
      return true;
    };

    const sortedTokens = [...tokens].sort((a, b) => a.centerX - b.centerX);
    for (let index = 0; index < sortedTokens.length - 1; index += 1) {
      const left = sortedTokens[index].centerX;
      const right = sortedTokens[index + 1].centerX;
      if (right - left < pitch * 1.55) continue;
      for (let centerX = left + pitch; centerX < right - pitch * 0.55; centerX += pitch) {
        if (tryJoker(centerX)) break;
      }
    }
    tryJoker(sortedTokens[0].centerX - pitch);
    tryJoker(sortedTokens[sortedTokens.length - 1].centerX + pitch);
  }

  return candidates
    .filter((candidate, index, all) => !all.slice(0, index).some((other) => {
      const centerX = candidate.pixelBounds.x + candidate.pixelBounds.width / 2;
      const centerY = candidate.pixelBounds.y + candidate.pixelBounds.height / 2;
      const otherX = other.pixelBounds.x + other.pixelBounds.width / 2;
      const otherY = other.pixelBounds.y + other.pixelBounds.height / 2;
      return Math.hypot(centerX - otherX, centerY - otherY) < candidate.pixelBounds.width * 0.45;
    }))
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
    .slice(0, 28);
}

function findTileCandidates(canvas: HTMLCanvasElement): { candidates: TileCandidate[]; quality: FrameQuality } {
  const bodyResult = findBodyTileCandidates(canvas);
  const digitCandidates = findDigitTileCandidates(canvas);
  const candidates = digitCandidates.length >= 3 && digitCandidates.length > bodyResult.candidates.length
    ? digitCandidates
    : bodyResult.candidates;
  return { candidates, quality: bodyResult.quality };
}

function buildOcrCells(source: HTMLCanvasElement, candidates: TileCandidate[]) {
  const cellWidth = 128;
  const cellHeight = 116;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('OCR karesi hazırlanamadı.');
  const cells: HTMLCanvasElement[] = [];

  candidates.forEach((candidate, index) => {
    if (candidate.isJoker || candidate.templateValue) return;
    const { pixelBounds } = candidate;
    const scratch = document.createElement('canvas');
    scratch.width = 96;
    scratch.height = 104;
    const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
    if (!scratchContext) return;
    scratchContext.fillStyle = '#fff';
    scratchContext.fillRect(0, 0, scratch.width, scratch.height);
    const ocrBounds = candidate.ocrBounds;
    const padding = ocrBounds ? ocrBounds.height * 0.24 : 0;
    const sourceX = ocrBounds
      ? Math.max(0, ocrBounds.x - padding)
      : pixelBounds.x + pixelBounds.width * 0.025;
    const sourceY = ocrBounds
      ? Math.max(0, ocrBounds.y - padding)
      : pixelBounds.y + pixelBounds.height * 0.035;
    const sourceWidth = ocrBounds
      ? Math.min(source.width - sourceX, ocrBounds.width + padding * 2)
      : pixelBounds.width * 0.95;
    const sourceHeight = ocrBounds
      ? Math.min(source.height - sourceY, ocrBounds.height + padding * 2)
      : pixelBounds.height * 0.93;
    scratchContext.drawImage(
      source,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      scratch.width,
      scratch.height,
    );
    const pixels = scratchContext.getImageData(0, 0, scratch.width, scratch.height);
    const luminances: number[] = [];
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      luminances.push(
        pixels.data[offset] * 0.299
        + pixels.data[offset + 1] * 0.587
        + pixels.data[offset + 2] * 0.114,
      );
    }
    luminances.sort((a, b) => a - b);
    const background = luminances[Math.floor(luminances.length * 0.82)] ?? 255;
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
        const isInk = luminance < Math.min(148, background - 17)
          || (maximum - minimum > 18 && luminance < background - 4 && luminance < 172);
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
  if (import.meta.env.DEV) {
    (window as typeof window & { __okeyOcrCells?: HTMLCanvasElement[] }).__okeyOcrCells = cells;
  }
  const recognizedByCell = new Map<number, { value: number; confidence: number }>();
  if (cells.some(Boolean)) {
    const worker = await getWorker(onProgress);
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      if (!cell) continue;
      const result = await worker.recognize(cell);
      const digits = result.data.text.replace(/\D/g, '');
      const value = Number.parseInt(digits, 10);
      if (!Number.isInteger(value) || value < 1 || value > 13) continue;
      recognizedByCell.set(index, { value, confidence: result.data.confidence / 100 });
    }
  }

  const tiles = candidates.flatMap((candidate, index): DetectedTile[] => {
    const recognized = candidate.templateValue
      ? { value: candidate.templateValue, confidence: candidate.templateConfidence ?? 0.82 }
      : recognizedByCell.get(index);
    if (!candidate.isJoker && !recognized) return [];
    return [{
      id: `tile-${Math.round(candidate.bounds.x * 1000)}-${Math.round(candidate.bounds.y * 1000)}`,
      number: candidate.isJoker ? null : recognized?.value ?? null,
      color: candidate.color,
      confidence: candidate.isJoker
        ? candidate.shapeConfidence
        : recognized
        ? Math.max(0, Math.min(1, recognized.confidence * 0.72 + candidate.shapeConfidence * 0.28))
        : candidate.shapeConfidence * 0.35,
      bounds: candidate.bounds,
      groupIndex: 0,
      isJoker: candidate.isJoker,
    }];
  });

  return { tiles: assignGroupsBySpacing(tiles), quality };
}
