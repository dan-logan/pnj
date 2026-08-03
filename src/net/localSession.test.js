import { describe, it, expect } from 'vitest';
import {
  GAMES_STORAGE_KEY,
  emptyLocalGames,
  loadLocalGames,
  hasLocalGames,
  upsertLocalGame,
  updateLocalGame,
  archiveLocalGame,
  removeLocalGame,
  getLocalGame,
  getActiveId,
  setActiveId,
  activeLocalGames,
} from './localSession.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe('loadLocalGames', () => {
  it('returns the empty shape with no storage or no data', () => {
    expect(loadLocalGames(memoryStorage())).toEqual(emptyLocalGames());
  });

  it('is resilient to malformed data', () => {
    expect(loadLocalGames(memoryStorage({ [GAMES_STORAGE_KEY]: 'not json' }))).toEqual(emptyLocalGames());
    expect(loadLocalGames(memoryStorage({ [GAMES_STORAGE_KEY]: '{"games":"x"}' }))).toEqual(emptyLocalGames());
  });

  it('drops entries without an id and normalises the rest', () => {
    const store = memoryStorage({
      [GAMES_STORAGE_KEY]: JSON.stringify({
        version: 1,
        activeId: 'a',
        games: [{ id: 'a', seat: 2 }, { seat: 0 }, { id: 'b' }],
      }),
    });
    const data = loadLocalGames(store);
    expect(data.games.map((g) => g.id)).toEqual(['a', 'b']);
    expect(data.games[0]).toMatchObject({ id: 'a', seat: 2, archived: false });
    expect(data.games[1].seat).toBe(0); // default
  });
});

describe('upsert / update / archive / remove', () => {
  it('adds a game then merges fields on a second upsert', () => {
    const store = memoryStorage();
    upsertLocalGame({ id: 'g1', seat: 2, code: 'ABC234' }, store);
    let g = getLocalGame('g1', store);
    expect(g).toMatchObject({ id: 'g1', seat: 2, code: 'ABC234' });
    expect(g.label).toBe('ABC234'); // defaults to the code

    upsertLocalGame({ id: 'g1', label: 'Sara' }, store);
    g = getLocalGame('g1', store);
    expect(g.label).toBe('Sara');
    expect(g.seat).toBe(2); // preserved
  });

  it('updateLocalGame is a no-op for an unknown id', () => {
    const store = memoryStorage();
    updateLocalGame('ghost', { label: 'x' }, store);
    expect(loadLocalGames(store).games).toEqual([]);
  });

  it('archive hides from the lobby without deleting', () => {
    const store = memoryStorage();
    upsertLocalGame({ id: 'g1', createdAt: 1 }, store);
    archiveLocalGame('g1', store);
    expect(getLocalGame('g1', store).archived).toBe(true);
    expect(activeLocalGames(store)).toEqual([]);
  });

  it('remove clears the game and any activeId pointing at it', () => {
    const store = memoryStorage();
    upsertLocalGame({ id: 'g1' }, store);
    setActiveId('g1', store);
    removeLocalGame('g1', store);
    expect(getLocalGame('g1', store)).toBe(null);
    expect(getActiveId(store)).toBe(null);
  });
});

describe('activeLocalGames', () => {
  it('returns non-archived games newest first', () => {
    const store = memoryStorage();
    upsertLocalGame({ id: 'old', createdAt: 1 }, store);
    upsertLocalGame({ id: 'new', createdAt: 5 }, store);
    upsertLocalGame({ id: 'gone', createdAt: 3, archived: true }, store);
    expect(activeLocalGames(store).map((g) => g.id)).toEqual(['new', 'old']);
  });
});

describe('hasLocalGames — the §3.4 entry-point gate', () => {
  it('is false for a solo-only device, true once a remote game exists', () => {
    const store = memoryStorage();
    expect(hasLocalGames(store)).toBe(false);
    upsertLocalGame({ id: 'g1' }, store);
    expect(hasLocalGames(store)).toBe(true);
  });

  it('stays true even when the only game is archived (still on the device)', () => {
    const store = memoryStorage();
    upsertLocalGame({ id: 'g1', archived: true }, store);
    expect(hasLocalGames(store)).toBe(true);
  });
});

describe('activeId', () => {
  it('round-trips, and null means the solo game', () => {
    const store = memoryStorage();
    expect(getActiveId(store)).toBe(null);
    setActiveId('g1', store);
    expect(getActiveId(store)).toBe('g1');
    setActiveId(null, store);
    expect(getActiveId(store)).toBe(null);
  });
});
