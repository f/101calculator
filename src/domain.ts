export const TILE_COLORS = ['red', 'blue', 'black', 'yellow'] as const;

export type TileColor = (typeof TILE_COLORS)[number];

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DetectedTile = {
  id: string;
  number: number | null;
  color: TileColor;
  confidence: number;
  bounds: Rect;
  groupIndex: number;
  edited?: boolean;
};

export type MeldKind = 'run' | 'set' | 'unknown';

export type MeldResult = {
  groupIndex: number;
  tiles: DetectedTile[];
  sum: number;
  kind: MeldKind;
  isValid: boolean;
  confidence: number;
};

export type ScanResult = {
  tiles: DetectedTile[];
  melds: MeldResult[];
  total: number;
  remaining: number;
  passes101: boolean;
  confidence: number;
};

const isConsecutive = (numbers: number[]) =>
  numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);

export function evaluateMeld(tiles: DetectedTile[]): Omit<MeldResult, 'groupIndex'> {
  const sortedTiles = [...tiles].sort((a, b) => a.bounds.x - b.bounds.x);
  const knownNumbers = sortedTiles
    .map((tile) => tile.number)
    .filter((number): number is number => number !== null);
  const sum = knownNumbers.reduce((runningTotal, number) => runningTotal + number, 0);
  const confidence = sortedTiles.length
    ? sortedTiles.reduce((runningTotal, tile) => runningTotal + tile.confidence, 0) / sortedTiles.length
    : 0;

  if (tiles.length < 3 || knownNumbers.length !== tiles.length) {
    return { tiles: sortedTiles, sum, kind: 'unknown', isValid: false, confidence };
  }

  const sameNumber = new Set(knownNumbers).size === 1;
  const colors = sortedTiles.map((tile) => tile.color);
  const isSet = sameNumber && new Set(colors).size === colors.length && colors.length <= 4;

  const sameColor = new Set(colors).size === 1;
  const uniqueNumbers = [...new Set(knownNumbers)].sort((a, b) => a - b);
  let isRun = sameColor && uniqueNumbers.length === knownNumbers.length && isConsecutive(uniqueNumbers);

  return {
    tiles: sortedTiles,
    sum,
    kind: isSet ? 'set' : isRun ? 'run' : 'unknown',
    isValid: isSet || isRun,
    confidence,
  };
}

export function calculateScan(tiles: DetectedTile[]): ScanResult {
  const groupIndices = [...new Set(tiles.map((tile) => tile.groupIndex))].sort((a, b) => a - b);
  const melds = groupIndices.map((groupIndex) => ({
    groupIndex,
    ...evaluateMeld(tiles.filter((tile) => tile.groupIndex === groupIndex)),
  }));
  // Invalid or incomplete tiles stay visible for correction, but they cannot
  // make the player appear to have reached the opening threshold.
  const total = melds.reduce(
    (runningTotal, meld) => runningTotal + (meld.isValid ? meld.sum : 0),
    0,
  );
  const confidence = tiles.length
    ? tiles.reduce((runningTotal, tile) => runningTotal + tile.confidence, 0) / tiles.length
    : 0;

  return {
    tiles,
    melds,
    total,
    remaining: Math.max(0, 101 - total),
    passes101: total >= 101,
    confidence,
  };
}

export function assignGroupsBySpacing(tiles: DetectedTile[]): DetectedTile[] {
  if (!tiles.length) return [];

  const widths = tiles.map((tile) => tile.bounds.width).sort((a, b) => a - b);
  const heights = tiles.map((tile) => tile.bounds.height).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)] || 0.05;
  const medianHeight = heights[Math.floor(heights.length / 2)] || 0.2;
  const rows: Array<{ centerY: number; tiles: DetectedTile[] }> = [];

  for (const tile of [...tiles].sort((a, b) => a.bounds.y - b.bounds.y)) {
    const tileCenterY = tile.bounds.y + tile.bounds.height / 2;
    const row = rows.find((candidate) => Math.abs(candidate.centerY - tileCenterY) < medianHeight * 0.48);
    if (row) {
      row.tiles.push(tile);
      row.centerY = row.tiles.reduce(
        (total, rowTile) => total + rowTile.bounds.y + rowTile.bounds.height / 2,
        0,
      ) / row.tiles.length;
    } else {
      rows.push({ centerY: tileCenterY, tiles: [tile] });
    }
  }

  let groupIndex = 0;
  const grouped: DetectedTile[] = [];
  rows
    .sort((a, b) => a.centerY - b.centerY)
    .forEach((row, rowIndex) => {
      const sortedRow = row.tiles.sort((a, b) => a.bounds.x - b.bounds.x);
      if (rowIndex > 0) groupIndex += 1;
      sortedRow.forEach((tile, index) => {
        if (index > 0) {
          const previous = sortedRow[index - 1];
          const gap = tile.bounds.x - (previous.bounds.x + previous.bounds.width);
          if (gap > medianWidth * 0.42) groupIndex += 1;
        }
        grouped.push({ ...tile, groupIndex });
      });
    });
  return grouped;
}

export function createDemoTiles(): DetectedTile[] {
  const groups: Array<Array<{ number: number; color: TileColor }>> = [
    [
      { number: 11, color: 'red' },
      { number: 12, color: 'red' },
      { number: 13, color: 'red' },
    ],
    [
      { number: 8, color: 'red' },
      { number: 8, color: 'blue' },
      { number: 8, color: 'black' },
      { number: 8, color: 'yellow' },
    ],
    [
      { number: 10, color: 'blue' },
      { number: 11, color: 'blue' },
      { number: 12, color: 'blue' },
    ],
  ];

  const tileWidth = 0.066;
  const tileHeight = 0.075;
  const tileGap = 0.008;
  const groupGap = 0.044;
  const totalWidth =
    groups.reduce((count, group) => count + group.length, 0) * tileWidth +
    (groups.reduce((count, group) => count + group.length, 0) - groups.length) * tileGap +
    (groups.length - 1) * groupGap;
  let x = (1 - totalWidth) / 2;

  return groups.flatMap((group, groupIndex) => {
    const result = group.map((tile, tileIndex) => {
      const detected: DetectedTile = {
        id: `demo-${groupIndex}-${tileIndex}`,
        ...tile,
        confidence: 0.98,
        groupIndex,
        bounds: { x, y: 0.355, width: tileWidth, height: tileHeight },
      };
      x += tileWidth + tileGap;
      return detected;
    });
    x += groupGap - tileGap;
    return result;
  });
}
