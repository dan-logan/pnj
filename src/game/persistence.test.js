import { describe, it, expect } from 'vitest';
import {
  SAVE_STORAGE_KEY,
  serializeGame,
  isResumable,
  saveGame,
  loadGame,
  clearGame,
} from './persistence.js';
import { createInitialPegs } from './engine.js';

// Minimal in-memory Storage stand-in so the logic can be tested without a real
// browser localStorage.
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// A representative mid-game state.
const sampleState = (over = {}) => ({
  pegs: createInitialPegs(),
  hands: [
    [{ rank: 'A', suit: '♠', id: 'A♠0' }],
    [{ rank: '7', suit: '♥', id: '7♥0' }],
    [{ rank: 'K', suit: '♦', id: 'K♦0' }],
    [{ rank: 'JOKER', suit: '🃏', id: 'JOKER1_0' }],
  ],
  deck: [{ rank: '5', suit: '♣', id: '5♣1' }],
  discardPiles: [[], [], [], []],
  stuckCounts: [0, 1, 0, 2],
  currentPlayer: 2,
  splitRemaining: 3,
  splitCard: { rank: '7', suit: '♥', id: '7♥0' },
  splitPegIndex: 1,
  lastMoves: ['moved', null, null, null],
  moveHistory: [],
  turns: 5,
  jokersPlayed: 1,
  bumpsDelivered: 2,
  timesBumped: 0,
  startMode: 'random',
  ...over,
});

describe('serializeGame', () => {
  it('captures all the fields needed to resume', () => {
    const snap = serializeGame(sampleState());
    expect(snap.version).toBe(2);
    expect(typeof snap.savedAt).toBe('number');
    expect(snap.currentPlayer).toBe(2);
    expect(snap.splitRemaining).toBe(3);
    expect(snap.splitCard.id).toBe('7♥0');
    expect(snap.tallies).toEqual({
      turns: 5,
      jokersPlayed: 1,
      bumpsDelivered: 2,
      timesBumped: 0,
      startMode: 'random',
    });
  });

  it('fills sane defaults for optional fields', () => {
    const snap = serializeGame({
      pegs: createInitialPegs(),
      hands: [[], [], [], []],
      deck: [],
      discardPiles: [[], [], [], []],
      stuckCounts: [0, 0, 0, 0],
      currentPlayer: 0,
    });
    expect(snap.splitRemaining).toBe(0);
    expect(snap.splitCard).toBeNull();
    expect(snap.lastMoves).toEqual([null, null, null, null]);
    expect(snap.tallies.startMode).toBe('chosen');
  });
});

describe('isResumable', () => {
  it('accepts a well-formed snapshot with dealt hands', () => {
    expect(isResumable(serializeGame(sampleState()))).toBe(true);
  });

  it('defaults mode to classic and records partner mode when set', () => {
    expect(serializeGame(sampleState()).mode).toBe('classic');
    expect(serializeGame(sampleState({ mode: 'partners' })).mode).toBe('partners');
  });

  it('still accepts a legacy v1 snapshot (loads as classic)', () => {
    const legacy = { ...serializeGame(sampleState()), version: 1 };
    delete legacy.mode;
    expect(isResumable(legacy)).toBe(true);
  });

  it('rejects junk and wrong versions', () => {
    expect(isResumable(null)).toBe(false);
    expect(isResumable({})).toBe(false);
    expect(isResumable({ ...serializeGame(sampleState()), version: 999 })).toBe(false);
  });

  it('rejects a snapshot where no cards were ever dealt', () => {
    const snap = serializeGame({
      pegs: createInitialPegs(),
      hands: [[], [], [], []],
      deck: [],
      discardPiles: [[], [], [], []],
      stuckCounts: [0, 0, 0, 0],
      currentPlayer: 0,
    });
    expect(isResumable(snap)).toBe(false);
  });

  it('rejects malformed peg/hand/currentPlayer shapes', () => {
    const good = serializeGame(sampleState());
    expect(isResumable({ ...good, pegs: [1, 2, 3] })).toBe(false);
    expect(isResumable({ ...good, hands: 'nope' })).toBe(false);
    expect(isResumable({ ...good, currentPlayer: 9 })).toBe(false);
  });
});

describe('save/load/clear round-trip', () => {
  it('saves and loads an equivalent snapshot', () => {
    const store = memoryStorage();
    saveGame(sampleState(), store);
    const loaded = loadGame(store);
    expect(loaded.currentPlayer).toBe(2);
    expect(loaded.hands[1][0].id).toBe('7♥0');
    expect(loaded.tallies.startMode).toBe('random');
  });

  it('loadGame returns null with no save', () => {
    expect(loadGame(memoryStorage())).toBeNull();
  });

  it('loadGame returns null for a corrupt payload', () => {
    const store = memoryStorage({ [SAVE_STORAGE_KEY]: '{not json' });
    expect(loadGame(store)).toBeNull();
  });

  it('clearGame removes the save', () => {
    const store = memoryStorage();
    saveGame(sampleState(), store);
    expect(loadGame(store)).not.toBeNull();
    clearGame(store);
    expect(loadGame(store)).toBeNull();
  });

  it('is a no-op without a storage backend', () => {
    expect(() => saveGame(sampleState(), null)).not.toThrow();
    expect(loadGame(null)).toBeNull();
    expect(() => clearGame(null)).not.toThrow();
  });
});

describe('game identity', () => {
  it('round-trips the game id so a resumed game keeps its identity', () => {
    // The id is what makes stats recording idempotent: resuming a game and
    // finishing it must not record a second result for the same game.
    const snap = serializeGame({ ...sampleState(), gameId: 'abc-123' });
    expect(snap.gameId).toBe('abc-123');
    const store = memoryStorage();
    saveGame({ ...sampleState(), gameId: 'abc-123' }, store);
    expect(loadGame(store).gameId).toBe('abc-123');
  });

  it('leaves the id null for a save made without one', () => {
    // Saves written before game ids existed still load; the app mints a fresh
    // id for them on resume.
    expect(serializeGame(sampleState()).gameId).toBeNull();
  });
});
