import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __setBackend,
  signIn,
  createGame,
  joinGame,
  joinGameById,
  fetchGame,
  startGame,
  publishState,
  VersionConflict,
  GameNotFound,
} from './session.js';
import { STATUS, GUEST_SEAT, HOST_SEAT } from './protocol.js';

// A minimal in-memory stand-in for the Firestore backend, exercising the
// orchestration in session.js without the SDK or the emulator. Mirrors the
// primitive contract session.js depends on: create-only writes, read-modify-write
// transactions, and document/query listeners.
function fakeBackend({ uid = 'me' } = {}) {
  const docs = new Map();
  const listeners = []; // { path, cb }
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  let failCodesTimes = 0;

  const notify = (path) => {
    for (const l of listeners) {
      if (l.path === path) {
        const data = docs.has(path) ? clone(docs.get(path)) : null;
        l.cb({ exists: data != null, data, hasPendingWrites: false });
      }
    }
  };

  return {
    docs,
    setFailCodesTimes(n) { failCodesTimes = n; },
    async ensureUid() { return uid; },
    now() { return 1000; },
    async getDoc(path) { return docs.has(path) ? clone(docs.get(path)) : null; },
    async createDoc(path, data) {
      if (path.startsWith('codes/') && failCodesTimes > 0) {
        failCodesTimes -= 1;
        throw new Error('collision');
      }
      if (docs.has(path)) throw new Error('already exists');
      docs.set(path, clone(data));
      notify(path);
    },
    async runTransaction(fn) {
      const tx = {
        async get(path) { return docs.has(path) ? clone(docs.get(path)) : null; },
        set(path, data) { docs.set(path, clone(data)); },
      };
      const result = await fn(tx);
      // Notify after commit.
      for (const l of listeners) notify(l.path);
      return result;
    },
    onDoc(path, cb) {
      const entry = { path, cb };
      listeners.push(entry);
      // Deliver current value immediately, like Firestore.
      const data = docs.has(path) ? clone(docs.get(path)) : null;
      cb({ exists: data != null, data, hasPendingWrites: false });
      return () => {
        const i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    onMyGames(myUid, cb) {
      const emit = () => {
        const rows = [...docs.entries()]
          .filter(([p, d]) => /^games\/[^/]+$/.test(p) && d.participants?.includes(myUid))
          .map(([p, d]) => ({ id: p.split('/')[1], ...clone(d) }));
        cb(rows);
      };
      emit();
      return () => {};
    },
  };
}

let backend;
beforeEach(() => {
  backend = fakeBackend({ uid: 'host' });
  __setBackend(backend);
});
afterEach(() => {
  __setBackend(null);
});

describe('signIn', () => {
  it('returns the anonymous uid', async () => {
    await expect(signIn()).resolves.toBe('host');
  });
});

describe('createGame', () => {
  it('writes a lobby game and a code reservation, returning id and code', async () => {
    const { id, code } = await createGame('partners');
    expect(id).toBeTruthy();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const meta = backend.docs.get(`games/${id}`);
    expect(meta.status).toBe(STATUS.LOBBY);
    expect(meta.version).toBe(0);
    expect(meta.hostUid).toBe('host');
    expect(meta.guestUid).toBe(null);
    expect(meta.participants).toEqual(['host']);
    expect(meta.code).toBe(code);

    expect(backend.docs.get(`codes/${code}`)).toEqual({ gameId: id });
  });

  it('retries on a code collision', async () => {
    backend.setFailCodesTimes(2); // first two code reservations "collide"
    const { id, code } = await createGame();
    expect(backend.docs.get(`codes/${code}`)).toEqual({ gameId: id });
  });
});

describe('join', () => {
  // Seed a lobby game via the host, then return a fresh backend for another uid
  // that shares the same document store (so the join sees the seeded game).
  async function seedLobby() {
    const host = fakeBackend({ uid: 'host' });
    __setBackend(host);
    const { id, code } = await createGame();
    const asUid = (uid) => {
      const b = fakeBackend({ uid });
      for (const [k, v] of host.docs) b.docs.set(k, v);
      __setBackend(b);
      return b;
    };
    return { host, id, code, asUid };
  }

  it('a different uid claims the guest seat', async () => {
    const { id, asUid } = await seedLobby();
    const guest = asUid('guest');

    const res = await joinGameById(id);
    expect(res).toEqual({ id, seat: GUEST_SEAT });
    const meta = guest.docs.get(`games/${id}`);
    expect(meta.guestUid).toBe('guest');
    expect(meta.participants).toEqual(['host', 'guest']);
    expect(meta.version).toBe(0); // claim is not a turn
  });

  it('is idempotent for the host and the already-seated guest', async () => {
    const { id, asUid } = await seedLobby();
    // guest joins, then re-joins
    asUid('guest');
    await expect(joinGameById(id)).resolves.toEqual({ id, seat: GUEST_SEAT });
    await expect(joinGameById(id)).resolves.toEqual({ id, seat: GUEST_SEAT });
    // host opening their own link
    asUid('host');
    await expect(joinGameById(id)).resolves.toEqual({ id, seat: HOST_SEAT });
  });

  it('rejects a third player once the seat is taken', async () => {
    const { id, asUid } = await seedLobby();
    const guest = asUid('guest');
    await joinGameById(id);

    // stranger inherits the now-claimed store
    const stranger = fakeBackend({ uid: 'stranger' });
    for (const [k, v] of guest.docs) stranger.docs.set(k, v);
    __setBackend(stranger);
    await expect(joinGameById(id)).rejects.toThrow(/taken/);
  });

  it('joins by code, and rejects an unknown code', async () => {
    const { id, code, asUid } = await seedLobby();
    asUid('guest');

    await expect(joinGame(code)).resolves.toEqual({ id, seat: GUEST_SEAT });
    await expect(joinGame('ZZZZZZ')).rejects.toBeInstanceOf(GameNotFound);
  });
});

describe('startGame and publishState', () => {
  it('startGame publishes the initial state at version 1 and flips to active', async () => {
    const { id } = await createGame();
    const v = await startGame(id, { state: { pegs: 'x' }, currentPlayer: 0, waitingOn: 2 });
    expect(v).toBe(1);
    const meta = backend.docs.get(`games/${id}`);
    expect(meta.status).toBe(STATUS.ACTIVE);
    expect(meta.version).toBe(1);
    expect(meta.currentPlayer).toBe(0);
    expect(meta.waitingOn).toBe(2);
    // The live state/replay are stored as JSON strings (Firestore can't hold the
    // nested arrays in the game state); the round-trip through fetchGame decodes.
    const live = backend.docs.get(`games/${id}/live/current`);
    expect(typeof live.state).toBe('string');
    expect(live.version).toBe(1);
    const snap = await fetchGame(id);
    expect(snap.state).toEqual({ pegs: 'x' });
    expect(snap.replay).toEqual([]);
  });

  it('publishState advances the version and rejects a stale expectation', async () => {
    const { id } = await createGame();
    await startGame(id, { state: { s: 0 }, currentPlayer: 0, waitingOn: 2 }); // v1
    const v = await publishState(id, { state: { s: 1 }, replay: [], currentPlayer: 1, waitingOn: 2 }, 1);
    expect(v).toBe(2);

    await expect(
      publishState(id, { state: { s: 2 }, replay: [], currentPlayer: 3, waitingOn: 0 }, 1)
    ).rejects.toBeInstanceOf(VersionConflict);
  });

  it('round-trips a state with nested arrays (Firestore cannot store those raw)', async () => {
    const { id } = await createGame();
    // pegs/hands/discardPiles are arrays-of-arrays — the exact shape that a raw
    // Firestore write rejects. Storing the blob as JSON dodges the limitation.
    const state = {
      pegs: [[{ location: 'start', index: 0 }], [{ location: 'track', position: 8 }]],
      hands: [[{ rank: 'A', suit: '♠', id: 'A♠0' }], []],
      discardPiles: [[], []],
      currentPlayer: 0,
    };
    await startGame(id, { state, currentPlayer: 0, waitingOn: 2 });
    const snap = await fetchGame(id);
    expect(snap.state).toEqual(state);
    expect(Array.isArray(snap.state.pegs[0])).toBe(true);
  });

  it('sets winner and finished status when a game ends', async () => {
    const { id } = await createGame();
    await startGame(id, { state: { s: 0 }, currentPlayer: 0, waitingOn: 2 });
    await publishState(id, { state: { s: 1 }, replay: [], currentPlayer: 2, waitingOn: 0, winner: 0 }, 1);
    const meta = backend.docs.get(`games/${id}`);
    expect(meta.winner).toBe(0);
    expect(meta.status).toBe(STATUS.FINISHED);
  });
});

describe('fetchGame', () => {
  it('returns metadata and state, or null state before the deal', async () => {
    const { id } = await createGame();
    let snap = await fetchGame(id);
    expect(snap.meta.status).toBe(STATUS.LOBBY);
    expect(snap.state).toBe(null);

    await startGame(id, { state: { board: 1 }, currentPlayer: 0, waitingOn: 2 });
    snap = await fetchGame(id);
    expect(snap.state).toEqual({ board: 1 });
    expect(snap.version).toBe(1);
  });

  it('throws for an unknown game', async () => {
    await expect(fetchGame('nope')).rejects.toBeInstanceOf(GameNotFound);
  });
});
