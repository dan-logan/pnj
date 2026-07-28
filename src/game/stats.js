// Player statistics for Pegs and Jokers, persisted to localStorage.
//
// All the record/derive logic is pure and takes a stats object as input so it
// can be unit-tested without a browser. load/save/reset accept an optional
// storage argument (defaulting to window.localStorage) and are no-ops when no
// storage is available (e.g. server-side or a private-mode failure).

export const STATS_STORAGE_KEY = 'pnj:playerStats:v1';

// The fewest turns any real game can possibly last. Winning means bringing all
// five of your pegs out of start and all the way home, so a genuine game runs
// well into the dozens (usually hundreds) of turns. A recorded "win" shorter
// than this can only mean the per-game turn tally was lost or corrupted — e.g. a
// game resumed from a snapshot whose stored turn count was missing or zero, which
// records `turns` as `1`. We refuse to let such a value poison the "fastest win"
// record (Topher's bug report: a fastest win of one turn, which is impossible).
export const MIN_PLAUSIBLE_WIN_TURNS = 5;

// A fresh stats object. Every field the app reads is defined here so that
// loadStats can safely merge older/partial saved data over this shape.
export function createEmptyStats() {
  return {
    version: 1,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    currentStreak: 0, // signed: >0 is a win streak, <0 is a loss streak
    longestWinStreak: 0,
    fastestWinTurns: null, // fewest total turns in a winning game
    totalTurns: 0, // summed across all games, for the average
    jokersPlayed: 0,
    bumpsDelivered: 0, // opponent pegs you sent home
    timesBumped: 0, // your pegs opponents sent home
    chosenFirst: { games: 0, wins: 0 }, // games where you took the first turn
    randomFirst: { games: 0, wins: 0 }, // games where first player was random
    soloGames: { games: 0, wins: 0 }, // classic mode (you vs 3 AI)
    partnerGames: { games: 0, wins: 0 }, // partner mode (you + partner vs 2 AI)
    lossesByOpponent: { 1: 0, 2: 0, 3: 0 }, // Blue, Pink, Green
  };
}

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function loadStats(storage) {
  const store = resolveStorage(storage);
  if (!store) return createEmptyStats();
  try {
    const raw = store.getItem(STATS_STORAGE_KEY);
    if (!raw) return createEmptyStats();
    const parsed = JSON.parse(raw);
    const base = createEmptyStats();
    // Merge over the empty shape so missing/renamed fields get sane defaults.
    return {
      ...base,
      ...parsed,
      chosenFirst: { ...base.chosenFirst, ...(parsed.chosenFirst || {}) },
      randomFirst: { ...base.randomFirst, ...(parsed.randomFirst || {}) },
      soloGames: { ...base.soloGames, ...(parsed.soloGames || {}) },
      partnerGames: { ...base.partnerGames, ...(parsed.partnerGames || {}) },
      lossesByOpponent: { ...base.lossesByOpponent, ...(parsed.lossesByOpponent || {}) },
    };
  } catch {
    return createEmptyStats();
  }
}

export function saveStats(stats, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Storage full or blocked — stats are non-critical, so ignore.
  }
}

export function resetStats(storage) {
  const store = resolveStorage(storage);
  if (store) {
    try {
      store.removeItem(STATS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return createEmptyStats();
}

// Fold a finished game into the stats and return a new stats object. Never
// mutates the input.
//
// result: {
//   won: boolean,
//   winner: number,          // 0 = you, 1/2/3 = the AI that won
//   turns: number,           // total turns taken in the game
//   startMode: 'chosen' | 'random',
//   mode: 'classic' | 'partners', // which game mode was played
//   jokersPlayed: number,    // jokers you played this game
//   bumpsDelivered: number,  // opponent pegs you bumped this game
//   timesBumped: number,     // your pegs bumped this game
// }
export function recordGame(stats, result) {
  const {
    won,
    winner,
    turns = 0,
    startMode = 'chosen',
    mode = 'classic',
    jokersPlayed = 0,
    bumpsDelivered = 0,
    timesBumped = 0,
  } = result;

  const next = {
    ...stats,
    chosenFirst: { ...stats.chosenFirst },
    randomFirst: { ...stats.randomFirst },
    soloGames: { ...stats.soloGames },
    partnerGames: { ...stats.partnerGames },
    lossesByOpponent: { ...stats.lossesByOpponent },
  };

  next.gamesPlayed += 1;
  next.totalTurns += turns;
  next.jokersPlayed += jokersPlayed;
  next.bumpsDelivered += bumpsDelivered;
  next.timesBumped += timesBumped;

  if (won) {
    next.wins += 1;
    next.currentStreak = next.currentStreak > 0 ? next.currentStreak + 1 : 1;
    if (next.currentStreak > next.longestWinStreak) {
      next.longestWinStreak = next.currentStreak;
    }
    // Only count plausible game lengths toward the fastest-win record. A turn
    // count below the floor is corrupt tally data, not a real lightning victory.
    if (turns >= MIN_PLAUSIBLE_WIN_TURNS &&
        (next.fastestWinTurns === null || turns < next.fastestWinTurns)) {
      next.fastestWinTurns = turns;
    }
  } else {
    next.losses += 1;
    next.currentStreak = next.currentStreak < 0 ? next.currentStreak - 1 : -1;
    if (winner in next.lossesByOpponent) {
      next.lossesByOpponent[winner] += 1;
    }
  }

  const bucket = startMode === 'random' ? next.randomFirst : next.chosenFirst;
  bucket.games += 1;
  if (won) bucket.wins += 1;

  const modeBucket = mode === 'partners' ? next.partnerGames : next.soloGames;
  modeBucket.games += 1;
  if (won) modeBucket.wins += 1;

  return next;
}

// --- Derived read helpers (all pure) ---

export function winRate(stats) {
  return stats.gamesPlayed ? stats.wins / stats.gamesPlayed : 0;
}

export function averageTurns(stats) {
  return stats.gamesPlayed ? stats.totalTurns / stats.gamesPlayed : 0;
}

export function bucketWinRate(bucket) {
  return bucket.games ? bucket.wins / bucket.games : 0;
}

// "W3", "L2", or "—" when there is no active streak.
export function formatStreak(streak) {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${-streak}`;
  return '—';
}

// The opponent that has beaten you most, or null if you've never lost.
// Returns { player, losses }.
export function getNemesis(stats) {
  let best = null;
  for (const [player, losses] of Object.entries(stats.lossesByOpponent)) {
    if (losses > 0 && (!best || losses > best.losses)) {
      best = { player: Number(player), losses };
    }
  }
  return best;
}
