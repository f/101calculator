import { describe, expect, it } from 'vitest';
import {
  isEffectiveJoker,
  MAX_RACK_TILES,
  optimizeRack,
  type OkeySelection,
  type RackTile,
} from './optimizer';
import type { TileColor } from './domain';

const numbered = (id: string, number: number, color: TileColor = 'red'): RackTile => ({
  id,
  number,
  color,
  kind: 'number',
  confidence: 1,
  source: 'manual',
  edited: false,
});

const star = (id = 'star'): RackTile => ({
  id,
  number: null,
  color: 'black',
  kind: 'star',
  confidence: 1,
  source: 'scan',
  edited: false,
});

const blueThree: OkeySelection = { number: 3, color: 'blue' };

describe('isEffectiveJoker', () => {
  it('treats stars and the selected numbered face as wildcards', () => {
    expect(isEffectiveJoker(star(), null)).toBe(true);
    expect(isEffectiveJoker(numbered('okey', 3, 'blue'), blueThree)).toBe(true);
    expect(isEffectiveJoker(numbered('other', 3, 'red'), blueThree)).toBe(false);
    expect(isEffectiveJoker(numbered('unselected', 3, 'blue'), null)).toBe(false);
  });
});

describe('optimizeRack', () => {
  it('uses a selected okey as any missing run tile without changing its printed identity', () => {
    const tiles = [
      numbered('red-1', 1),
      numbered('red-2', 2),
      numbered('red-4', 4),
      numbered('printed-blue-3', 3, 'blue'),
    ];
    const before = structuredClone(tiles);

    const plan = optimizeRack(tiles, blueThree);

    expect(plan).toMatchObject({ usedCount: 4, total: 10, wildcardCount: 1 });
    expect(plan.melds).toHaveLength(1);
    expect(plan.melds[0].kind).toBe('run');
    expect(plan.melds[0].placements.find(({ tileId }) => tileId === 'printed-blue-3')).toEqual({
      tileId: 'printed-blue-3',
      represents: { number: 3, color: 'red' },
      wildcard: 'okey',
    });
    expect(tiles).toEqual(before);
  });

  it('uses a star to fill the missing distinct color in a set', () => {
    const plan = optimizeRack([
      numbered('blue-10', 10, 'blue'),
      numbered('yellow-10', 10, 'yellow'),
      star(),
    ], null);

    expect(plan).toMatchObject({ usedCount: 3, total: 30, wildcardCount: 1 });
    expect(plan.melds[0].kind).toBe('set');
    expect(new Set(plan.melds[0].placements.map(({ represents }) => represents.color)).size).toBe(3);
    expect(plan.melds[0].placements.find(({ tileId }) => tileId === 'star')).toMatchObject({
      represents: { number: 10 },
      wildcard: 'star',
    });
  });

  it('minimizes leftovers before maximizing score', () => {
    const plan = optimizeRack([
      numbered('red-1', 1),
      numbered('red-2', 2),
      numbered('red-4', 4),
      numbered('red-13', 13),
      numbered('blue-13', 13, 'blue'),
      star(),
    ], null);

    // The four-tile 1-4 run scores 10. A greedy score-first solver would
    // instead take the 39-point three-tile set and leave one extra tile.
    expect(plan).toMatchObject({ usedCount: 4, total: 10 });
    expect(plan.leftoverIds).toEqual(['blue-13', 'red-13']);
  });

  it('prefers an opening that passes 101 before minimizing leftovers', () => {
    const plan = optimizeRack([
      ...[7, 8, 9, 10].map((number) => numbered(`yellow-${number}`, number, 'yellow')),
      ...[8, 9, 10, 11].map((number) => numbered(`black-${number}`, number, 'black')),
      numbered('red-1', 1),
      numbered('red-2', 2),
      numbered('red-4', 4),
      numbered('red-13', 13),
      numbered('blue-13', 13, 'blue'),
      star(),
    ], null);

    // Using the star in red 1-4 would consume 12 tiles but score only 82.
    // The useful opening leaves one extra tile out and reaches 111 instead.
    expect(plan).toMatchObject({
      usedCount: 11,
      total: 111,
      passes101: true,
      leftoverIds: ['red-1', 'red-2', 'red-4'],
    });
    expect(plan.melds.map((meld) => meld.score).sort((left, right) => left - right)).toEqual([34, 38, 39]);
  });

  it('maximizes score when competing plans use the same number of tiles', () => {
    const plan = optimizeRack([
      numbered('red-1', 1),
      numbered('red-2', 2),
      numbered('red-13', 13),
      numbered('blue-13', 13, 'blue'),
      star(),
    ], null);

    expect(plan).toMatchObject({ usedCount: 3, total: 39 });
    expect(plan.melds[0].kind).toBe('set');
  });

  it('chooses the higher-valued representation for an ambiguous end wildcard', () => {
    const plan = optimizeRack([
      numbered('red-2', 2),
      numbered('red-3', 3),
      star(),
    ], null);

    expect(plan).toMatchObject({ usedCount: 3, total: 9 });
    expect(plan.melds[0].placements.find(({ tileId }) => tileId === 'star')).toMatchObject({
      represents: { number: 4, color: 'red' },
    });
  });

  it('rejects duplicate colors inside a set while keeping duplicate physical IDs distinct', () => {
    const plan = optimizeRack([
      numbered('red-7-a', 7),
      numbered('red-7-b', 7),
      numbered('blue-7', 7, 'blue'),
      numbered('black-7', 7, 'black'),
    ], null);

    expect(plan).toMatchObject({ usedCount: 3, total: 21 });
    expect(plan.leftoverIds).toHaveLength(1);
    expect(plan.melds[0].placements.map(({ tileId }) => tileId).filter((id) => id.startsWith('red-'))).toHaveLength(1);
  });

  it('never reuses one wildcard in two melds', () => {
    const plan = optimizeRack([
      numbered('red-1', 1),
      numbered('red-2', 2),
      numbered('red-4', 4),
      numbered('blue-7', 7, 'blue'),
      numbered('black-7', 7, 'black'),
      star(),
    ], null);

    const usedIds = plan.melds.flatMap((meld) => meld.placements.map(({ tileId }) => tileId));
    expect(usedIds.filter((id) => id === 'star')).toHaveLength(1);
    expect(new Set(usedIds).size).toBe(usedIds.length);
  });

  it('does not wrap runs from 13 back to 1', () => {
    const plan = optimizeRack([
      numbered('red-12', 12),
      numbered('red-13', 13),
      numbered('red-1', 1),
    ], null);

    expect(plan).toMatchObject({ usedCount: 0, total: 0, melds: [] });
  });

  it('prefers one long run to multiple melds when every earlier objective ties', () => {
    const plan = optimizeRack(
      [1, 2, 3, 4, 5, 6].map((number) => numbered(`red-${number}`, number)),
      null,
    );

    expect(plan).toMatchObject({ usedCount: 6, total: 21 });
    expect(plan.melds).toHaveLength(1);
    expect(plan.melds[0].placements).toHaveLength(6);
  });

  it('calculates an exact 101-point plan', () => {
    const tiles = [
      ...[11, 12, 13].map((number) => numbered(`red-${number}`, number)),
      ...(['red', 'blue', 'black', 'yellow'] as TileColor[])
        .map((color) => numbered(`${color}-8`, 8, color)),
      ...[10, 11, 12].map((number) => numbered(`blue-${number}`, number, 'blue')),
    ];
    const plan = optimizeRack(tiles, null);

    expect(plan).toMatchObject({
      usedCount: 10,
      total: 101,
      passes101: true,
      leftoverIds: [],
    });
  });

  it('handles a full 22-tile rack synchronously', () => {
    const tiles = [
      ...Array.from({ length: 11 }, (_, index) => numbered(`red-${index + 1}`, index + 1)),
      ...Array.from(
        { length: 11 },
        (_, index) => numbered(`blue-${index + 1}`, index + 1, 'blue'),
      ),
    ];

    const plan = optimizeRack(tiles, null);

    expect(plan).toMatchObject({ usedCount: 22, total: 132, leftoverIds: [] });
    expect(plan.melds).toHaveLength(2);
  });

  it('handles duplicate copies across a full 22-tile rack', () => {
    const tiles = Array.from({ length: 11 }, (_, index) => [
      numbered(`red-${index + 1}-a`, index + 1),
      numbered(`red-${index + 1}-b`, index + 1),
    ]).flat();

    const plan = optimizeRack(tiles, null);

    expect(plan).toMatchObject({ usedCount: 22, total: 132, leftoverIds: [] });
    expect(plan.melds).toHaveLength(2);
  });

  it('solves a dense 22-tile rack with four effective wildcards without combinatorial blowup', () => {
    const tiles = [
      ...Array.from({ length: 9 }, (_, index) => [
        numbered(`red-${index + 1}-a`, index + 1),
        numbered(`red-${index + 1}-b`, index + 1),
      ]).flat(),
      star('star-a'),
      star('star-b'),
      numbered('okey-a', 13, 'blue'),
      numbered('okey-b', 13, 'blue'),
    ];

    const startedAt = performance.now();
    const plan = optimizeRack(tiles, { number: 13, color: 'blue' });
    const elapsed = performance.now() - startedAt;

    expect(plan).toMatchObject({
      usedCount: 22,
      total: 142,
      passes101: true,
      leftoverIds: [],
      wildcardCount: 4,
    });
    expect(new Set(plan.melds.flatMap((meld) => meld.placements.map(({ tileId }) => tileId))).size).toBe(22);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('is deterministic across rack reordering', () => {
    const tiles = [
      numbered('red-2', 2),
      numbered('red-3', 3),
      numbered('red-4', 4),
      numbered('blue-9', 9, 'blue'),
      numbered('black-9', 9, 'black'),
      star(),
    ];

    expect(optimizeRack(tiles, null)).toEqual(optimizeRack([...tiles].reverse(), null));
  });

  it('returns all tiles as leftovers when fewer than three can form a rack', () => {
    const plan = optimizeRack([numbered('red-1', 1), numbered('red-2', 2)], null);
    expect(plan).toEqual({
      melds: [],
      leftoverIds: ['red-1', 'red-2'],
      usedCount: 0,
      total: 0,
      passes101: false,
      wildcardCount: 0,
    });
  });

  it('fails safely when an unexpected scan exceeds the supported 22-tile rack', () => {
    expect(MAX_RACK_TILES).toBe(22);
    const tiles = Array.from(
      { length: MAX_RACK_TILES + 1 },
      (_, index) => numbered(`tile-${index}`, (index % 13) + 1),
    );

    const plan = optimizeRack(tiles, null);

    expect(plan).toEqual({
      melds: [],
      leftoverIds: tiles.map((tile) => tile.id).sort(),
      usedCount: 0,
      total: 0,
      passes101: false,
      wildcardCount: 0,
    });
  });
});
