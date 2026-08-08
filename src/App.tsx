import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CameraOff,
  Check,
  CircleHelp,
  Focus,
  GripVertical,
  ImageUp,
  LockKeyhole,
  Pause,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  createDemoTiles,
  TILE_COLORS,
  type DetectedTile,
  type TileColor,
} from './domain';
import {
  isEffectiveJoker,
  MAX_RACK_TILES,
  optimizeRack,
  type OkeySelection,
  type RackPlan,
  type RackTile,
  type TilePlacement,
} from './optimizer';
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

const COLOR_LABELS: Record<TileColor, string> = {
  red: 'Kırmızı',
  blue: 'Mavi',
  black: 'Siyah',
  yellow: 'Sarı',
};

const COLOR_SHORT_LABELS: Record<TileColor, string> = {
  red: 'K',
  blue: 'M',
  black: 'Si',
  yellow: 'Sa',
};

const COLOR_HEX: Record<TileColor, string> = {
  red: '#e94b48',
  blue: '#3e8ef7',
  black: '#23272a',
  yellow: '#e3a72f',
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

function createRackId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `rack-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function detectionToRackTile(tile: DetectedTile, source: RackTile['source'] = 'scan'): RackTile {
  return {
    id: createRackId(),
    number: tile.isJoker ? null : tile.number,
    color: tile.color,
    kind: tile.isJoker ? 'star' : 'number',
    confidence: tile.confidence,
    source,
    edited: false,
  };
}

function rackFromDetections(tiles: DetectedTile[], source: RackTile['source'] = 'scan') {
  const selectedIndices = tiles
    .map((tile, index) => ({ index, confidence: tile.confidence }))
    .sort((left, right) => right.confidence - left.confidence || left.index - right.index)
    .slice(0, MAX_RACK_TILES)
    .map(({ index }) => index)
    .sort((left, right) => left - right);
  return selectedIndices.map((index) => detectionToRackTile(tiles[index], source));
}

function reconcileRack(previous: RackTile[], detections: DetectedTile[]) {
  const incoming = rackFromDetections(detections);
  const unusedPrevious = new Set(previous.map((tile) => tile.id));

  return incoming.map((tile, index) => {
    const exact = previous
      .map((candidate, previousIndex) => ({ candidate, previousIndex }))
      .filter(({ candidate }) => unusedPrevious.has(candidate.id))
      .filter(({ candidate }) => candidate.kind === tile.kind
        && candidate.number === tile.number
        && candidate.color === tile.color)
      .sort((left, right) => Math.abs(left.previousIndex - index) - Math.abs(right.previousIndex - index))[0]
      ?.candidate;
    const positional = previous[index] && unusedPrevious.has(previous[index].id)
      ? previous[index]
      : previous.find((candidate) => unusedPrevious.has(candidate.id));
    const match = exact ?? positional;
    if (!match) return tile;
    unusedPrevious.delete(match.id);
    return { ...tile, id: match.id };
  });
}

function isPrintedOkey(tile: RackTile, okey: OkeySelection | null) {
  return tile.kind === 'number'
    && Boolean(okey && tile.number === okey.number && tile.color === okey.color);
}

function useDialogFocus(onDismiss: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;
    const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusInitial = window.requestAnimationFrame(() => {
      const selected = dialog.querySelector<HTMLElement>('button.is-selected');
      const first = dialog.querySelector<HTMLElement>(focusableSelector);
      (selected ?? first ?? dialog).focus();
    });

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', handleKey);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      dialog.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, []);

  return dialogRef;
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
  const requesting = state === 'requesting' && !error;
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

function OkeyPicker({
  initial,
  onConfirm,
  onSkip,
}: {
  initial: OkeySelection | null;
  onConfirm: (okey: OkeySelection) => void;
  onSkip: () => void;
}) {
  const [number, setNumber] = useState(initial?.number ?? 3);
  const [color, setColor] = useState<TileColor>(initial?.color ?? 'blue');
  const dialogRef = useDialogFocus(onSkip);

  return (
    <div className="sheet-backdrop okey-backdrop">
      <section ref={dialogRef} className="okey-sheet" role="dialog" aria-modal="true" aria-labelledby="okey-title" tabIndex={-1}>
        <div className="sheet-head">
          <div>
            <p className="eyebrow">BU ELİN JOKERİ</p>
            <h2 id="okey-title">Okey hangisi?</h2>
          </div>
          <div className="okey-preview" style={{ '--tile-ink': COLOR_HEX[color] } as CSSProperties}>
            <strong>{number}</strong>
            <i />
          </div>
        </div>
        <p className="sheet-copy">
          Seçtiğin taş joker olur. Örneğin Mavi 3, her per içinde eksik olan herhangi bir taşın yerine geçebilir; ★ yıldız taşı da joker kalır.
        </p>

        <div className="control-heading"><span>OKEYİN RENGİ</span><strong>{COLOR_LABELS[color]}</strong></div>
        <div className="color-row okey-colors" aria-label="Okey rengi">
          {TILE_COLORS.map((option) => (
            <button
              key={option}
              className={color === option ? 'is-selected' : ''}
              onClick={() => setColor(option)}
              aria-pressed={color === option}
            >
              <i style={{ background: COLOR_HEX[option] }} />
              {COLOR_LABELS[option]}
            </button>
          ))}
        </div>

        <div className="control-heading okey-number-heading"><span>OKEYİN SAYISI</span><strong>{number}</strong></div>
        <div className="number-grid">
          {Array.from({ length: 13 }, (_, index) => index + 1).map((option) => (
            <button
              key={option}
              className={number === option ? 'is-selected' : ''}
              onClick={() => setNumber(option)}
              aria-pressed={number === option}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="okey-actions">
          <button className="text-button okey-skip" onClick={onSkip}>Bu elde okey seçmeden devam et</button>
          <button className="primary-button" onClick={() => onConfirm({ number, color })}>
            <Check size={18} />
            {COLOR_LABELS[color]} {number} okey
          </button>
        </div>
      </section>
    </div>
  );
}

type DragState = {
  tileId: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
};

function VirtualRack({
  tiles,
  plan,
  okey,
  applied,
  canUndo,
  onChooseOkey,
  onEdit,
  onAdd,
  onApply,
  onUndo,
  onReorder,
  onMove,
  onClaim,
  locked,
}: {
  tiles: RackTile[];
  plan: RackPlan;
  okey: OkeySelection | null;
  applied: boolean;
  canUndo: boolean;
  onChooseOkey: () => void;
  onEdit: (tileId: string) => void;
  onAdd: () => void;
  onApply: () => void;
  onUndo: () => void;
  onReorder: (tileIds: string[], movedTileId: string) => void;
  onMove: (tileId: string, targetIndex: number) => void;
  onClaim: () => void;
  locked: boolean;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const suppressClickRef = useRef(false);

  const placementById = useMemo(() => {
    const placements = new Map<string, TilePlacement>();
    plan.melds.forEach((meld) => meld.placements.forEach((placement) => placements.set(placement.tileId, placement)));
    return placements;
  }, [plan]);
  const groupById = useMemo(() => {
    const groups = new Map<string, { index: number; score: number; first: boolean }>();
    plan.melds.forEach((meld, index) => meld.placements.forEach((placement, placementIndex) => {
      groups.set(placement.tileId, { index, score: meld.score, first: placementIndex === 0 });
    }));
    return groups;
  }, [plan]);
  const leftoverIds = useMemo(() => new Set(plan.leftoverIds), [plan.leftoverIds]);
  const tileById = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles]);
  const displayedTiles = (dragOrder ?? tiles.map((tile) => tile.id))
    .map((id) => tileById.get(id))
    .filter((tile): tile is RackTile => Boolean(tile));

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, tileId: string) => {
    if (event.button !== 0 || locked) return;
    onClaim();
    dragRef.current = {
      tileId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    const order = tiles.map((tile) => tile.id);
    dragOrderRef.current = order;
    setDragOrder(order);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
    drag.moved = true;
    setDraggingId(drag.tileId);
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-rack-tile-id]');
    const targetId = target?.dataset.rackTileId;
    const order = dragOrderRef.current;
    if (!targetId || !order || targetId === drag.tileId) return;
    const from = order.indexOf(drag.tileId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...order];
    next.splice(to, 0, next.splice(from, 1)[0]);
    dragOrderRef.current = next;
    setDragOrder(next);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved && dragOrderRef.current) {
      suppressClickRef.current = true;
      onReorder(dragOrderRef.current, drag.tileId);
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    dragRef.current = null;
    dragOrderRef.current = null;
    setDragOrder(null);
    setDraggingId(null);
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    dragOrderRef.current = null;
    setDragOrder(null);
    setDraggingId(null);
  };

  const handleTileKey = (event: ReactKeyboardEvent<HTMLButtonElement>, tileId: string, index: number) => {
    if (!event.altKey) return;
    const deltas: Partial<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -12,
      ArrowDown: 12,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    onMove(tileId, Math.max(0, Math.min(tiles.length - 1, index + delta)));
  };

  return (
    <section className={`virtual-rack ${locked ? 'is-locked' : ''}`} aria-label="Sanal ıstaka" aria-busy={locked}>
      <header className="virtual-rack-head">
        <div className="rack-heading">
          <span>SANAL ISTAKA</span>
          <strong>{tiles.length} taş</strong>
        </div>
        <button className={`okey-pill ${okey ? '' : 'is-empty'}`} onClick={onChooseOkey}>
          <span>OKEY</span>
          <strong>{okey ? `${COLOR_LABELS[okey.color]} ${okey.number}` : 'Seç'}</strong>
          {okey && <i style={{ background: COLOR_HEX[okey.color] }} />}
        </button>
      </header>

      <div className="suggestion-strip">
        <div>
          <Sparkles size={14} />
          <span>EN İYİ DİZİLİM</span>
          <strong>{plan.usedCount}/{tiles.length}</strong>
          <small>{plan.leftoverIds.length} taş dışarıda</small>
        </div>
        <button
          className={applied ? 'is-applied' : ''}
          onClick={applied && canUndo ? onUndo : onApply}
          disabled={locked || !plan.melds.length}
        >
          {applied && canUndo ? 'Geri al' : applied ? 'Uygulandı' : 'Uygula'}
        </button>
      </div>

      <div className="rack-board">
        <div className="rack-rail rack-rail-top" />
        <div className="rack-rail rack-rail-bottom" />
        <div className="rack-grid">
          {displayedTiles.map((tile, index) => {
            const placement = placementById.get(tile.id);
            const group = groupById.get(tile.id);
            const printedOkey = isPrintedOkey(tile, okey);
            const wildcard = isEffectiveJoker(tile, okey);
            const label = tile.kind === 'star'
              ? 'Yıldız joker'
              : `${COLOR_LABELS[tile.color]} ${tile.number}${printedOkey ? ', okey' : ''}`;
            const assignment = applied && wildcard && placement
              ? `, ${COLOR_LABELS[placement.represents.color]} ${placement.represents.number} yerine`
              : '';
            return (
              <button
                className={[
                  'rack-tile',
                  tile.kind === 'star' ? 'is-star' : '',
                  printedOkey ? 'is-okey' : '',
                  tile.confidence < 0.56 ? 'is-uncertain' : '',
                  draggingId === tile.id ? 'is-dragging' : '',
                  applied && leftoverIds.has(tile.id) ? 'is-leftover' : '',
                  applied && group ? 'is-in-meld' : '',
                  applied && group?.first ? 'starts-meld' : '',
                ].filter(Boolean).join(' ')}
                key={tile.id}
                data-rack-tile-id={tile.id}
                disabled={locked}
                style={{ '--tile-ink': COLOR_HEX[tile.color] } as CSSProperties}
                onPointerDown={(event) => beginDrag(event, tile.id)}
                onPointerMove={moveDrag}
                onPointerUp={finishDrag}
                onPointerCancel={cancelDrag}
                onClick={() => {
                  if (!suppressClickRef.current) onEdit(tile.id);
                }}
                onKeyDown={(event) => handleTileKey(event, tile.id, index)}
                aria-label={`${label}${assignment}. Düzenlemek için dokun; Alt ve ok tuşlarıyla taşı.`}
                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
              >
                {applied && group?.first && <span className="meld-tag">{group.index + 1}. PER · {group.score}</span>}
                <GripVertical className="rack-grip" size={10} aria-hidden="true" />
                <strong>{tile.kind === 'star' ? '★' : tile.number}</strong>
                {tile.kind === 'number' && <i className="tile-pip" />}
                {printedOkey && <em className="okey-mark">OKEY</em>}
                {applied && wildcard && placement && (
                  <small className="wildcard-assignment">
                    → <i style={{ background: COLOR_HEX[placement.represents.color] }} />
                    {COLOR_SHORT_LABELS[placement.represents.color]}{placement.represents.number}
                  </small>
                )}
              </button>
            );
          })}
          <button
            className="rack-add-tile"
            onClick={onAdd}
            disabled={locked || tiles.length >= MAX_RACK_TILES}
            aria-label={tiles.length >= MAX_RACK_TILES ? 'Istaka 22 taşla dolu' : 'Eksik taş ekle'}
          >
            <Plus size={18} />
            <span>EKLE</span>
          </button>
        </div>
      </div>

      <footer className="rack-help">
        <span>Taşı sürükle; düzeltmek için dokun</span>
        {applied && <strong>Yeşil kenar: per · Turuncu: dışarıda</strong>}
      </footer>
      {locked && (
        <div className="rack-loading" aria-hidden="true">
          <RefreshCw size={14} /> Taşlar okunuyor
        </div>
      )}
    </section>
  );
}

function ScoreDock({
  tiles,
  plan,
  scanPhase,
  frozen,
  isDemo,
  onScanAction,
  onEdit,
  onApply,
  busy,
  applied,
}: {
  tiles: RackTile[];
  plan: RackPlan;
  scanPhase: ScanPhase;
  frozen: boolean;
  isDemo: boolean;
  onScanAction: () => void;
  onEdit: () => void;
  onApply: () => void;
  busy: boolean;
  applied: boolean;
}) {
  const usedIds = new Set(plan.melds.flatMap((meld) => meld.placements.map((placement) => placement.tileId)));
  const uncertainCount = tiles.filter((tile) => usedIds.has(tile.id) && tile.confidence < 0.56).length;
  const confirmedPass = plan.passes101 && uncertainCount === 0;
  const possiblePass = plan.passes101 && uncertainCount > 0;
  const progress = Math.min(100, (plan.total / 101) * 100);
  const remaining = Math.max(0, 101 - plan.total);

  const phaseLabel = scanPhase === 'loading'
      ? 'Okuma modeli hazırlanıyor'
      : scanPhase === 'reading'
        ? 'Taşlar sanal ıstakaya alınıyor'
        : scanPhase === 'error'
          ? 'Okuma durdu'
          : frozen
            ? 'Sanal ıstaka sende'
          : scanPhase === 'ready'
            ? 'Canlı taşlar güncelleniyor'
            : 'Istaka bekleniyor';

  return (
    <section className={`score-dock ${confirmedPass ? 'has-passed' : ''}`}>
      <div className="dock-handle" />
      <div className="scan-status">
        <span className={`status-dot ${scanPhase === 'reading' && (!frozen || busy) ? 'is-pulsing' : ''}`} />
        {isDemo ? 'Örnek görünüm' : phaseLabel}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {`${isDemo ? 'Örnek görünüm' : phaseLabel}. En iyi per toplamı ${plan.total}. ${plan.leftoverIds.length} taş per dışında.`}
      </div>

      <div className="score-row">
        <div>
          <p className="score-label">EN İYİ PER TOPLAMI</p>
          <div className="score-number">
            <strong>{plan.total}</strong>
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
                  ? 'Taşları kontrol et'
                  : `${remaining} sayı kaldı`}
            </strong>
            <span>{plan.leftoverIds.length} taş per dışında</span>
          </div>
        </div>
      </div>

      <div className="score-progress" aria-label={`101 hedefinin yüzde ${Math.round(progress)} kadarı`}>
        <span style={{ width: `${progress}%` }} />
        <i style={{ left: '100%' }}>101</i>
      </div>

      <div className="meld-chips">
        {plan.melds.length ? plan.melds.map((meld, index) => (
          <button key={meld.id} onClick={onApply} disabled={busy || applied}>
            <span>{index + 1}. {meld.kind === 'run' ? 'seri' : 'set'}</span>
            <strong>{meld.score}</strong>
          </button>
        )) : <p>Üç veya daha fazla uygun taşı algılayınca per önereceğim.</p>}
      </div>

      <div className="dock-actions">
        <button className="secondary-button" onClick={onEdit} disabled={busy || !tiles.length}>
          <Settings2 size={18} />
          Düzelt
        </button>
        <button className="scan-button" onClick={onScanAction} disabled={busy}>
          {frozen ? <RotateCcw size={18} /> : <Pause size={18} fill="currentColor" />}
          {frozen ? 'Yeniden tara' : 'Taşları al'}
        </button>
      </div>
    </section>
  );
}

function TileEditor({
  tile,
  index,
  count,
  onChange,
  onDelete,
  onMove,
  onClose,
}: {
  tile: RackTile;
  index: number;
  count: number;
  onChange: (patch: Partial<Pick<RackTile, 'number' | 'color' | 'kind'>>) => void;
  onDelete: () => void;
  onMove: (targetIndex: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section ref={dialogRef} className="editor-sheet tile-editor-sheet" role="dialog" aria-modal="true" aria-label="Taşı düzelt" tabIndex={-1}>
        <div className="sheet-head">
          <div>
            <p className="eyebrow">SANAL ISTAKA</p>
            <h2>Taşı düzelt</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Kapat"><X size={20} /></button>
        </div>
        <p className="sheet-copy">Sayıyı, rengi veya yıldız taşını düzelt. Yanlış algılandıysa silebilirsin.</p>

        <div className="tile-kind-row">
          <button
            className={tile.kind === 'number' ? 'is-selected' : ''}
            onClick={() => onChange({ kind: 'number', number: tile.number ?? 1 })}
            aria-pressed={tile.kind === 'number'}
          >
            1–13 numaralı
          </button>
          <button
            className={tile.kind === 'star' ? 'is-selected' : ''}
            onClick={() => onChange({ kind: 'star', number: null })}
            aria-pressed={tile.kind === 'star'}
          >
            ★ Yıldız
          </button>
        </div>

        {tile.kind === 'number' && (
          <div className="tile-controls editor-tile-controls">
            <div className="control-heading">
              <span>TAŞIN SAYISI</span>
              <strong style={{ color: COLOR_HEX[tile.color] }}>{tile.number ?? '?'}</strong>
            </div>
            <div className="number-grid">
              {Array.from({ length: 13 }, (_, numberIndex) => numberIndex + 1).map((number) => (
                <button
                  key={number}
                  className={tile.number === number ? 'is-selected' : ''}
                  onClick={() => onChange({ number })}
                  aria-pressed={tile.number === number}
                >
                  {number}
                </button>
              ))}
            </div>
            <div className="color-row" aria-label="Taş rengi">
              {TILE_COLORS.map((color) => (
                <button
                  key={color}
                  className={tile.color === color ? 'is-selected' : ''}
                  onClick={() => onChange({ color })}
                  aria-pressed={tile.color === color}
                >
                  <i style={{ background: COLOR_HEX[color] }} />
                  {COLOR_LABELS[color]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="editor-position-actions">
          <button onClick={() => onMove(index - 1)} disabled={index <= 0}>
            <ArrowLeft size={16} /> Sola al
          </button>
          <button onClick={() => onMove(index + 1)} disabled={index >= count - 1}>
            Sağa al <ArrowRight size={16} />
          </button>
        </div>

        <button className="delete-tile-button" onClick={onDelete}>
          <Trash2 size={17} />
          Yanlış algılanan taşı sil
        </button>
        <button className="primary-button editor-done" onClick={onClose}>
          <Check size={18} />
          Bitti
        </button>
      </section>
    </div>
  );
}

function InfoSheet({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section ref={dialogRef} className="info-sheet" role="dialog" aria-modal="true" aria-label="Nasıl kullanılır" tabIndex={-1}>
        <div className="sheet-head">
          <div>
            <p className="eyebrow">HIZLI BAŞLANGIÇ</p>
            <h2>Istaka senin elinde</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Kapat"><X size={20} /></button>
        </div>
        <ol className="steps-list">
          <li><span>01</span><div><strong>Okeyi seç</strong><p>Seçilen renk ve sayı bu elde her taşın yerine geçebilen joker olur.</p></div></li>
          <li><span>02</span><div><strong>Sanal ıstakayı düzelt</strong><p>Taşları sürükle, dokunarak düzelt, eksik taşı ekle veya fazlalığı sil.</p></div></li>
          <li><span>03</span><div><strong>En iyi dizilimi uygula</strong><p>Uygulama en az taşı dışarıda bırakan geçerli perleri bulup ıstakaya dizer.</p></div></li>
        </ol>
        <div className="local-callout"><LockKeyhole size={17} /><p><strong>Tamamen cihazında.</strong> Kamera kareleri ve elin hiçbir yere yüklenmez.</p></div>
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
  const [rackTiles, setRackTiles] = useState<RackTile[]>(() => initialDemo && !syntheticOcrTest
    ? rackFromDetections(createDemoTiles(), 'manual')
    : []);
  const [scanPhase, setScanPhase] = useState<ScanPhase>(initialDemo ? 'ready' : 'waiting');
  const [frozen, setFrozen] = useState(initialDemo);
  const [rackDirty, setRackDirty] = useState(initialDemo);
  const [quality, setQuality] = useState<FrameQuality | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [okey, setOkey] = useState<OkeySelection | null>(null);
  const [okeyOpen, setOkeyOpen] = useState(false);
  const [okeyPrompted, setOkeyPrompted] = useState(false);
  const [planApplied, setPlanApplied] = useState(false);
  const [undoOrder, setUndoOrder] = useState<string[] | null>(null);
  const [rackAnnouncement, setRackAnnouncement] = useState('');
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<PhotoSource | null>(null);
  const photoScanId = useRef(0);
  const rackDirtyRef = useRef(initialDemo);
  const rackMutationVersion = useRef(0);
  const hasLoadedModel = useRef(false);
  const hasRunSyntheticTest = useRef(false);

  const plan = useMemo(() => optimizeRack(rackTiles, okey), [rackTiles, okey]);
  const selectedTile = rackTiles.find((tile) => tile.id === selectedTileId) ?? null;
  const selectedIndex = selectedTile ? rackTiles.findIndex((tile) => tile.id === selectedTile.id) : -1;
  const showCamera = isDemo || Boolean(photo) || camera.state === 'live';

  useEffect(() => () => {
    void disposeRecognitionWorker();
  }, []);

  useEffect(() => {
    photoRef.current = photo;
  }, [photo]);

  useEffect(() => () => {
    photoScanId.current += 1;
    if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
  }, []);

  useEffect(() => {
    if (showCamera && !okeyPrompted && !infoOpen && !editorOpen && !okeyOpen) {
      setOkeyOpen(true);
    }
  }, [editorOpen, infoOpen, okeyOpen, okeyPrompted, showCamera]);

  useEffect(() => {
    if (!syntheticOcrTest || hasRunSyntheticTest.current) return;
    hasRunSyntheticTest.current = true;
    setScanPhase('loading');
    void recognizeRack(createSyntheticRackCanvas())
      .then((recognition) => {
        setRackTiles(rackFromDetections(recognition.tiles));
        setQuality(recognition.quality);
        setFrozen(true);
        rackDirtyRef.current = true;
        setRackDirty(true);
        setScanPhase('ready');
      })
      .catch((error) => {
        console.error(error);
        setScanPhase('error');
      });
  }, [syntheticOcrTest]);

  useEffect(() => {
    if (isDemo || photo || camera.state !== 'live' || frozen || rackDirtyRef.current) return;
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
        if (cancelled || rackDirtyRef.current) return;
        hasLoadedModel.current = true;
        setPhotoError(null);
        setQuality(recognition.quality);
        if (recognition.tiles.length >= 3) {
          setRackTiles((current) => reconcileRack(current, recognition.tiles));
          setPlanApplied(false);
          setUndoOrder(null);
        } else {
          setRackTiles((current) => current.length ? current : []);
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
  }, [camera.state, camera.videoRef, frozen, isDemo, photo]);

  const claimRack = () => {
    rackMutationVersion.current += 1;
    rackDirtyRef.current = true;
    setRackDirty(true);
    setFrozen(true);
    setScanPhase('ready');
  };

  const updateRack = (updater: (current: RackTile[]) => RackTile[]) => {
    claimRack();
    setPlanApplied(false);
    setUndoOrder(null);
    setRackTiles(updater);
  };

  const openEditor = (tileId?: string) => {
    if (!rackTiles.length) return;
    claimRack();
    setSelectedTileId(tileId ?? rackTiles[0].id);
    setEditorOpen(true);
  };

  const updateSelectedTile = (patch: Partial<Pick<RackTile, 'number' | 'color' | 'kind'>>) => {
    if (!selectedTileId) return;
    updateRack((current) => current.map((tile) => tile.id === selectedTileId
      ? {
          ...tile,
          ...patch,
          number: patch.kind === 'star' ? null : patch.number ?? tile.number,
          confidence: 1,
          source: tile.source,
          edited: true,
        }
      : tile));
  };

  const addTile = () => {
    if (rackTiles.length >= MAX_RACK_TILES) return;
    const tile: RackTile = {
      id: createRackId(),
      number: 1,
      color: 'red',
      kind: 'number',
      confidence: 1,
      source: 'manual',
      edited: true,
    };
    updateRack((current) => [...current, tile]);
    setSelectedTileId(tile.id);
    setEditorOpen(true);
  };

  const deleteSelectedTile = () => {
    if (!selectedTileId) return;
    updateRack((current) => current.filter((tile) => tile.id !== selectedTileId));
    setEditorOpen(false);
    setSelectedTileId(null);
  };

  const moveTileTo = (tileId: string, targetIndex: number) => {
    const destination = Math.max(0, Math.min(rackTiles.length - 1, targetIndex));
    updateRack((current) => {
      const from = current.findIndex((tile) => tile.id === tileId);
      if (from < 0) return current;
      const to = Math.max(0, Math.min(current.length - 1, targetIndex));
      if (from === to) return current;
      const next = [...current];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
    setRackAnnouncement(`Taş sanal ıstakada ${destination + 1}. konuma taşındı.`);
  };

  const reorderRack = (tileIds: string[], movedTileId: string) => {
    updateRack((current) => {
      const byId = new Map(current.map((tile) => [tile.id, tile]));
      const ordered = tileIds.map((id) => byId.get(id)).filter((tile): tile is RackTile => Boolean(tile));
      return ordered.length === current.length ? ordered : current;
    });
    setRackAnnouncement(`Taş sanal ıstakada ${tileIds.indexOf(movedTileId) + 1}. konuma taşındı.`);
  };

  const applyBestPlan = () => {
    if (planApplied || !plan.melds.length) return;
    claimRack();
    setUndoOrder(rackTiles.map((tile) => tile.id));
    const plannedIds = plan.melds.flatMap((meld) => meld.placements.map((placement) => placement.tileId));
    const plannedSet = new Set(plannedIds);
    const orderedIds = [...plannedIds, ...rackTiles.filter((tile) => !plannedSet.has(tile.id)).map((tile) => tile.id)];
    const byId = new Map(rackTiles.map((tile) => [tile.id, tile]));
    setRackTiles(orderedIds.map((id) => byId.get(id)).filter((tile): tile is RackTile => Boolean(tile)));
    setPlanApplied(true);
    setRackAnnouncement(`${plan.melds.length} per ıstakaya uygulandı; ${plan.leftoverIds.length} taş dışarıda kaldı.`);
  };

  const undoBestPlan = () => {
    if (!undoOrder) return;
    const byId = new Map(rackTiles.map((tile) => [tile.id, tile]));
    setRackTiles(undoOrder.map((id) => byId.get(id)).filter((tile): tile is RackTile => Boolean(tile)));
    setUndoOrder(null);
    setPlanApplied(false);
    setRackAnnouncement('Önceki ıstaka sırası geri getirildi.');
  };

  const resetRackOwnership = () => {
    rackDirtyRef.current = false;
    setRackDirty(false);
    setPlanApplied(false);
    setUndoOrder(null);
    setSelectedTileId(null);
    setEditorOpen(false);
  };

  const rescan = async () => {
    if (photoBusy) return;
    if (isDemo) {
      resetRackOwnership();
      setRackTiles(rackFromDetections(createDemoTiles(), 'manual'));
      rackDirtyRef.current = true;
      setRackDirty(true);
      setFrozen(true);
      setScanPhase('ready');
      return;
    }
    if (photo) {
      const requestId = photoScanId.current + 1;
      const rackVersion = rackMutationVersion.current;
      photoScanId.current = requestId;
      setFrozen(true);
      setPhotoBusy(true);
      setPhotoError(null);
      setScanPhase('reading');
      try {
        const recognition = await recognizeRack(photo.canvas);
        if (requestId !== photoScanId.current || rackVersion !== rackMutationVersion.current) return;
        resetRackOwnership();
        setRackTiles(rackFromDetections(recognition.tiles));
        setQuality(recognition.quality);
        rackDirtyRef.current = true;
        setRackDirty(true);
        setScanPhase('ready');
      } catch (error) {
        if (requestId !== photoScanId.current) return;
        console.error(error);
        setPhotoError('Fotoğraf yeniden okunamadı. Başka bir fotoğraf seçebilir veya tekrar deneyebilirsin.');
        setScanPhase('error');
      } finally {
        if (requestId === photoScanId.current) setPhotoBusy(false);
      }
      return;
    }
    resetRackOwnership();
    setRackTiles([]);
    setQuality(null);
    setFrozen(false);
    setScanPhase('waiting');
  };

  const handleScanAction = () => {
    if (frozen) void rescan();
    else claimRack();
  };

  const enterDemo = () => {
    photoScanId.current += 1;
    setPhotoBusy(false);
    setPhotoError(null);
    if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
    photoRef.current = null;
    setPhoto(null);
    camera.stop();
    setIsDemo(true);
    setRackTiles(rackFromDetections(createDemoTiles(), 'manual'));
    setFrozen(true);
    rackDirtyRef.current = true;
    setRackDirty(true);
    setPlanApplied(false);
    setUndoOrder(null);
    setScanPhase('ready');
    setQuality(null);
    setOkeyPrompted(Boolean(okey));
  };

  const choosePhoto = () => {
    if (!photoBusy) photoInputRef.current?.click();
  };

  const readPhoto = async (file: File) => {
    const requestId = photoScanId.current + 1;
    const rackVersion = rackMutationVersion.current;
    const previousFrozen = frozen;
    photoScanId.current = requestId;
    setPhotoError(null);
    setPhotoBusy(true);
    setScanPhase('loading');
    setFrozen(true);
    let loaded: PhotoSource | null = null;
    try {
      loaded = await loadPhoto(file);
      if (requestId !== photoScanId.current) {
        URL.revokeObjectURL(loaded.url);
        return;
      }
      const recognition = await recognizeRack(loaded.canvas, (progress) => {
        if (progress > 0) setScanPhase('reading');
      });
      if (requestId !== photoScanId.current || rackVersion !== rackMutationVersion.current) {
        URL.revokeObjectURL(loaded.url);
        return;
      }
      if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
      photoRef.current = loaded;
      setPhoto(loaded);
      resetRackOwnership();
      setRackTiles(rackFromDetections(recognition.tiles));
      setQuality(recognition.quality);
      rackDirtyRef.current = true;
      setRackDirty(true);
      setScanPhase('ready');
      setOkeyPrompted(Boolean(okey));
    } catch (error) {
      if (requestId !== photoScanId.current) {
        if (loaded && photoRef.current?.url !== loaded.url) URL.revokeObjectURL(loaded.url);
        return;
      }
      console.error(error);
      setPhotoError('Fotoğraf okunamadı. HEIC, JPEG veya PNG ile yeniden dene.');
      setScanPhase('error');
      setFrozen(previousFrozen);
    } finally {
      if (requestId === photoScanId.current) setPhotoBusy(false);
    }
  };

  const exitPhoto = () => {
    photoScanId.current += 1;
    setPhotoBusy(false);
    if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
    photoRef.current = null;
    setPhoto(null);
    setPhotoError(null);
    setRackTiles([]);
    setQuality(null);
    setFrozen(false);
    resetRackOwnership();
    setOkeyPrompted(Boolean(okey));
    setScanPhase('waiting');
  };

  const exitDemo = () => {
    photoScanId.current += 1;
    setPhotoBusy(false);
    setPhotoError(null);
    setIsDemo(false);
    setRackTiles([]);
    setFrozen(false);
    resetRackOwnership();
    setOkeyPrompted(Boolean(okey));
    setScanPhase('waiting');
  };

  const selectOkey = (selection: OkeySelection | null) => {
    setOkey(selection);
    setOkeyPrompted(true);
    setOkeyOpen(false);
    setPlanApplied(false);
    setUndoOrder(null);
  };

  const scanHint = photoError
    ?? quality?.message
    ?? (rackTiles.length
      ? `${rackTiles.length} taş sanal ıstakada${rackDirty ? ' · düzenleme sende' : ''}`
      : 'Istakayı kesikli alana yaklaştır');

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
        <section className={`camera-stage ${isDemo ? 'is-demo' : ''}`}>
          {!isDemo && !photo && (
            <video ref={camera.videoRef} autoPlay muted playsInline aria-label="Canlı arka kamera görüntüsü" />
          )}
          {photo && <img className="photo-frame" src={photo.url} alt="Taranan 101 Okey ıstakası" />}
          {isDemo && (
            <div className="demo-scene" aria-label="Örnek 101 Okey masası">
              <div className="table-mark table-mark-one">101</div>
              <div className="table-mark table-mark-two">OYUN</div>
            </div>
          )}

          <div className="camera-vignette" />
          <header className="top-hud">
            <div className="wordmark"><span>YÜZ</span><strong>BİR</strong></div>
            <div className="hud-actions">
              {showCamera && (
                <button className={`hud-okey ${okey ? '' : 'is-empty'}`} onClick={() => setOkeyOpen(true)}>
                  <span>OKEY</span>
                  <strong>{okey ? `${COLOR_LABELS[okey.color]} ${okey.number}` : 'SEÇ'}</strong>
                </button>
              )}
              {(isDemo || photo) && (
                <button className="demo-exit" onClick={photo ? exitPhoto : exitDemo}>
                  <Camera size={14} /> <span className="demo-exit-label">Kamera</span>
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
                <div className="guide-label"><ScanLine size={14} /> KAMERA OKUMA ALANI</div>
                <div className="row-guide first" /><div className="row-guide second" />
              </div>
              <div className="camera-hint"><span>{scanHint}</span></div>
              {!frozen && <div className="scan-beam" />}

              <VirtualRack
                tiles={rackTiles}
                plan={plan}
                okey={okey}
                applied={planApplied}
                canUndo={Boolean(undoOrder)}
                onChooseOkey={() => setOkeyOpen(true)}
                onEdit={openEditor}
                onAdd={addTile}
                onApply={applyBestPlan}
                onUndo={undoBestPlan}
                onReorder={reorderRack}
                onMove={moveTileTo}
                onClaim={claimRack}
                locked={photoBusy}
              />

              <ScoreDock
                tiles={rackTiles}
                plan={plan}
                scanPhase={scanPhase}
                frozen={frozen}
                isDemo={isDemo}
                onScanAction={handleScanAction}
                onEdit={() => openEditor()}
                onApply={applyBestPlan}
                busy={photoBusy}
                applied={planApplied}
              />
            </>
          )}

          {!showCamera && (
            <PermissionCard
              state={camera.state}
              error={photoError ?? camera.error}
              onRetry={() => {
                setPhotoError(null);
                void camera.start();
              }}
              onDemo={enterDemo}
              onPhoto={choosePhoto}
            />
          )}
        </section>

        <div className="desktop-note">
          <div><RefreshCw size={16} /><span>Taşları sanal ıstakada sürükleyerek sırala</span></div>
        </div>

        {editorOpen && selectedTile && (
          <TileEditor
            tile={selectedTile}
            index={selectedIndex}
            count={rackTiles.length}
            onChange={updateSelectedTile}
            onDelete={deleteSelectedTile}
            onMove={(targetIndex) => moveTileTo(selectedTile.id, targetIndex)}
            onClose={() => setEditorOpen(false)}
          />
        )}
        {infoOpen && <InfoSheet onClose={() => setInfoOpen(false)} />}
        {okeyOpen && (
          <OkeyPicker
            initial={okey}
            onConfirm={selectOkey}
            onSkip={() => selectOkey(null)}
          />
        )}
        <div className="sr-only" aria-live="polite">{rackAnnouncement}</div>
      </div>
    </main>
  );
}
