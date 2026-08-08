import { describe, expect, it } from 'vitest';
import {
  assignGroupsBySpacing,
  calculateScan,
  createDemoTiles,
  evaluateMeld,
  type DetectedTile,
  type TileColor,
} from './domain';

const makeTiles = (numbers: number[], colors: TileColor[]): DetectedTile[] =>
  numbers.map((number, index) => ({
    id: String(index),
    number,
    color: colors[index] ?? colors[0],
    confidence: 1,
    groupIndex: 0,
    bounds: { x: index * 0.08, y: 0, width: 0.06, height: 0.3 },
  }));

const makeJoker = (index: number): DetectedTile => ({
  id: `joker-${index}`,
  number: null,
  color: 'black',
  confidence: 0.9,
  groupIndex: 0,
  isJoker: true,
  bounds: { x: index * 0.08, y: 0, width: 0.06, height: 0.3 },
});

describe('evaluateMeld', () => {
  it('recognizes a same-color run', () => {
    const result = evaluateMeld(makeTiles([10, 11, 12], ['blue']));
    expect(result).toMatchObject({ sum: 33, kind: 'run', isValid: true });
  });

  it('recognizes a four-color set', () => {
    const result = evaluateMeld(makeTiles([8, 8, 8, 8], ['red', 'blue', 'black', 'yellow']));
    expect(result).toMatchObject({ sum: 32, kind: 'set', isValid: true });
  });

  it('does not wrap runs past 13', () => {
    expect(evaluateMeld(makeTiles([12, 13, 1], ['red'])).isValid).toBe(false);
    expect(evaluateMeld(makeTiles([13, 1, 2], ['red'])).isValid).toBe(false);
  });

  it('rejects duplicate colors in a set', () => {
    const result = evaluateMeld(makeTiles([7, 7, 7], ['red', 'red', 'black']));
    expect(result).toMatchObject({ kind: 'unknown', isValid: false });
  });

  it('infers a joker from matching set numbers', () => {
    const tiles = makeTiles([4, 4], ['red', 'blue']);
    tiles.push(makeJoker(2));
    const result = evaluateMeld(tiles);
    expect(result).toMatchObject({ sum: 12, kind: 'set', isValid: true });
    expect(result.tiles[2]).toMatchObject({ number: 4, isJoker: true, inferredJoker: true });
  });

  it('infers a joker from the missing place in a run', () => {
    const tiles = makeTiles([1, 2], ['red']);
    tiles.push(makeJoker(2));
    tiles.push(...makeTiles([4, 5], ['red']).map((tile, index) => ({
      ...tile,
      id: `tail-${tile.id}`,
      bounds: { ...tile.bounds, x: (index + 3) * 0.08 },
    })));
    const result = evaluateMeld(tiles);
    expect(result).toMatchObject({ sum: 15, kind: 'run', isValid: true });
    expect(result.tiles[2]).toMatchObject({ number: 3, inferredJoker: true });
  });
});

describe('calculateScan', () => {
  it('calculates the 101 demo hand', () => {
    const result = calculateScan(createDemoTiles());
    expect(result.total).toBe(101);
    expect(result.remaining).toBe(0);
    expect(result.passes101).toBe(true);
    expect(result.melds).toHaveLength(3);
    expect(result.melds.every((meld) => meld.isValid)).toBe(true);
  });

  it('does not count invalid groups toward 101', () => {
    const valid = makeTiles([10, 11, 12], ['blue']);
    const invalid = makeTiles([13, 1, 2], ['red']).map((tile) => ({ ...tile, groupIndex: 1 }));
    expect(calculateScan([...valid, ...invalid]).total).toBe(33);
  });
});

describe('assignGroupsBySpacing', () => {
  it('creates a new group at a larger physical gap', () => {
    const tiles = makeTiles([1, 2, 3, 9, 9, 9], ['black']).map((tile, index) => ({
      ...tile,
      bounds: { ...tile.bounds, x: index < 3 ? index * 0.07 : 0.32 + (index - 3) * 0.07 },
    }));

    const grouped = assignGroupsBySpacing(tiles);
    expect(grouped.map((tile) => tile.groupIndex)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('keeps the two rows of a rack separate', () => {
    const firstRow = makeTiles([1, 2, 3], ['black']);
    const secondRow = makeTiles([4, 5, 6], ['red']).map((tile) => ({
      ...tile,
      id: `second-${tile.id}`,
      bounds: { ...tile.bounds, y: 0.35 },
    }));

    const grouped = assignGroupsBySpacing([...firstRow, ...secondRow]);
    expect(grouped.map((tile) => tile.groupIndex)).toEqual([0, 0, 0, 1, 1, 1]);
  });
});
