import { describe, it, expect } from 'vitest';
import {
  TROPHIES,
  TROPHIES_STORAGE_KEY,
  tierId,
  totalTiers,
  createEmptyTrophyState,
  loadTrophies,
  saveTrophies,
  resetTrophies,
  satisfiedTiers,
  awardTrophies,
  syncTrophies,
  earnedCount,
  describeTier,
  trophyRows,
} from './trophies.js';
import { createEmptyStats } from './stats.js';

// Same in-memory Storage stand-in as stats.test.js, so the pure logic can be
// tested without a real browser localStorage.
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const statsWith = (over = {}) => ({ ...createEmptyStats(), ...over });

// A long-time player: the shape this whole feature exists to reward.
const veteran = statsWith({ gamesPlayed: 180, wins: 90, longestWinStreak: 11 });

describe('the catalogue', () => {
  it('has a unique id per trophy', () => {
    const ids = TROPHIES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists every ladder in ascending order', () => {
    for (const trophy of TROPHIES) {
      const sorted = [...trophy.tiers].sort((a, b) => a - b);
      expect(trophy.tiers).toEqual(sorted);
    }
  });

  it('counts fourteen tiers across five trophies', () => {
    expect(TROPHIES).toHaveLength(5);
    expect(totalTiers()).toBe(14);
  });

  it('reads only monotonic counters, so no trophy can ever un-earn itself', () => {
    // The whole set is retroactive *because* it is monotonic. A trophy reading
    // winRate or currentStreak would break both properties at once, so guard
    // the invariant rather than trusting it: progress must never fall when a
    // counter only ever rises.
    const before = statsWith({ gamesPlayed: 10, wins: 5, longestWinStreak: 5 });
    const after = statsWith({ gamesPlayed: 11, wins: 5, longestWinStreak: 5 });
    for (const trophy of TROPHIES) {
      expect(trophy.progress(after)).toBeGreaterThanOrEqual(trophy.progress(before));
    }
  });
});

describe('satisfiedTiers', () => {
  it('finds nothing for a fresh player', () => {
    expect(satisfiedTiers(createEmptyStats())).toEqual([]);
  });

  it('awards the first game and nothing else', () => {
    expect(satisfiedTiers(statsWith({ gamesPlayed: 1 }))).toEqual(['first-game:1']);
  });

  it('includes every rung below the one reached, not just the highest', () => {
    const ids = satisfiedTiers(statsWith({ gamesPlayed: 150 }));
    expect(ids).toContain('table-regular:10');
    expect(ids).toContain('table-regular:50');
    expect(ids).toContain('table-regular:150');
    expect(ids).not.toContain('table-regular:400');
  });

  it('reads the streak record rather than the live streak', () => {
    // A player mid-losing-streak keeps the run they already had.
    const ids = satisfiedTiers(statsWith({ longestWinStreak: 10, currentStreak: -4 }));
    expect(ids).toContain('on-a-roll:5');
    expect(ids).toContain('on-a-roll:10');
    expect(ids).not.toContain('on-a-roll:15');
  });

  it('gives a veteran their whole back catalogue with no backfill', () => {
    const ids = satisfiedTiers(veteran);
    expect(ids).toEqual([
      'first-game:1',
      'first-win:1',
      'table-regular:10',
      'table-regular:50',
      'table-regular:150',
      'winning-habit:5',
      'winning-habit:25',
      'winning-habit:75',
      'on-a-roll:5',
      'on-a-roll:10',
    ]);
  });

  it('leaves the top rung of every ladder above the heaviest current player', () => {
    // The ceiling check: 100+ games is the current hardcore mark, and a player
    // there must not open the tab already complete.
    const hardcore = statsWith({ gamesPlayed: 120, wins: 60, longestWinStreak: 12 });
    expect(satisfiedTiers(hardcore)).not.toContain('table-regular:400');
    expect(satisfiedTiers(hardcore)).not.toContain('winning-habit:200');
    expect(satisfiedTiers(hardcore)).not.toContain('on-a-roll:20');
  });
});

describe('awardTrophies', () => {
  it('seeds an existing player silently', () => {
    const { state, newly } = awardTrophies(createEmptyTrophyState(), veteran, 'T0');
    expect(newly).toEqual([]);
    expect(state.seeded).toBe(true);
    expect(earnedCount(state)).toBe(10);
  });

  it('announces normally once seeded', () => {
    const seeded = awardTrophies(createEmptyTrophyState(), veteran, 'T0').state;
    const { newly } = awardTrophies(seeded, { ...veteran, gamesPlayed: 400 }, 'T1');
    expect(newly).toEqual(['table-regular:400']);
  });

  it("does not swallow a brand-new player's first trophy", () => {
    // The seeding run happens at mount, against stats that predate the
    // session — so a fresh player seeds *nothing* and their first finished
    // game still announces.
    const seeded = awardTrophies(createEmptyTrophyState(), createEmptyStats(), 'T0').state;
    expect(earnedCount(seeded)).toBe(0);

    const { newly } = awardTrophies(seeded, statsWith({ gamesPlayed: 1 }), 'T1');
    expect(newly).toEqual(['first-game:1']);
  });

  it('announces several tiers at once when one game crosses two', () => {
    const seeded = awardTrophies(createEmptyTrophyState(), createEmptyStats(), 'T0').state;
    const { newly } = awardTrophies(seeded, statsWith({ gamesPlayed: 1, wins: 1 }), 'T1');
    expect(newly).toEqual(['first-game:1', 'first-win:1']);
  });

  it('is idempotent — the same stats twice announce once', () => {
    const seeded = awardTrophies(createEmptyTrophyState(), createEmptyStats(), 'T0').state;
    const first = awardTrophies(seeded, statsWith({ gamesPlayed: 1 }), 'T1');
    expect(first.newly).toEqual(['first-game:1']);
    const second = awardTrophies(first.state, statsWith({ gamesPlayed: 1 }), 'T2');
    expect(second.newly).toEqual([]);
  });

  it('is sticky: an earned tier survives stats that no longer satisfy it', () => {
    // Nothing in this set can regress, but the next ones can (a win rate, a
    // losing streak), and the storage contract has to hold for them too.
    const earned = awardTrophies(createEmptyTrophyState(), veteran, 'T0').state;
    const { state, newly } = awardTrophies(earned, createEmptyStats(), 'T1');
    expect(newly).toEqual([]);
    expect(earnedCount(state)).toBe(10);
    expect(state.earned['table-regular:150']).toBe('T0');
  });

  it('stamps each tier with when it was earned, and leaves older stamps alone', () => {
    const seeded = awardTrophies(createEmptyTrophyState(), createEmptyStats(), 'T0').state;
    const one = awardTrophies(seeded, statsWith({ gamesPlayed: 1 }), 'T1').state;
    const two = awardTrophies(one, statsWith({ gamesPlayed: 10 }), 'T2').state;
    expect(two.earned['first-game:1']).toBe('T1');
    expect(two.earned['table-regular:10']).toBe('T2');
  });

  it('never mutates the state it is given', () => {
    const seeded = awardTrophies(createEmptyTrophyState(), createEmptyStats(), 'T0').state;
    const snapshot = JSON.stringify(seeded);
    awardTrophies(seeded, veteran, 'T1');
    expect(JSON.stringify(seeded)).toBe(snapshot);
  });
});

describe('storage', () => {
  it('round-trips through a storage backend', () => {
    const store = memoryStorage();
    const { state } = awardTrophies(createEmptyTrophyState(), veteran, 'T0');
    saveTrophies(state, store);
    expect(loadTrophies(store)).toEqual(state);
  });

  it('returns an empty state with no storage at all', () => {
    expect(loadTrophies(null)).toEqual(createEmptyTrophyState());
    expect(() => saveTrophies(createEmptyTrophyState(), null)).not.toThrow();
  });

  it('survives corrupt stored JSON', () => {
    const store = memoryStorage({ [TROPHIES_STORAGE_KEY]: '{not json' });
    expect(loadTrophies(store)).toEqual(createEmptyTrophyState());
  });

  it('merges a partial saved shape over the empty one', () => {
    const store = memoryStorage({ [TROPHIES_STORAGE_KEY]: JSON.stringify({ earned: { 'first-game:1': 'T0' } }) });
    const loaded = loadTrophies(store);
    expect(loaded.seeded).toBe(false);
    expect(loaded.earned).toEqual({ 'first-game:1': 'T0' });
  });

  it('forgets everything on reset', () => {
    const store = memoryStorage();
    syncTrophies(veteran, store, 'T0');
    expect(earnedCount(loadTrophies(store))).toBe(10);
    expect(resetTrophies(store)).toEqual(createEmptyTrophyState());
    expect(loadTrophies(store)).toEqual(createEmptyTrophyState());
  });
});

describe('syncTrophies', () => {
  it('seeds on the first call and announces on the next', () => {
    const store = memoryStorage();
    expect(syncTrophies(veteran, store, 'T0').newly).toEqual([]);
    expect(syncTrophies({ ...veteran, gamesPlayed: 400 }, store, 'T1').newly)
      .toEqual(['table-regular:400']);
  });

  it('persists between calls', () => {
    const store = memoryStorage();
    syncTrophies(statsWith({ gamesPlayed: 1 }), store, 'T0');
    expect(loadTrophies(store).seeded).toBe(true);
  });
});

describe('describeTier', () => {
  it('labels a single-tier trophy with its blurb', () => {
    expect(describeTier('first-win:1')).toMatchObject({
      name: 'First Peg Home',
      label: 'Win a game.',
    });
  });

  it('labels a ladder rung with where on it you landed', () => {
    expect(describeTier('table-regular:150')).toMatchObject({
      name: 'Table Regular',
      tier: 150,
      label: '150 games',
    });
    expect(describeTier('on-a-roll:20').label).toBe('20 in a row');
  });

  it('returns null for an id that is no longer in the catalogue', () => {
    expect(describeTier('table-regular:999')).toBeNull();
    expect(describeTier('nonsense')).toBeNull();
  });
});

describe('trophyRows', () => {
  it('gives one row per trophy', () => {
    const rows = trophyRows(createEmptyStats(), createEmptyTrophyState());
    expect(rows).toHaveLength(TROPHIES.length);
  });

  it('shows a fresh player every row with its first rung as the target', () => {
    const rows = trophyRows(createEmptyStats(), createEmptyTrophyState());
    const regular = rows.find((r) => r.trophy.id === 'table-regular');
    expect(regular.level).toBe(0);
    expect(regular.nextTier).toBe(10);
    expect(regular.complete).toBe(false);
    expect(regular.fraction).toBe(0);
  });

  it('reports the level from the sticky state and the progress from live stats', () => {
    const { state } = awardTrophies(createEmptyTrophyState(), veteran, 'T0');
    const rows = trophyRows(veteran, state);
    const regular = rows.find((r) => r.trophy.id === 'table-regular');
    expect(regular.level).toBe(3);
    expect(regular.maxLevel).toBe(4);
    expect(regular.value).toBe(180);
    expect(regular.nextTier).toBe(400);
    expect(regular.earnedAt).toBe('T0');
  });

  it('marks a finished ladder complete with a full bar', () => {
    const maxed = statsWith({ gamesPlayed: 500, wins: 300, longestWinStreak: 25 });
    const { state } = awardTrophies(createEmptyTrophyState(), maxed, 'T0');
    for (const row of trophyRows(maxed, state)) {
      expect(row.complete).toBe(true);
      expect(row.nextTier).toBeNull();
      expect(row.fraction).toBe(1);
      expect(row.level).toBe(row.maxLevel);
    }
  });

  it('never reports a fraction outside 0..1', () => {
    const rows = trophyRows(statsWith({ gamesPlayed: 9999, wins: 9999, longestWinStreak: 9999 }), createEmptyTrophyState());
    for (const row of rows) {
      expect(row.fraction).toBeGreaterThanOrEqual(0);
      expect(row.fraction).toBeLessThanOrEqual(1);
    }
  });
});

describe('tierId', () => {
  it('composes an id that describeTier can read back', () => {
    expect(tierId('table-regular', 50)).toBe('table-regular:50');
    expect(describeTier(tierId('table-regular', 50)).tier).toBe(50);
  });
});
