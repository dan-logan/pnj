// Player statistics for Pegs and Jokers, persisted to localStorage.
//
// All the record/derive logic is pure and takes a stats object as input so it
// can be unit-tested without a browser. load/save/reset accept an optional
// storage argument (defaulting to window.localStorage) and are no-ops when no
// storage is available (e.g. server-side or a private-mode failure).

import { GAME_MODES, TEAMS } from './constants.js';

export const STATS_STORAGE_KEY = 'pnj:playerStats:v1';

// Ids of games already folded into the stats, so a finished game can never be
// recorded twice — see recordFinishedGame. Capped and FIFO-trimmed; the ids are
// only ever tested for membership, so old ones can be forgotten safely.
export const RECORDED_GAMES_STORAGE_KEY = 'pnj:recordedGames:v1';
export const MAX_RECORDED_GAMES = 100;

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
      // Forget which games were recorded too, so a reset really is a reset.
      store.removeItem(RECORDED_GAMES_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return createEmptyStats();
}

// --- Who won ---
//
// `winner` means different things per mode: in classic it is a player index, in
// partner mode it is a *team* index. Everything that interprets a winner must
// go through these two helpers rather than comparing to 0.

// The seats that make up the winning side.
export function winningSeats(winner, mode = GAME_MODES.CLASSIC) {
  if (winner === null || winner === undefined) return [];
  if (mode === GAME_MODES.PARTNERS) return [...(TEAMS[winner] ?? [])];
  return [winner];
}

// True when one of the seats you control is on the winning side. This is what
// gives you credit when your *partner's* move is the one that wins the game.
export function didIWin(winner, mode = GAME_MODES.CLASSIC, mySeats = [0]) {
  if (winner === null || winner === undefined) return false;
  return winningSeats(winner, mode).some((seat) => mySeats.includes(seat));
}

// A fresh id for a locally-started game. Remote games use their server row id.
export function newGameId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Fold a finished game into the stats and return a new stats object. Never
// mutates the input.
//
// result: {
//   won: boolean,
//   winner: number,          // classic: the winning player. partners: the winning team
//   mySeats: number[],       // the seats you control (defaults to [0])
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
    mySeats = [0],
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
    // Credit every opponent on the winning side, not just `winner`. In partner
    // mode `winner` is a team index, so losing to Blue + Green used to record a
    // single loss against "Blue" (team 1's first member) and none against
    // Green. Both of them beat you, so both get the credit — which means these
    // buckets can sum to more than `losses` in partner mode. That is fine:
    // getNemesis asks "who beats me most often", not "how many games did I
    // lose".
    for (const seat of winningSeats(winner, mode)) {
      if (mySeats.includes(seat)) continue; // never your own side
      if (seat in next.lossesByOpponent) {
        next.lossesByOpponent[seat] += 1;
      }
    }
  }

  // A remote game passes `startMode: null` (host-only concept — the guest
  // never chose, and the host's remote deal doesn't offer the spinner either),
  // so it counts toward neither bucket rather than defaulting into "chosen".
  if (startMode === 'chosen' || startMode === 'random') {
    const bucket = startMode === 'random' ? next.randomFirst : next.chosenFirst;
    bucket.games += 1;
    if (won) bucket.wins += 1;
  }

  const modeBucket = mode === 'partners' ? next.partnerGames : next.soloGames;
  modeBucket.games += 1;
  if (won) modeBucket.wins += 1;

  return next;
}

// --- Idempotent recording, keyed by game id ---
//
// Stats used to be folded in by watching the `winner` state *transition*, which
// only works if this client happens to be open at the moment the game ends. A
// finished game is a fact about the game, not about who was watching, so record
// from the terminal state and dedupe on the game's id instead: a game recorded
// once stays recorded however many times its end is observed.

export function loadRecordedGames(storage) {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(RECORDED_GAMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function hasRecordedGame(gameId, storage) {
  if (!gameId) return false;
  return loadRecordedGames(storage).includes(gameId);
}

// Remembers `gameId`, dropping the oldest ids once the list is full.
export function markGameRecorded(gameId, storage) {
  const store = resolveStorage(storage);
  const ids = loadRecordedGames(storage);
  if (!gameId || ids.includes(gameId)) return ids;
  const next = [...ids, gameId].slice(-MAX_RECORDED_GAMES);
  if (store) {
    try {
      store.setItem(RECORDED_GAMES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked — stats are non-critical, so ignore.
    }
  }
  return next;
}

// Fold a finished game into the persisted stats exactly once. Returns the stats
// to display and whether this call was the one that recorded them. Safe to call
// from every place a terminal state is observed: the win itself, a resumed
// game that turns out to be over, or (later) a finished state arriving from the
// network.
export function recordFinishedGame(gameId, result, storage) {
  const current = loadStats(storage);
  if (!gameId || hasRecordedGame(gameId, storage)) {
    return { stats: current, recorded: false };
  }
  const updated = recordGame(current, result);
  saveStats(updated, storage);
  markGameRecorded(gameId, storage);
  return { stats: updated, recorded: true };
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
