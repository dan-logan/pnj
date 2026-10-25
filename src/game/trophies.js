// Trophies: milestones derived from the player's lifetime stats.
//
// Deliberately *not* called badges. `src/badge.js` is the home-screen app-icon
// badge (the waiting-on-you count) and the My Games button wears one too; this
// codebase keeps one word for one thing, so these are trophies everywhere —
// module, storage key and the tab the player reads.
//
// Every trophy in this first set is a **monotonic** predicate over counters
// that have been in `createEmptyStats()` since stats first shipped
// (`gamesPlayed`, `wins`, `longestWinStreak` — verified against the history).
// That is what makes the set retroactive without a backfill: a long-time
// player's trophies are simply *true of their stats* the moment this code
// first runs. There is nothing to migrate.
//
// The earned set is still persisted, for two reasons:
//
//   1. So the first run after the update can seed *silently*. Awarding and
//      announcing are otherwise the same code path, and a veteran would be
//      handed a dozen trophies at once. See `awardTrophies` and the `seeded`
//      flag — and note the seeding has to happen at mount, against the stats
//      as they were before this session, or a brand-new player's very first
//      trophy gets swallowed by its own backfill.
//   2. So a trophy stays earned. Nothing in this set can regress, but the
//      obvious next ones (a win rate, a losing streak) can, and a trophy that
//      un-earns itself is worse than one that was never offered.
//
// All the catalogue and fold logic is pure and takes a stats object as input,
// so it can be unit-tested without a browser. load/save/reset accept an
// optional storage argument (defaulting to window.localStorage) and are no-ops
// when no storage is available — the same pattern as stats.js.

export const TROPHIES_STORAGE_KEY = 'pnj:trophies:v1';

// --- The catalogue ---
//
// A trophy is one row in the tab that *fills up* through its tiers, rather
// than three rows that each light separately: five rows reads as a collection,
// fourteen reads as a chore list. `progress` is the counter the row tracks and
// `tiers` are the marks along it, ascending.
//
// The top tier of each ladder sits deliberately above the heaviest current
// player. Badges that award retroactively have a ceiling problem the ordinary
// kind doesn't: with the top rung at 100 games, every hardcore player opens
// this tab already complete on the day it ships, and the feature is finished
// before it starts for exactly the people it is meant to hold.
export const TROPHIES = [
  {
    id: 'first-game',
    name: 'Out of the Gate',
    blurb: 'Finish your first game, win or lose.',
    icon: '🎲',
    unit: 'games',
    tiers: [1],
    progress: (stats) => stats.gamesPlayed,
  },
  {
    id: 'first-win',
    name: 'First Peg Home',
    blurb: 'Win a game.',
    icon: '🏠',
    unit: 'wins',
    tiers: [1],
    progress: (stats) => stats.wins,
  },
  {
    id: 'table-regular',
    name: 'Table Regular',
    blurb: 'Keep coming back to the board.',
    icon: '🪑',
    unit: 'games',
    tiers: [10, 50, 150, 400],
    progress: (stats) => stats.gamesPlayed,
  },
  {
    id: 'winning-habit',
    name: 'Winning Habit',
    blurb: 'Pile up the wins.',
    icon: '🏆',
    unit: 'wins',
    tiers: [5, 25, 75, 200],
    progress: (stats) => stats.wins,
  },
  {
    id: 'on-a-roll',
    name: 'On a Roll',
    blurb: 'String wins together.',
    icon: '⚡',
    // Reads the *record*, not the live streak, which is what keeps this ladder
    // monotonic: a loss tomorrow can never take back a run you already had.
    unit: 'in a row',
    tiers: [5, 10, 15, 20],
    progress: (stats) => stats.longestWinStreak,
  },
];

// A single tier's id, which is what the earned set stores. Tiers are sticky
// individually, so "Table Regular 50" survives even if the trophy ever grows a
// tier below it.
export function tierId(trophyId, tier) {
  return `${trophyId}:${tier}`;
}

// Every tier in the catalogue, for "7 of 14" in the tab heading.
export function totalTiers() {
  return TROPHIES.reduce((n, t) => n + t.tiers.length, 0);
}

// --- Persisted state ---

export function createEmptyTrophyState() {
  return {
    version: 1,
    // False until the first sync has folded in whatever the player's existing
    // stats already deserve. Only a sync *after* that announces anything.
    seeded: false,
    earned: {}, // tierId -> ISO date string
  };
}

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function loadTrophies(storage) {
  const store = resolveStorage(storage);
  if (!store) return createEmptyTrophyState();
  try {
    const raw = store.getItem(TROPHIES_STORAGE_KEY);
    if (!raw) return createEmptyTrophyState();
    const parsed = JSON.parse(raw);
    const base = createEmptyTrophyState();
    // Merge over the empty shape so missing/renamed fields get sane defaults,
    // the same way loadStats does.
    return {
      ...base,
      ...parsed,
      seeded: parsed.seeded === true,
      earned: { ...base.earned, ...(parsed.earned || {}) },
    };
  } catch {
    return createEmptyTrophyState();
  }
}

export function saveTrophies(state, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(TROPHIES_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked — trophies are non-critical, so ignore.
  }
}

export function resetTrophies(storage) {
  const store = resolveStorage(storage);
  if (store) {
    try {
      store.removeItem(TROPHIES_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return createEmptyTrophyState();
}

// --- Awarding (pure) ---

// Every tier the stats currently satisfy, in catalogue order. Pure, and the
// only place the thresholds are compared.
export function satisfiedTiers(stats) {
  const ids = [];
  for (const trophy of TROPHIES) {
    const value = trophy.progress(stats);
    for (const tier of trophy.tiers) {
      if (value >= tier) ids.push(tierId(trophy.id, tier));
    }
  }
  return ids;
}

// Fold the stats into an earned set. Never mutates the input.
//
// Returns the next state and `newly` — the tiers to announce, which is empty
// on the seeding run however many the player turns out to have earned.
export function awardTrophies(state, stats, now = new Date().toISOString()) {
  const satisfied = satisfiedTiers(stats);
  const earned = { ...state.earned };
  const fresh = satisfied.filter((id) => !(id in earned));
  for (const id of fresh) earned[id] = now;

  return {
    state: { ...state, seeded: true, earned },
    newly: state.seeded ? fresh : [],
  };
}

// Load, fold, save. The one call the app makes: at mount (which seeds) and
// after each finished game (which announces). Idempotent — a second call with
// the same stats returns no new trophies, so it is safe wherever a terminal
// state can be observed more than once.
export function syncTrophies(stats, storage, now) {
  const { state, newly } = awardTrophies(loadTrophies(storage), stats, now);
  saveTrophies(state, storage);
  return { state, newly };
}

// --- Derived read helpers (all pure) ---

// How many tiers the player holds.
export function earnedCount(state) {
  return Object.keys(state.earned).length;
}

// Look a tier id back up in the catalogue, for the announcement on the result
// overlay. Returns { trophy, tier, name, icon, label } or null.
export function describeTier(id) {
  for (const trophy of TROPHIES) {
    for (const tier of trophy.tiers) {
      if (tierId(trophy.id, tier) === id) {
        return {
          trophy,
          tier,
          name: trophy.name,
          icon: trophy.icon,
          // Single-tier trophies are their own label; a ladder says where on
          // it you've landed ("150 games").
          label: trophy.tiers.length === 1 ? trophy.blurb : `${tier} ${trophy.unit}`,
        };
      }
    }
  }
  return null;
}

// One row per trophy for the tab: what's earned (from the sticky state, so a
// row can never go backwards) and how far along the next tier is (from the
// live stats).
export function trophyRows(stats, state) {
  return TROPHIES.map((trophy) => {
    const value = trophy.progress(stats);
    const earnedTiers = trophy.tiers.filter((tier) => tierId(trophy.id, tier) in state.earned);
    const nextTier = trophy.tiers.find((tier) => !(tierId(trophy.id, tier) in state.earned)) ?? null;
    const earnedAt = earnedTiers.length
      ? state.earned[tierId(trophy.id, earnedTiers[earnedTiers.length - 1])]
      : null;

    return {
      trophy,
      value,
      earnedTiers,
      level: earnedTiers.length,
      maxLevel: trophy.tiers.length,
      nextTier,
      complete: nextTier === null,
      // 0..1 toward the next tier, measured from the tier below it so a long
      // ladder's last rung doesn't read as nearly-done the whole way.
      fraction: nextTier === null
        ? 1
        : Math.max(0, Math.min(1, value / nextTier)),
      earnedAt,
    };
  });
}
