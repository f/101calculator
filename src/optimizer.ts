import { TILE_COLORS, type TileColor } from './domain';

export type RackTile = {
  id: string;
  number: number | null;
  color: TileColor;
  kind: 'number' | 'star';
  confidence: number;
  source: 'scan' | 'manual';
  edited: boolean;
};

export type OkeySelection = {
  number: number;
  color: TileColor;
};

export type TilePlacement = {
  tileId: string;
  represents: {
    number: number;
    color: TileColor;
  };
  wildcard: null | 'star' | 'okey';
};

export type SuggestedMeld = {
  id: string;
  kind: 'run' | 'set';
  placements: TilePlacement[];
  score: number;
};

export type RackPlan = {
  melds: SuggestedMeld[];
  leftoverIds: string[];
  usedCount: number;
  total: number;
  passes101: boolean;
  wildcardCount: number;
};

type RequiredFace = {
  number: number;
  color: TileColor;
};

type MeldPattern = {
  key: string;
  kind: SuggestedMeld['kind'];
  slots: RequiredFace[];
  score: number;
};

type MeldCandidate = {
  pattern: MeldPattern;
  naturalGroupBySlot: number[];
  naturalGroups: number[];
  tileCount: number;
  wildcardCount: number;
  tieKey: string;
};

type TileGroup = {
  tileIndices: number[];
};

type SolverState = {
  usedCount: number;
  total: number;
  wildcardCount: number;
  meldCount: number;
  choice: number | null;
  nextMask: number;
};

const MIN_TILE_NUMBER = 1;
const MAX_TILE_NUMBER = 13;
const MIN_MELD_LENGTH = 3;
export const MAX_RACK_TILES = 22;

const compareStrings = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const isTileNumber = (number: number | null): number is number =>
  number !== null
  && Number.isInteger(number)
  && number >= MIN_TILE_NUMBER
  && number <= MAX_TILE_NUMBER;

export function isEffectiveJoker(tile: RackTile, okey: OkeySelection | null): boolean {
  if (tile.kind === 'star') return true;
  return Boolean(
    okey
    && isTileNumber(tile.number)
    && isTileNumber(okey.number)
    && tile.number === okey.number
    && tile.color === okey.color,
  );
}

function chooseColors(size: number): TileColor[][] {
  const combinations: TileColor[][] = [];

  const visit = (start: number, selected: TileColor[]) => {
    if (selected.length === size) {
      combinations.push([...selected]);
      return;
    }

    for (let index = start; index <= TILE_COLORS.length - (size - selected.length); index += 1) {
      selected.push(TILE_COLORS[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };

  visit(0, []);
  return combinations;
}

function createMeldPatterns(): MeldPattern[] {
  const patterns: MeldPattern[] = [];

  for (const color of TILE_COLORS) {
    for (let start = MIN_TILE_NUMBER; start <= MAX_TILE_NUMBER - 2; start += 1) {
      for (let end = start + 2; end <= MAX_TILE_NUMBER; end += 1) {
        const slots = Array.from(
          { length: end - start + 1 },
          (_, index): RequiredFace => ({ number: start + index, color }),
        );
        patterns.push({
          key: `run:${color}:${start}:${end}`,
          kind: 'run',
          slots,
          score: slots.reduce((total, slot) => total + slot.number, 0),
        });
      }
    }
  }

  const setColorGroups = [...chooseColors(3), [...TILE_COLORS]];
  for (let number = MIN_TILE_NUMBER; number <= MAX_TILE_NUMBER; number += 1) {
    for (const colors of setColorGroups) {
      const slots = colors.map((color): RequiredFace => ({ number, color }));
      patterns.push({
        key: `set:${number}:${colors.join(',')}`,
        kind: 'set',
        slots,
        score: number * slots.length,
      });
    }
  }

  return patterns;
}

const MELD_PATTERNS = createMeldPatterns();

const faceKey = (number: number, color: TileColor) => `${color}:${number}`;

function createTileGroups(tiles: RackTile[], okey: OkeySelection | null) {
  const groups: TileGroup[] = [];
  const faceGroupByKey = new Map<string, number>();
  const tileGroupIndices = Array.from({ length: tiles.length }, () => -1);
  let wildcardGroupIndex = -1;

  tiles.forEach((tile, tileIndex) => {
    if (isEffectiveJoker(tile, okey)) {
      if (wildcardGroupIndex < 0) {
        wildcardGroupIndex = groups.length;
        groups.push({ tileIndices: [] });
      }
      groups[wildcardGroupIndex].tileIndices.push(tileIndex);
      tileGroupIndices[tileIndex] = wildcardGroupIndex;
      return;
    }

    if (tile.kind !== 'number' || !isTileNumber(tile.number)) return;
    const key = faceKey(tile.number, tile.color);
    let groupIndex = faceGroupByKey.get(key);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      faceGroupByKey.set(key, groupIndex);
      groups.push({ tileIndices: [] });
    }
    groups[groupIndex].tileIndices.push(tileIndex);
    tileGroupIndices[tileIndex] = groupIndex;
  });

  return { groups, faceGroupByKey, tileGroupIndices, wildcardGroupIndex };
}

function createCandidates(
  tiles: RackTile[],
  groups: TileGroup[],
  faceGroupByKey: Map<string, number>,
  wildcardGroupIndex: number,
): MeldCandidate[] {
  const wildcardCount = wildcardGroupIndex >= 0
    ? groups[wildcardGroupIndex].tileIndices.length
    : 0;
  const bestByResources = new Map<string, MeldCandidate>();

  const emitCandidate = (
    pattern: MeldPattern,
    naturalGroupBySlot: number[],
    missingSlots: number[],
  ) => {
    const naturalGroups = naturalGroupBySlot.filter((groupIndex) => groupIndex >= 0);
    const resourceKey = `${[...naturalGroups].sort((left, right) => left - right).join(',')}|w${missingSlots.length}`;
    const tieKey = `${pattern.key}|${missingSlots.join(',')}`;
    const candidate: MeldCandidate = {
      pattern,
      naturalGroupBySlot: [...naturalGroupBySlot],
      naturalGroups,
      tileCount: pattern.slots.length,
      wildcardCount: missingSlots.length,
      tieKey,
    };
    const existing = bestByResources.get(resourceKey);
    if (
      !existing
      || candidate.pattern.score > existing.pattern.score
      || (
        candidate.pattern.score === existing.pattern.score
        && compareStrings(candidate.tieKey, existing.tieKey) < 0
      )
    ) {
      bestByResources.set(resourceKey, candidate);
    }
  };

  for (const pattern of MELD_PATTERNS) {
    if (pattern.slots.length > tiles.length) continue;

    const naturalGroupBySlot = Array.from({ length: pattern.slots.length }, () => -1);
    const missingSlots: number[] = [];

    const bindSlots = (slotIndex: number) => {
      if (missingSlots.length > wildcardCount) return;
      if (slotIndex === pattern.slots.length) {
        emitCandidate(pattern, naturalGroupBySlot, missingSlots);
        return;
      }

      const slot = pattern.slots[slotIndex];
      const naturalGroupIndex = faceGroupByKey.get(faceKey(slot.number, slot.color));
      if (naturalGroupIndex !== undefined) {
        naturalGroupBySlot[slotIndex] = naturalGroupIndex;
        bindSlots(slotIndex + 1);
      }

      if (missingSlots.length < wildcardCount) {
        naturalGroupBySlot[slotIndex] = -1;
        missingSlots.push(slotIndex);
        bindSlots(slotIndex + 1);
        missingSlots.pop();
      }
    };

    bindSlots(0);
  }

  return [...bestByResources.values()].sort((left, right) =>
    right.tileCount - left.tileCount
    || right.pattern.score - left.pattern.score
    || left.wildcardCount - right.wildcardCount
    || compareStrings(left.tieKey, right.tieKey));
}

function isBetterState(candidate: SolverState, current: SolverState): boolean {
  const candidatePasses = candidate.total >= 101;
  const currentPasses = current.total >= 101;
  if (candidatePasses !== currentPasses) return candidatePasses;
  if (candidate.usedCount !== current.usedCount) return candidate.usedCount > current.usedCount;
  if (candidate.total !== current.total) return candidate.total > current.total;
  if (candidate.wildcardCount !== current.wildcardCount) {
    return candidate.wildcardCount < current.wildcardCount;
  }
  if (candidate.meldCount !== current.meldCount) return candidate.meldCount < current.meldCount;
  return false;
}

function firstAvailableTile(group: TileGroup, availableMask: number) {
  return group.tileIndices.find((tileIndex) => (availableMask & (1 << tileIndex)) !== 0);
}

function materializeCandidateMask(
  candidate: MeldCandidate,
  availableMask: number,
  groups: TileGroup[],
  wildcardGroupIndex: number,
) {
  let mask = 0;
  for (const groupIndex of candidate.naturalGroups) {
    const tileIndex = firstAvailableTile(groups[groupIndex], availableMask);
    if (tileIndex === undefined) return null;
    mask |= 1 << tileIndex;
  }

  if (candidate.wildcardCount > 0) {
    if (wildcardGroupIndex < 0) return null;
    let selected = 0;
    for (const tileIndex of groups[wildcardGroupIndex].tileIndices) {
      if ((availableMask & (1 << tileIndex)) === 0) continue;
      mask |= 1 << tileIndex;
      selected += 1;
      if (selected === candidate.wildcardCount) break;
    }
    if (selected !== candidate.wildcardCount) return null;
  }

  return mask;
}

function materializeMeld(
  candidate: MeldCandidate,
  availableMask: number,
  groups: TileGroup[],
  wildcardGroupIndex: number,
  tiles: RackTile[],
  okey: OkeySelection | null,
) {
  const tileByNaturalGroup = new Map<number, number>();
  for (const groupIndex of candidate.naturalGroups) {
    const tileIndex = firstAvailableTile(groups[groupIndex], availableMask);
    if (tileIndex === undefined) return null;
    tileByNaturalGroup.set(groupIndex, tileIndex);
  }

  const wildcardTileIndices: number[] = [];
  if (candidate.wildcardCount > 0) {
    if (wildcardGroupIndex < 0) return null;
    for (const tileIndex of groups[wildcardGroupIndex].tileIndices) {
      if ((availableMask & (1 << tileIndex)) === 0) continue;
      wildcardTileIndices.push(tileIndex);
      if (wildcardTileIndices.length === candidate.wildcardCount) break;
    }
    if (wildcardTileIndices.length !== candidate.wildcardCount) return null;
  }

  let wildcardIndex = 0;
  let mask = 0;
  const placements = candidate.pattern.slots.map((slot, slotIndex): TilePlacement => {
    const naturalGroupIndex = candidate.naturalGroupBySlot[slotIndex];
    const tileIndex = naturalGroupIndex >= 0
      ? tileByNaturalGroup.get(naturalGroupIndex)
      : wildcardTileIndices[wildcardIndex++];
    if (tileIndex === undefined) {
      throw new Error('A generated meld slot did not receive a tile.');
    }

    mask |= 1 << tileIndex;
    const tile = tiles[tileIndex];
    return {
      tileId: tile.id,
      represents: { ...slot },
      wildcard: tile.kind === 'star' ? 'star' : isEffectiveJoker(tile, okey) ? 'okey' : null,
    };
  });
  const sortedTileIds = placements.map((placement) => placement.tileId).sort(compareStrings);
  return {
    mask,
    meld: {
      id: JSON.stringify([candidate.pattern.key, sortedTileIds]),
      kind: candidate.pattern.kind,
      placements,
      score: candidate.pattern.score,
    } satisfies SuggestedMeld,
  };
}

function emptyPlan(tiles: RackTile[]): RackPlan {
  return {
    melds: [],
    leftoverIds: tiles.map((tile) => tile.id).sort(compareStrings),
    usedCount: 0,
    total: 0,
    passes101: false,
    wildcardCount: 0,
  };
}

export function optimizeRack(tiles: readonly RackTile[], okey: OkeySelection | null): RackPlan {
  const indexedTiles = [...tiles].sort((left, right) => compareStrings(left.id, right.id));
  if (indexedTiles.length > MAX_RACK_TILES) return emptyPlan(indexedTiles);
  if (new Set(tiles.map((tile) => tile.id)).size !== tiles.length) {
    throw new Error('Every rack tile must have a unique id.');
  }

  if (indexedTiles.length < MIN_MELD_LENGTH) return emptyPlan(indexedTiles);

  const {
    groups,
    faceGroupByKey,
    tileGroupIndices,
    wildcardGroupIndex,
  } = createTileGroups(indexedTiles, okey);
  const candidates = createCandidates(
    indexedTiles,
    groups,
    faceGroupByKey,
    wildcardGroupIndex,
  );
  if (!candidates.length) return emptyPlan(indexedTiles);

  const candidatesByGroup = Array.from({ length: groups.length }, (): number[] => []);
  candidates.forEach((candidate, candidateIndex) => {
    for (const groupIndex of candidate.naturalGroups) {
      candidatesByGroup[groupIndex].push(candidateIndex);
    }
    if (candidate.wildcardCount > 0 && wildcardGroupIndex >= 0) {
      candidatesByGroup[wildcardGroupIndex].push(candidateIndex);
    }
  });
  const pivotPriority = indexedTiles
    .map((_, index) => index)
    .sort((left, right) =>
      (tileGroupIndices[left] >= 0 ? candidatesByGroup[tileGroupIndices[left]].length : 0)
        - (tileGroupIndices[right] >= 0 ? candidatesByGroup[tileGroupIndices[right]].length : 0)
      || compareStrings(indexedTiles[left].id, indexedTiles[right].id));
  const memo = new Map<number, SolverState>();
  const zeroState: SolverState = {
    usedCount: 0,
    total: 0,
    wildcardCount: 0,
    meldCount: 0,
    choice: null,
    nextMask: 0,
  };

  const solve = (availableMask: number): SolverState => {
    if (availableMask === 0) return zeroState;
    const cached = memo.get(availableMask);
    if (cached) return cached;

    const pivotIndex = pivotPriority.find((index) => (availableMask & (1 << index)) !== 0);
    if (pivotIndex === undefined) return zeroState;
    const skippedMask = availableMask ^ (1 << pivotIndex);
    const skipped = solve(skippedMask);
    let best: SolverState = {
      usedCount: skipped.usedCount,
      total: skipped.total,
      wildcardCount: skipped.wildcardCount,
      meldCount: skipped.meldCount,
      choice: null,
      nextMask: skippedMask,
    };

    const pivotGroupIndex = tileGroupIndices[pivotIndex];
    const pivotCandidates = pivotGroupIndex >= 0 ? candidatesByGroup[pivotGroupIndex] : [];
    for (const candidateIndex of pivotCandidates) {
      const candidate = candidates[candidateIndex];
      const candidateMask = materializeCandidateMask(
        candidate,
        availableMask,
        groups,
        wildcardGroupIndex,
      );
      if (candidateMask === null || (candidateMask & (1 << pivotIndex)) === 0) continue;

      const nextMask = availableMask ^ candidateMask;
      const tail = solve(nextMask);
      const proposed: SolverState = {
        usedCount: tail.usedCount + candidate.tileCount,
        total: tail.total + candidate.pattern.score,
        wildcardCount: tail.wildcardCount + candidate.wildcardCount,
        meldCount: tail.meldCount + 1,
        choice: candidateIndex,
        nextMask,
      };
      if (isBetterState(proposed, best)) best = proposed;
    }

    memo.set(availableMask, best);
    return best;
  };

  const fullMask = (1 << indexedTiles.length) - 1;
  const best = solve(fullMask);
  const selectedMelds: SuggestedMeld[] = [];
  let remainingMask = fullMask;
  while (remainingMask !== 0) {
    const state = memo.get(remainingMask) ?? solve(remainingMask);
    if (state.choice !== null) {
      const materialized = materializeMeld(
        candidates[state.choice],
        remainingMask,
        groups,
        wildcardGroupIndex,
        indexedTiles,
        okey,
      );
      if (!materialized || materialized.mask !== (remainingMask ^ state.nextMask)) {
        throw new Error('The selected rack plan could not be reconstructed.');
      }
      selectedMelds.push(materialized.meld);
    }
    if (state.nextMask === remainingMask) break;
    remainingMask = state.nextMask;
  }

  const usedIds = new Set(
    selectedMelds.flatMap((meld) => meld.placements.map((placement) => placement.tileId)),
  );
  const melds = selectedMelds.sort((left, right) => compareStrings(left.id, right.id));

  return {
    melds,
    leftoverIds: indexedTiles
      .filter((tile) => !usedIds.has(tile.id))
      .map((tile) => tile.id),
    usedCount: best.usedCount,
    total: best.total,
    passes101: best.total >= 101,
    wildcardCount: best.wildcardCount,
  };
}
