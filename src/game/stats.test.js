import { describe, it, expect, beforeEach } from 'vitest';
import {
  STATS_STORAGE_KEY,
  createEmptyStats,
  loadStats,
  saveStats,
  resetStats,
  recordGame,
  winRate,
  averageTurns,
  bucketWinRate,
  formatStreak,
  getNemesis,
  didIWin,
  winningSeats,
  newGameId,
  recordFinishedGame,
  loadRecordedGames,
  hasRecordedGame,
  markGameRecorded,
  RECORDED_GAMES_STORAGE_KEY,
  MAX_RECORDED_GAMES,
} from './stats.js';
import { GAME_MODES } from './constants.js';

// Minimal in-memory Storage stand-in so the pure logic can be tested without a
// real browser localStorage.
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const win = (over = {}) => ({ won: true, winner: 0, turns: 20, startMode: 'chosen', ...over });
const loss = (over = {}) => ({ won: false, winner: 1, turns: 30, startMode: 'chosen', ...over });

describe('createEmptyStats', () => {
  it('starts everything at zero', () => {
    const s = createEmptyStats();
    expect(s.gamesPlayed).toBe(0);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.currentStreak).toBe(0);
    expect(s.fastestWinTurns).toBeNull();
    expect(s.lossesByOpponent).toEqual({ 1: 0, 2: 0, 3: 0 });
  });
});

describe('recordGame', () => {
  it('does not mutate the input stats', () => {
    const s = createEmptyStats();
    const snapshot = JSON.stringify(s);
    recordGame(s, win());
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('counts a win and a loss', () => {
    let s = createEmptyStats();
    s = recordGame(s, win());
    s = recordGame(s, loss());
    expect(s.gamesPlayed).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
  });

  it('builds a positive streak on consecutive wins', () => {
    let s = createEmptyStats();
    s = recordGame(s, win());
    s = recordGame(s, win());
    s = recordGame(s, win());
    expect(s.currentStreak).toBe(3);
    expect(s.longestWinStreak).toBe(3);
  });

  it('resets to a loss streak after a loss and remembers the best win streak', () => {
    let s = createEmptyStats();
    s = recordGame(s, win());
    s = recordGame(s, win());
    s = recordGame(s, loss());
    s = recordGame(s, loss());
    expect(s.currentStreak).toBe(-2);
    expect(s.longestWinStreak).toBe(2);
  });

  it('tracks the fastest win by turn count and ignores losses', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ turns: 40 }));
    s = recordGame(s, loss({ turns: 5 })); // fast, but a loss — must not count
    s = recordGame(s, win({ turns: 25 }));
    expect(s.fastestWinTurns).toBe(25);
  });

  it('ignores an impossibly short win (corrupt turn tally) for fastest win', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ turns: 30 }));
    // A game resumed from a snapshot with a lost turn tally records turns: 1.
    // That's shorter than any real game and must not become the fastest win.
    s = recordGame(s, win({ turns: 1 }));
    expect(s.fastestWinTurns).toBe(30);
    // Even from a clean slate, a bogus 1-turn win leaves fastest win unset.
    let fresh = createEmptyStats();
    fresh = recordGame(fresh, win({ turns: 1 }));
    expect(fresh.fastestWinTurns).toBeNull();
  });

  it('accumulates joker and bump tallies', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ jokersPlayed: 2, bumpsDelivered: 3, timesBumped: 1 }));
    s = recordGame(s, loss({ jokersPlayed: 1, bumpsDelivered: 0, timesBumped: 4 }));
    expect(s.jokersPlayed).toBe(3);
    expect(s.bumpsDelivered).toBe(3);
    expect(s.timesBumped).toBe(5);
  });

  it('splits games by how the first player was chosen', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ startMode: 'chosen' }));
    s = recordGame(s, loss({ startMode: 'chosen' }));
    s = recordGame(s, win({ startMode: 'random' }));
    expect(s.chosenFirst).toEqual({ games: 2, wins: 1 });
    expect(s.randomFirst).toEqual({ games: 1, wins: 1 });
  });

  it('counts a remote game (startMode: null) toward neither bucket', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ startMode: null }));
    s = recordGame(s, loss({ startMode: null }));
    expect(s.chosenFirst).toEqual({ games: 0, wins: 0 });
    expect(s.randomFirst).toEqual({ games: 0, wins: 0 });
    // The game itself still counts everywhere else.
    expect(s.gamesPlayed).toBe(2);
  });

  it('splits games by game mode, defaulting to solo', () => {
    let s = createEmptyStats();
    s = recordGame(s, win()); // no mode -> solo
    s = recordGame(s, loss({ mode: 'classic' }));
    s = recordGame(s, win({ mode: 'partners' }));
    s = recordGame(s, win({ mode: 'partners' }));
    expect(s.soloGames).toEqual({ games: 2, wins: 1 });
    expect(s.partnerGames).toEqual({ games: 2, wins: 2 });
  });

  it('attributes losses to the winning opponent', () => {
    let s = createEmptyStats();
    s = recordGame(s, loss({ winner: 2 }));
    s = recordGame(s, loss({ winner: 2 }));
    s = recordGame(s, loss({ winner: 3 }));
    expect(s.lossesByOpponent).toEqual({ 1: 0, 2: 2, 3: 1 });
  });

  it('sums turns across all games including losses', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ turns: 20 }));
    s = recordGame(s, loss({ turns: 30 }));
    expect(s.totalTurns).toBe(50);
  });
});

describe('derived helpers', () => {
  it('winRate is 0 with no games and a fraction otherwise', () => {
    expect(winRate(createEmptyStats())).toBe(0);
    let s = createEmptyStats();
    s = recordGame(s, win());
    s = recordGame(s, loss());
    s = recordGame(s, loss());
    expect(winRate(s)).toBeCloseTo(1 / 3);
  });

  it('averageTurns divides total turns by games played', () => {
    let s = createEmptyStats();
    s = recordGame(s, win({ turns: 10 }));
    s = recordGame(s, loss({ turns: 30 }));
    expect(averageTurns(s)).toBe(20);
  });

  it('bucketWinRate handles empty buckets', () => {
    expect(bucketWinRate({ games: 0, wins: 0 })).toBe(0);
    expect(bucketWinRate({ games: 4, wins: 1 })).toBe(0.25);
  });

  it('formatStreak renders wins, losses, and none', () => {
    expect(formatStreak(3)).toBe('W3');
    expect(formatStreak(-2)).toBe('L2');
    expect(formatStreak(0)).toBe('—');
  });

  it('getNemesis returns the opponent with the most wins over you', () => {
    let s = createEmptyStats();
    expect(getNemesis(s)).toBeNull();
    s = recordGame(s, loss({ winner: 1 }));
    s = recordGame(s, loss({ winner: 3 }));
    s = recordGame(s, loss({ winner: 3 }));
    expect(getNemesis(s)).toEqual({ player: 3, losses: 2 });
  });
});

describe('persistence', () => {
  it('returns empty stats when nothing is saved', () => {
    const storage = memoryStorage();
    expect(loadStats(storage)).toEqual(createEmptyStats());
  });

  it('round-trips through save and load', () => {
    const storage = memoryStorage();
    let s = createEmptyStats();
    s = recordGame(s, win({ jokersPlayed: 1 }));
    saveStats(s, storage);
    expect(loadStats(storage)).toEqual(s);
  });

  it('merges partial saved data over the current shape', () => {
    const storage = memoryStorage({
      [STATS_STORAGE_KEY]: JSON.stringify({ gamesPlayed: 5, wins: 3 }),
    });
    const loaded = loadStats(storage);
    expect(loaded.gamesPlayed).toBe(5);
    expect(loaded.wins).toBe(3);
    // Fields absent from the saved blob fall back to defaults.
    expect(loaded.losses).toBe(0);
    expect(loaded.lossesByOpponent).toEqual({ 1: 0, 2: 0, 3: 0 });
  });

  it('falls back to empty stats on corrupt data', () => {
    const storage = memoryStorage({ [STATS_STORAGE_KEY]: 'not json{' });
    expect(loadStats(storage)).toEqual(createEmptyStats());
  });

  it('resetStats clears storage and returns empty stats', () => {
    const storage = memoryStorage();
    saveStats(recordGame(createEmptyStats(), win()), storage);
    const cleared = resetStats(storage);
    expect(cleared).toEqual(createEmptyStats());
    expect(loadStats(storage)).toEqual(createEmptyStats());
  });

  it('does not throw when no storage is available', () => {
    expect(() => saveStats(createEmptyStats(), null)).not.toThrow();
    expect(loadStats(null)).toEqual(createEmptyStats());
  });
});

describe('didIWin', () => {
  it('is false with no winner', () => {
    expect(didIWin(null, GAME_MODES.CLASSIC, [0])).toBe(false);
    expect(didIWin(undefined, GAME_MODES.PARTNERS, [0])).toBe(false);
  });

  it('compares against the player index in classic mode', () => {
    expect(didIWin(0, GAME_MODES.CLASSIC, [0])).toBe(true);
    expect(didIWin(1, GAME_MODES.CLASSIC, [0])).toBe(false);
    expect(didIWin(2, GAME_MODES.CLASSIC, [2])).toBe(true);
  });

  it('compares against the team in partner mode', () => {
    // `winner` is a team index there: team 0 is seats 0 + 2.
    expect(didIWin(0, GAME_MODES.PARTNERS, [0])).toBe(true);
    expect(didIWin(0, GAME_MODES.PARTNERS, [1])).toBe(false);
    expect(didIWin(1, GAME_MODES.PARTNERS, [1])).toBe(true);
    expect(didIWin(1, GAME_MODES.PARTNERS, [3])).toBe(true);
  });

  it('gives the partner credit when their move wins the game', () => {
    // The guest sits in seat 2; team 0 winning is their win even though the
    // winning move was made by seat 0.
    expect(didIWin(0, GAME_MODES.PARTNERS, [2])).toBe(true);
  });

  it('would be wrong as `winner === 0` for a human in seat 1 or 3', () => {
    expect(didIWin(1, GAME_MODES.PARTNERS, [3])).toBe(true);
    expect(didIWin(0, GAME_MODES.PARTNERS, [3])).toBe(false);
  });

  it('handles a client controlling more than one seat', () => {
    expect(didIWin(1, GAME_MODES.CLASSIC, [0, 2])).toBe(false);
    expect(didIWin(2, GAME_MODES.CLASSIC, [0, 2])).toBe(true);
  });
});

describe('winningSeats', () => {
  it('is the single player in classic mode', () => {
    expect(winningSeats(1, GAME_MODES.CLASSIC)).toEqual([1]);
  });

  it('is both team members in partner mode', () => {
    expect(winningSeats(0, GAME_MODES.PARTNERS)).toEqual([0, 2]);
    expect(winningSeats(1, GAME_MODES.PARTNERS)).toEqual([1, 3]);
  });

  it('is empty with no winner', () => {
    expect(winningSeats(null, GAME_MODES.PARTNERS)).toEqual([]);
  });
});

describe('nemesis in partner mode', () => {
  it('credits both members of the winning team, not just the team index', () => {
    // The pre-existing bug: `lossesByOpponent[winner]++` with winner = team 1
    // recorded one loss against Blue (player 1) and none against Green.
    let s = createEmptyStats();
    s = recordGame(s, loss({ winner: 1, mode: 'partners' }));
    expect(s.lossesByOpponent).toEqual({ 1: 1, 2: 0, 3: 1 });
  });

  it('never credits your own partner', () => {
    // You are the guest in seat 2, so team 1 (Blue + Green) beat you.
    let s = createEmptyStats();
    s = recordGame(s, loss({ winner: 1, mode: 'partners', mySeats: [2] }));
    expect(s.lossesByOpponent).toEqual({ 1: 1, 2: 0, 3: 1 });

    // And a human in seat 3 losing to team 0 credits only Yellow — seat 1 is
    // their own partner, and seat 0's bucket does not exist.
    let t = createEmptyStats();
    t = recordGame(t, loss({ winner: 0, mode: 'partners', mySeats: [3] }));
    expect(t.lossesByOpponent).toEqual({ 1: 0, 2: 1, 3: 0 });
  });

  it('leaves classic mode exactly as it was', () => {
    let s = createEmptyStats();
    s = recordGame(s, loss({ winner: 2 }));
    s = recordGame(s, loss({ winner: 2 }));
    s = recordGame(s, loss({ winner: 3 }));
    expect(s.lossesByOpponent).toEqual({ 1: 0, 2: 2, 3: 1 });
    expect(getNemesis(s)).toEqual({ player: 2, losses: 2 });
  });

  it('surfaces the right nemesis after partner-mode losses', () => {
    let s = createEmptyStats();
    s = recordGame(s, loss({ winner: 1, mode: 'partners' }));
    s = recordGame(s, loss({ winner: 1, mode: 'partners' }));
    s = recordGame(s, loss({ winner: 2 })); // classic loss to Pink
    // Blue and Green are tied on 2; the first one found wins the tie-break.
    expect(getNemesis(s)).toEqual({ player: 1, losses: 2 });
  });
});

describe('recordFinishedGame', () => {
  it('records a game once', () => {
    const store = memoryStorage();
    const r = recordFinishedGame('game-a', win(), store);
    expect(r.recorded).toBe(true);
    expect(r.stats.gamesPlayed).toBe(1);
    expect(loadStats(store).gamesPlayed).toBe(1);
  });

  it('is a no-op the second time the same game ends', () => {
    // Reopening a finished game, or a partner's winning move arriving twice,
    // must not double-count it.
    const store = memoryStorage();
    recordFinishedGame('game-a', win(), store);
    const again = recordFinishedGame('game-a', win(), store);
    expect(again.recorded).toBe(false);
    expect(again.stats.gamesPlayed).toBe(1);
    expect(loadStats(store).gamesPlayed).toBe(1);
  });

  it('still returns the current stats when it skips', () => {
    const store = memoryStorage();
    recordFinishedGame('game-a', win(), store);
    recordFinishedGame('game-b', loss(), store);
    const again = recordFinishedGame('game-a', win(), store);
    expect(again.stats.gamesPlayed).toBe(2);
    expect(again.stats.wins).toBe(1);
    expect(again.stats.losses).toBe(1);
  });

  it('records different games independently', () => {
    const store = memoryStorage();
    recordFinishedGame('game-a', win(), store);
    recordFinishedGame('game-b', win(), store);
    expect(loadStats(store).gamesPlayed).toBe(2);
  });

  it('refuses to record without an id rather than recording blind', () => {
    const store = memoryStorage();
    const r = recordFinishedGame(null, win(), store);
    expect(r.recorded).toBe(false);
    expect(loadStats(store).gamesPlayed).toBe(0);
  });

  it('survives a lost stats file (the id list is what dedupes)', () => {
    const store = memoryStorage();
    recordFinishedGame('game-a', win(), store);
    store.removeItem(STATS_STORAGE_KEY);
    const again = recordFinishedGame('game-a', win(), store);
    expect(again.recorded).toBe(false);
  });
});

describe('recorded game ids', () => {
  it('starts empty and ignores junk', () => {
    expect(loadRecordedGames(memoryStorage())).toEqual([]);
    expect(loadRecordedGames(memoryStorage({ [RECORDED_GAMES_STORAGE_KEY]: 'not json' }))).toEqual([]);
    expect(loadRecordedGames(memoryStorage({ [RECORDED_GAMES_STORAGE_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it('remembers ids and reports membership', () => {
    const store = memoryStorage();
    markGameRecorded('x', store);
    expect(hasRecordedGame('x', store)).toBe(true);
    expect(hasRecordedGame('y', store)).toBe(false);
    expect(hasRecordedGame(null, store)).toBe(false);
  });

  it('does not duplicate an id it already holds', () => {
    const store = memoryStorage();
    markGameRecorded('x', store);
    markGameRecorded('x', store);
    expect(loadRecordedGames(store)).toEqual(['x']);
  });

  it('drops the oldest ids past the cap', () => {
    const store = memoryStorage();
    for (let i = 0; i < MAX_RECORDED_GAMES + 5; i++) markGameRecorded(`g${i}`, store);
    const ids = loadRecordedGames(store);
    expect(ids).toHaveLength(MAX_RECORDED_GAMES);
    expect(ids[0]).toBe('g5');
    expect(ids.at(-1)).toBe(`g${MAX_RECORDED_GAMES + 4}`);
  });

  it('is cleared by resetting stats', () => {
    const store = memoryStorage();
    recordFinishedGame('game-a', win(), store);
    resetStats(store);
    expect(loadRecordedGames(store)).toEqual([]);
  });
});

describe('newGameId', () => {
  it('gives every game a distinct id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newGameId()));
    expect(ids.size).toBe(50);
  });
});
