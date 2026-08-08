import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  Check,
  CircleHelp,
  Focus,
  ImageUp,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  ScanLine,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import {
  calculateScan,
  createDemoTiles,
  TILE_COLORS,
  type DetectedTile,
  type MeldResult,
  type TileColor,
} from './domain';
import {
  captureVisibleVideo,
  disposeRecognitionWorker,
  recognizeRack,
  type FrameQuality,
} from './recognition';
import { useCamera } from './useCamera';
import { createSyntheticRackCanvas } from './syntheticRack';

type ScanPhase = 'waiting' | 'loading' | 'reading' | 'ready' | 'error';

type PhotoSource = {
  canvas: HTMLCanvasElement;
  url: string;
};

async function loadPhoto(file: File): Promise<PhotoSource> {
  const isHeic = /\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type);
  let imageBlob: Blob = file;
  if (isHeic) {
    const { heicTo } = await import('heic-to');
    imageBlob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.94 });
  }

  const url = URL.createObjectURL(imageBlob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Fotoğraf açılamadı.'));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(1280, image.naturalWidth);
    canvas.height = Math.round(canvas.width * image.naturalHeight / image.naturalWidth);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Fotoğraf karesi hazırlanamadı.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function fitPhotoToStage(source: HTMLCanvasElement, stageAspect: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = Math.round(canvas.width / Math.max(0.42, stageAspect));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Fotoğraf karesi hizalanamadı.');
  context.fillStyle = '#080b09';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return canvas;
}

const COLOR_LABELS: Record<TileColor, string> = {
  red: 'Kırmızı',
  blue: 'Mavi',
  black: 'Siyah',
  yellow: 'Sarı',
};

const COLOR_HEX: Record<TileColor, string> = {
  red: '#e94b48',
  blue: '#3e8ef7',
  black: '#23272a',
  yellow: '#e3a72f',
};

const unionBounds = (meld: MeldResult) => {
  const left = Math.min(...meld.tiles.map((tile) => tile.bounds.x));
  const top = Math.min(...meld.tiles.map((tile) => tile.bounds.y));
  const right = Math.max(...meld.tiles.map((tile) => tile.bounds.x + tile.bounds.width));
  const bottom = Math.max(...meld.tiles.map((tile) => tile.bounds.y + tile.bounds.height));
  return { left, top, width: right - left, height: bottom - top };
};

function stabilizeTiles(previous: DetectedTile[], current: DetectedTile[]) {
  if (!previous.length) return current;
  return current.map((tile) => {
    const centerX = tile.bounds.x + tile.bounds.width / 2;
    const centerY = tile.bounds.y + tile.bounds.height / 2;
    const match = previous
      .map((candidate) => ({
        candidate,
        distance: Math.hypot(
          centerX - candidate.bounds.x - candidate.bounds.width / 2,
          centerY - candidate.bounds.y - candidate.bounds.height / 2,
        ),
      }))
      .filter(({ distance }) => distance < Math.max(tile.bounds.width, tile.bounds.height) * 0.25)
      .sort((a, b) => a.distance - b.distance)[0]?.candidate;

    if (!match) return tile;
    const sameReading = match.number === tile.number
      && match.color === tile.color
      && Boolean(match.isJoker) === Boolean(tile.isJoker);
    if (sameReading) {
      return { ...tile, id: match.id, confidence: Math.min(1, tile.confidence * 0.7 + match.confidence * 0.3 + 0.06) };
    }
    if (!tile.isJoker && tile.number === null && match.number !== null && match.confidence > 0.72) {
      return { ...tile, id: match.id, number: match.number, color: match.color, confidence: match.confidence * 0.84 };
    }
    return tile;
  });
}

function TileScene({ tile }: { tile: DetectedTile }) {
  return (
    <div
      className="demo-tile"
      style={{
        left: `${tile.bounds.x * 100}%`,
        top: `${tile.bounds.y * 100}%`,
        width: `${tile.bounds.width * 100}%`,
        height: `${tile.bounds.height * 100}%`,
        color: COLOR_HEX[tile.color],
      }}
    >
      <span>{tile.isJoker ? '★' : tile.number}</span>
      <i />
    </div>
  );
}

function CameraOverlay({
  tiles,
  melds,
  onEdit,
}: {
  tiles: DetectedTile[];
  melds: MeldResult[];
  onEdit: (tileId: string) => void;
}) {
  return (
    <div className="recognition-overlay" aria-label="Algılanan perler">
      {melds.map((meld) => {
        const bounds = unionBounds(meld);
        const trusted = meld.isValid && meld.confidence >= 0.56;
        return (
          <div
            className={`meld-bracket ${trusted ? 'is-valid' : 'needs-check'}`}
            key={meld.groupIndex}
            style={{
              left: `${bounds.left * 100}%`,
              top: `${bounds.top * 100}%`,
              width: `${bounds.width * 100}%`,
              height: `${bounds.height * 100}%`,
            }}
          >
            <div className="meld-sum">
              <span>{meld.isValid ? `PER ${meld.groupIndex + 1}` : 'KONTROL'}</span>
              <strong>{meld.sum}</strong>
            </div>
          </div>
        );
      })}

      {tiles.map((tile) => (
        <button
          className={`tile-target ${tile.number === null || tile.confidence < 0.56 ? 'is-uncertain' : ''}`}
          key={tile.id}
          onClick={() => onEdit(tile.id)}
          style={{
            left: `${tile.bounds.x * 100}%`,
            top: `${tile.bounds.y * 100}%`,
            width: `${tile.bounds.width * 100}%`,
            height: `${tile.bounds.height * 100}%`,
            '--tile-ink': COLOR_HEX[tile.color],
          } as React.CSSProperties}
          aria-label={tile.isJoker
            ? `Yıldız okey, ${tile.number ?? 'değeri henüz çıkarılamadı'}`
            : `${tile.number ?? 'Okunamayan'} ${COLOR_LABELS[tile.color]} taşını düzelt`}
        >
          <span className={tile.isJoker ? 'joker-reading' : ''}>
            {tile.isJoker && <small>★</small>}
            {tile.number ?? '?'}
          </span>
        </button>
      ))}
    </div>
  );
}

function PermissionCard({
  state,
  error,
  onRetry,
  onDemo,
  onPhoto,
}: {
  state: ReturnType<typeof useCamera>['state'];
  error: string | null;
  onRetry: () => void;
  onDemo: () => void;
  onPhoto: () => void;
}) {
  const requesting = state === 'requesting';
  return (
    <div className="permission-wrap">
      <div className="permission-card">
        <div className={`permission-icon ${requesting ? 'is-requesting' : ''}`}>
          {requesting ? <Camera size={28} /> : <CameraOff size={28} />}
          {requesting && <span className="permission-orbit" />}
        </div>
        <p className="eyebrow">KAMERA İLE HESAPLA</p>
        <h1>{requesting ? 'Kamera izni bekleniyor' : 'Istakayı görelim'}</h1>
        <p className="permission-copy">
          {requesting
            ? 'İzin verdiğinde arka kamera otomatik açılacak.'
            : error ?? 'Taşları okuyabilmek için kameraya erişim gerekiyor.'}
        </p>
        {!requesting && (
          <button className="primary-button" onClick={onRetry}>
            <Camera size={18} />
            Kamerayı aç
          </button>
        )}
        <button className="text-button" onClick={onDemo}>
          <Sparkles size={16} />
          Örnek elle dene
        </button>
        <button className="text-button photo-button" onClick={onPhoto}>
          <ImageUp size={16} />
          Fotoğraftan oku
        </button>
        <div className="privacy-note">
          <LockKeyhole size={14} />
          Görüntüler cihazından çıkmaz
        </div>
      </div>
    </div>
  );
}

function ScoreDock({
  tiles,
  scanPhase,
  frozen,
  isDemo,
  onToggleFreeze,
  onEdit,
}: {
  tiles: DetectedTile[];
  scanPhase: ScanPhase;
  frozen: boolean;
  isDemo: boolean;
  onToggleFreeze: () => void;
  onEdit: () => void;
}) {
  const result = useMemo(() => calculateScan(tiles), [tiles]);
  const invalidCount = result.melds.filter((meld) => !meld.isValid).length;
  const countedTiles = result.melds.filter((meld) => meld.isValid).flatMap((meld) => meld.tiles);
  const trusted = countedTiles.length >= 3
    && countedTiles.every((tile) => tile.number !== null && tile.confidence >= 0.56);
  const confirmedPass = result.passes101 && trusted;
  const possiblePass = result.passes101 && !trusted;
  const progress = Math.min(100, (result.total / 101) * 100);

  const phaseLabel = frozen
    ? 'Görüntü donduruldu'
    : scanPhase === 'loading'
      ? 'Okuma modeli hazırlanıyor'
      : scanPhase === 'reading'
        ? 'Taşlar okunuyor'
        : scanPhase === 'error'
          ? 'Okuma durdu'
          : scanPhase === 'ready'
            ? 'Canlı hesaplanıyor'
            : 'Istaka bekleniyor';

  return (
    <section className={`score-dock ${confirmedPass ? 'has-passed' : ''}`} aria-live="polite">
      <div className="dock-handle" />
      <div className="scan-status">
        <span className={`status-dot ${scanPhase === 'reading' && !frozen ? 'is-pulsing' : ''}`} />
        {isDemo ? 'Örnek görünüm' : phaseLabel}
      </div>

      <div className="score-row">
        <div>
          <p className="score-label">GEÇERLİ PER TOPLAMI</p>
          <div className="score-number">
            <strong>{result.total}</strong>
            <span>/101</span>
          </div>
        </div>
        <div className={`result-badge ${confirmedPass ? 'is-complete' : possiblePass ? 'needs-check' : ''}`}>
          {confirmedPass ? <Check size={18} strokeWidth={3} /> : <Focus size={18} />}
          <div>
            <strong>
              {confirmedPass
                ? '101 tamam'
                : possiblePass
                  ? 'Kontrol gerekli'
                  : `${result.remaining} sayı kaldı`}
            </strong>
            <span>
              {confirmedPass
                ? result.total === 101 ? 'Tam sınırda' : `+${result.total - 101} fazlası var`
                : invalidCount > 0 ? `${invalidCount} grup sayılmadı` : `${result.melds.length} per bulundu`}
            </span>
          </div>
        </div>
      </div>

      <div className="score-progress" aria-label={`101 hedefinin yüzde ${Math.round(progress)} kadarı`}>
        <span style={{ width: `${progress}%` }} />
        <i style={{ left: '100%' }}>101</i>
      </div>

      <div className="meld-chips">
        {result.melds.length ? result.melds.map((meld) => (
          <button key={meld.groupIndex} className={!meld.isValid ? 'is-invalid' : ''} onClick={onEdit}>
            <span>{meld.isValid ? `${meld.groupIndex + 1}. per` : `${meld.groupIndex + 1}. kontrol`}</span>
            <strong>{meld.sum}</strong>
          </button>
        )) : <p>Perleri boşluk bırakarak çerçeveye yerleştir.</p>}
      </div>

      <div className="dock-actions">
        <button className="secondary-button" onClick={onEdit} disabled={!tiles.length}>
          <Settings2 size={18} />
          Düzelt
        </button>
        <button className="scan-button" onClick={onToggleFreeze}>
          {frozen ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
          {frozen ? 'Taramaya devam' : 'Dondur'}
        </button>
      </div>
    </section>
  );
}

function TileEditor({
  tiles,
  selectedId,
  onSelect,
  onChange,
  onClose,
}: {
  tiles: DetectedTile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<Pick<DetectedTile, 'number' | 'color'>>) => void;
  onClose: () => void;
}) {
  const result = calculateScan(tiles);
  const selected = tiles.find((tile) => tile.id === selectedId) ?? tiles[0];

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="editor-sheet" role="dialog" aria-modal="true" aria-label="Algılanan taşları düzelt">
        <div className="sheet-head">
          <div>
            <p className="eyebrow">ELLE DÜZELT</p>
            <h2>Algılanan taşlar</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Kapat"><X size={20} /></button>
        </div>
        <p className="sheet-copy">Yanlış okunan taşa dokun, sonra sayı ve rengini seç.</p>

        <div className="editor-melds">
          {result.melds.map((meld) => (
            <div className={`editor-meld ${meld.isValid ? '' : 'is-invalid'}`} key={meld.groupIndex}>
              <div className="editor-meld-head">
                <span>{meld.groupIndex + 1}. PER</span>
                <strong>{meld.isValid ? meld.sum : 'Kontrol et'}</strong>
              </div>
              <div className="editor-tiles">
                {meld.tiles.map((tile) => (
                  <button
                    key={tile.id}
                    className={selected?.id === tile.id ? 'is-selected' : ''}
                    style={{ '--tile-ink': COLOR_HEX[tile.color] } as React.CSSProperties}
                    onClick={() => onSelect(tile.id)}
                  >
                    {tile.isJoker ? `★ ${tile.number ?? '?'}` : tile.number ?? '?'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {selected && (
          <div className="tile-controls">
            <div className="control-heading">
              <span>TAŞIN SAYISI</span>
              <strong style={{ color: COLOR_HEX[selected.color] }}>{selected.number ?? '?'}</strong>
            </div>
            <div className="number-grid">
              {Array.from({ length: 13 }, (_, index) => index + 1).map((number) => (
                <button
                  key={number}
                  className={selected.number === number ? 'is-selected' : ''}
                  onClick={() => onChange({ number })}
                >
                  {number}
                </button>
              ))}
            </div>
            <div className="color-row" aria-label="Taş rengi">
              {TILE_COLORS.map((color) => (
                <button
                  key={color}
                  className={selected.color === color ? 'is-selected' : ''}
                  onClick={() => onChange({ color })}
                >
                  <i style={{ background: COLOR_HEX[color] }} />
                  {COLOR_LABELS[color]}
                </button>
              ))}
            </div>
          </div>
        )}

        <button className="primary-button editor-done" onClick={onClose}>
          <Check size={18} />
          Hesabı güncelle
        </button>
      </section>
    </div>
  );
}

function InfoSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="info-sheet" role="dialog" aria-modal="true" aria-label="Nasıl kullanılır">
        <div className="sheet-head">
          <div>
            <p className="eyebrow">HIZLI BAŞLANGIÇ</p>
            <h2>Üç küçük hareket</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Kapat"><X size={20} /></button>
        </div>
        <ol className="steps-list">
          <li><span>01</span><div><strong>Istakayı hizala</strong><p>Taşları iki sıra halinde kesikli çerçevenin içinde tut.</p></div></li>
          <li><span>02</span><div><strong>Perlere boşluk bırak</strong><p>Uygulama per sınırlarını taşların arasındaki boşluktan anlar.</p></div></li>
          <li><span>03</span><div><strong>Sarı kutuyu düzelt</strong><p>Belirsiz okunan bir taşa dokunup sayı ve rengini seç.</p></div></li>
        </ol>
        <div className="local-callout"><LockKeyhole size={17} /><p><strong>Tamamen cihazında.</strong> Kamera kareleri kaydedilmez veya yüklenmez.</p></div>
        <button className="primary-button editor-done" onClick={onClose}>Anladım</button>
      </section>
    </div>
  );
}

export default function App() {
  const query = new URLSearchParams(window.location.search);
  const syntheticOcrTest = query.get('ocrtest') === '1';
  const initialDemo = query.get('demo') === '1' || syntheticOcrTest;
  const [isDemo, setIsDemo] = useState(initialDemo);
  const [photo, setPhoto] = useState<PhotoSource | null>(null);
  const camera = useCamera(isDemo || Boolean(photo));
  const [tiles, setTiles] = useState<DetectedTile[]>(initialDemo && !syntheticOcrTest ? createDemoTiles() : []);
  const [scanPhase, setScanPhase] = useState<ScanPhase>(initialDemo ? 'ready' : 'waiting');
  const [frozen, setFrozen] = useState(initialDemo);
  const [quality, setQuality] = useState<FrameQuality | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const hasLoadedModel = useRef(false);
  const hasRunSyntheticTest = useRef(false);

  useEffect(() => () => {
    void disposeRecognitionWorker();
  }, []);

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);

  useEffect(() => {
    if (!syntheticOcrTest || hasRunSyntheticTest.current) return;
    hasRunSyntheticTest.current = true;
    setScanPhase('loading');
    void recognizeRack(createSyntheticRackCanvas())
      .then((recognition) => {
        setTiles(recognition.tiles);
        setQuality(recognition.quality);
        setScanPhase('ready');
      })
      .catch((error) => {
        console.error(error);
        setScanPhase('error');
      });
  }, [syntheticOcrTest]);

  useEffect(() => {
    if (isDemo || camera.state !== 'live' || frozen) return;
    let cancelled = false;
    let timeout: number | undefined;

    const scan = async () => {
      const video = camera.videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        timeout = window.setTimeout(scan, 500);
        return;
      }

      try {
        setScanPhase(hasLoadedModel.current ? 'reading' : 'loading');
        const frame = captureVisibleVideo(video);
        const recognition = await recognizeRack(frame, () => {
          if (!hasLoadedModel.current) setScanPhase('loading');
        });
        if (cancelled) return;
        hasLoadedModel.current = true;
        setQuality(recognition.quality);
        if (recognition.tiles.length >= 3) {
          setTiles((current) => stabilizeTiles(current, recognition.tiles));
        } else if (!tiles.length) {
          setTiles([]);
        }
        setScanPhase('ready');
      } catch (error) {
        if (!cancelled) {
          console.error(error);
          setScanPhase('error');
        }
      }
      if (!cancelled) timeout = window.setTimeout(scan, 1800);
    };

    timeout = window.setTimeout(scan, 650);
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [camera.state, camera.videoRef, frozen, isDemo, tiles.length]);

  const openEditor = (tileId?: string) => {
    setFrozen(true);
    setSelectedTileId(tileId ?? tiles[0]?.id ?? null);
    setEditorOpen(true);
  };

  const updateSelectedTile = (patch: Partial<Pick<DetectedTile, 'number' | 'color'>>) => {
    if (!selectedTileId) return;
    setTiles((current) => current.map((tile) => tile.id === selectedTileId
      ? { ...tile, ...patch, confidence: 1, edited: true }
      : tile));
  };

  const enterDemo = () => {
    camera.stop();
    setIsDemo(true);
    setTiles(createDemoTiles());
    setFrozen(true);
    setScanPhase('ready');
    setQuality(null);
  };

  const choosePhoto = () => photoInputRef.current?.click();

  const readPhoto = async (file: File) => {
    setPhotoError(null);
    setScanPhase('loading');
    setTiles([]);
    setFrozen(true);
    camera.stop();
    try {
      const loaded = await loadPhoto(file);
      if (photo) URL.revokeObjectURL(photo.url);
      const stageWidth = stageRef.current?.clientWidth ?? 480;
      const stageHeight = stageRef.current?.clientHeight ?? 900;
      const fitted = { ...loaded, canvas: fitPhotoToStage(loaded.canvas, stageWidth / stageHeight) };
      setPhoto(fitted);
      const recognition = await recognizeRack(fitted.canvas, (progress) => {
        if (progress > 0) setScanPhase('reading');
      });
      setTiles(recognition.tiles);
      setQuality(recognition.quality);
      setScanPhase('ready');
    } catch (error) {
      console.error(error);
      setPhotoError('Fotoğraf okunamadı. HEIC, JPEG veya PNG ile yeniden dene.');
      setScanPhase('error');
    }
  };

  const exitPhoto = () => {
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setPhotoError(null);
    setTiles([]);
    setQuality(null);
    setFrozen(false);
    setScanPhase('waiting');
  };

  const exitDemo = () => {
    setIsDemo(false);
    setTiles([]);
    setFrozen(false);
    setScanPhase('waiting');
  };

  const showCamera = isDemo || Boolean(photo) || camera.state === 'live';
  const scanHint = quality?.message
    ?? (tiles.length ? `${tiles.length} taş · ${calculateScan(tiles).melds.length} per` : 'Istakayı kesikli alana yaklaştır');
  const displayResult = calculateScan(tiles);

  return (
    <main className="page-shell">
      <div className="app-frame">
        <input
          ref={photoInputRef}
          className="photo-input"
          type="file"
          accept="image/*,.heic,.heif"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readPhoto(file);
            event.currentTarget.value = '';
          }}
        />
        <section ref={stageRef} className={`camera-stage ${isDemo ? 'is-demo' : ''}`}>
          {!isDemo && !photo && (
            <video ref={camera.videoRef} autoPlay muted playsInline aria-label="Canlı arka kamera görüntüsü" />
          )}
          {photo && <img className="photo-frame" src={photo.url} alt="Taranan 101 Okey ıstakası" />}
          {isDemo && (
            <div className="demo-scene" aria-label="Örnek 101 Okey ıstakası">
              <div className="table-mark table-mark-one">101</div>
              <div className="table-mark table-mark-two">OYUN</div>
              <div className="rack-shadow" />
              <div className="rack-ledge" />
              {tiles.map((tile) => <TileScene tile={tile} key={`scene-${tile.id}`} />)}
            </div>
          )}

          <div className="camera-vignette" />
          <header className="top-hud">
            <div className="wordmark">
              <span>YÜZ</span><strong>BİR</strong>
            </div>
            <div className="hud-actions">
              {(isDemo || photo) && (
                <button className="demo-exit" onClick={photo ? exitPhoto : exitDemo}>
                  <Camera size={14} /> Kamera
                </button>
              )}
              {!isDemo && (
                <button className="icon-button glass" onClick={choosePhoto} aria-label="Fotoğraftan oku">
                  <ImageUp size={18} />
                </button>
              )}
              <button className="icon-button glass" onClick={() => setInfoOpen(true)} aria-label="Nasıl kullanılır">
                <CircleHelp size={19} />
              </button>
            </div>
          </header>

          {showCamera && (
            <>
              <div className="rack-guide" aria-hidden="true">
                <span className="corner top-left" /><span className="corner top-right" />
                <span className="corner bottom-left" /><span className="corner bottom-right" />
                <div className="guide-label"><ScanLine size={14} /> ISTAKA ALANI</div>
                <div className="row-guide first" /><div className="row-guide second" />
              </div>
              <div className="camera-hint"><span>{scanHint}</span></div>
              <CameraOverlay tiles={displayResult.tiles} melds={displayResult.melds} onEdit={openEditor} />
              {!frozen && <div className="scan-beam" />}
            </>
          )}

          {!showCamera && (
            <PermissionCard
              state={camera.state}
              error={photoError ?? camera.error}
              onRetry={() => void camera.start()}
              onDemo={enterDemo}
              onPhoto={choosePhoto}
            />
          )}

          {showCamera && (
            <ScoreDock
              tiles={tiles}
              scanPhase={scanPhase}
              frozen={frozen}
              isDemo={isDemo}
              onToggleFreeze={() => setFrozen((current) => !current)}
              onEdit={() => openEditor()}
            />
          )}
        </section>

        <div className="desktop-note">
          <div><RefreshCw size={16} /><span>En iyi sonuç için telefonu dik tut</span></div>
        </div>

        {editorOpen && (
          <TileEditor
            tiles={tiles}
            selectedId={selectedTileId}
            onSelect={setSelectedTileId}
            onChange={updateSelectedTile}
            onClose={() => setEditorOpen(false)}
          />
        )}
        {infoOpen && <InfoSheet onClose={() => setInfoOpen(false)} />}
      </div>
    </main>
  );
}
