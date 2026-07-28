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
} from './stats.js';

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
