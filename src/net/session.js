// The remote session client: the §2.5 interface the app calls to create, join,
// read, publish and subscribe to remote games.
//
// This is the whole of the transport. It talks to Firestore through a small
// injectable "backend" of document/transaction/listener primitives (see
// makeFirestoreBackend below), the same shape stats.js and persistence.js use an
// injectable storage: the orchestration and the protocol shapes (from
// protocol.js) live here and are unit-tested against an in-memory fake backend,
// while the real backend is a thin wrapper over the lazily-loaded SDK. Nothing
// here imports Firebase statically, so a solo player never pays for it.
//
// A note on the two subscriptions the plan names. §4.4 ties `subscribeGame` to
// the live/current state document, but §3.1's host-waiting screen needs the
// *metadata* document (it watches guestUid appear, before any state exists).
// Those are two different documents, so a single listener cannot serve both.
// This module exposes both explicitly — subscribeGameMeta (metadata) and
// subscribeGameState (live/current) — and keeps `subscribeGame` as an alias for
// the state listener to match §2.5's name.

import {
  buildCreateMeta,
  buildJoinMeta,
  buildPublishMeta,
  isEcho,
  STATUS,
  HOST_SEAT,
  GUEST_SEAT,
} from './protocol.js';
import { generateCode, normalizeCode } from './gameCode.js';
import { getFirebase } from './firebase.js';

// Thrown by publishState when the version you expected is not the version on the
// server — someone else advanced it. Rule (b) makes this genuinely unreachable
// with one writer per turn, so it is a bug signal: re-read, adopt, surface a
// non-destructive notice. (Wired up in Package 4.)
export class VersionConflict extends Error {
  constructor(expected, actual) {
    super(`version conflict: expected ${expected}, found ${actual}`);
    this.name = 'VersionConflict';
    this.expected = expected;
    this.actual = actual;
  }
}

export class GameNotFound extends Error {
  constructor(what) {
    super(`not found: ${what}`);
    this.name = 'GameNotFound';
  }
}

// How many code collisions to tolerate before giving up. 31^6 ≈ 887M codes, so
// even a handful of live games makes a collision astronomically unlikely; a few
// retries is pure paranoia insurance.
const CODE_CREATE_ATTEMPTS = 5;

// --- Injectable backend -----------------------------------------------------
//
// Tests replace this with an in-memory fake. Production builds it from the
// lazily-loaded SDK on first use.

let backendOverride = null;
let realBackendPromise = null;

// Test seam. Pass a fake backend to exercise the orchestration without Firestore;
// pass null to restore the real one.
export function __setBackend(backend) {
  backendOverride = backend;
  realBackendPromise = null;
}

async function backend() {
  if (backendOverride) return backendOverride;
  if (!realBackendPromise) realBackendPromise = makeFirestoreBackend();
  return realBackendPromise;
}

// Re-export so the component can gate UI without importing firebase.js too.
export { isMultiplayerConfigured } from './firebase.js';

// --- Public API (§2.5) ------------------------------------------------------

// Anonymous, lazy, idempotent. Returns a durable per-device uid. This is the
// only place the app signs in, and it is only ever reached from a multiplayer
// action, so a solo player is never signed in.
export async function signIn() {
  const b = await backend();
  return b.ensureUid();
}

// Create a game and reserve a join code for it. Returns { id, code }. The id is
// the Firestore document id (a UUID) and rides share links as ?g=<id>; the code
// is the short secret read out to a partner.
export async function createGame(mode = 'partners') {
  const b = await backend();
  const uid = await b.ensureUid();
  const id = uuid();

  // Reserve the code first so a collision is caught before the game exists.
  let code = null;
  for (let attempt = 0; attempt < CODE_CREATE_ATTEMPTS; attempt++) {
    const candidate = generateCode();
    try {
      await b.createDoc(`codes/${candidate}`, { gameId: id });
      code = candidate;
      break;
    } catch (err) {
      if (attempt === CODE_CREATE_ATTEMPTS - 1) throw err;
      // else assume collision and try another code
    }
  }

  await b.createDoc(`games/${id}`, buildCreateMeta({ hostUid: uid, code, mode, now: b.now() }));
  return { id, code };
}

// Claim the guest seat by code. Returns { id, seat }.
export async function joinGame(code) {
  const b = await backend();
  const gameId = await b.getDoc(`codes/${normalizeCode(code)}`);
  if (!gameId || !gameId.gameId) throw new GameNotFound(`code ${code}`);
  return joinGameById(gameId.gameId);
}

// Claim the guest seat by game id (share links carry the id, which the code
// lookup never could). Returns { id, seat }. Idempotent: opening your own link
// as host, or re-opening as the already-seated guest, just returns your seat.
export async function joinGameById(id) {
  const b = await backend();
  const uid = await b.ensureUid();

  const seat = await b.runTransaction(async (tx) => {
    const meta = await tx.get(`games/${id}`);
    if (!meta) throw new GameNotFound(`game ${id}`);
    if (meta.hostUid === uid) return HOST_SEAT; // you created it
    if (meta.guestUid === uid) return GUEST_SEAT; // you already joined
    if (meta.guestUid != null) throw new Error('guest seat already taken');
    const { meta: next, seat } = buildJoinMeta(meta, uid, b.now());
    tx.set(`games/${id}`, next);
    return seat;
  });

  return { id, seat };
}

// The live game state (pegs, hands, discardPiles) is arrays-of-arrays, and
// Firestore cannot store an array whose elements are themselves arrays. So the
// state and replay blobs are stored as JSON strings — opaque to Firestore, which
// never queries inside them anyway — and (de)serialised at this boundary. This is
// the one correction the plan's "sync the whole serializeGame() blob" needed.
function encodeLive(state, replay) {
  return { state: JSON.stringify(state ?? null), replay: JSON.stringify(replay ?? []) };
}
function decodeState(raw) {
  if (raw == null) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
function decodeReplay(raw) {
  if (raw == null) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// One-shot read for switching into a game: the metadata plus the live state (or
// null state if it hasn't been dealt yet). Not a listener — the caller attaches
// those separately.
export async function fetchGame(id) {
  const b = await backend();
  const meta = await b.getDoc(`games/${id}`);
  if (!meta) throw new GameNotFound(`game ${id}`);
  const live = await b.getDoc(`games/${id}/live/current`);
  return {
    id,
    meta,
    state: decodeState(live?.state),
    replay: decodeReplay(live?.replay),
    version: live?.version ?? meta.version,
  };
}

// Host-only: publish the initial dealt state and flip the game to 'active'. This
// is the version 0 → 1 write; it is otherwise identical to publishing a turn.
export async function startGame(id, { state, replay = [], currentPlayer, waitingOn }) {
  return commit(id, { state, replay, currentPlayer, waitingOn, winner: null, status: STATUS.ACTIVE }, 0);
}

// Publish a completed human turn (Package 4). One transaction writes both the
// metadata and live/current, advancing the version by exactly one; throws
// VersionConflict if the server has moved on.
export async function publishState(id, payload, expectedVersion) {
  return commit(id, { ...payload, status: payload.winner != null ? STATUS.FINISHED : STATUS.ACTIVE }, expectedVersion);
}

// The shared write. Reads the current metadata, checks the compare-and-swap,
// then writes metadata (version+1) and live/current in one transaction.
async function commit(id, { state, replay = [], currentPlayer, waitingOn, winner = null, status }, expectedVersion) {
  const b = await backend();
  return b.runTransaction(async (tx) => {
    const meta = await tx.get(`games/${id}`);
    if (!meta) throw new GameNotFound(`game ${id}`);
    if (typeof expectedVersion === 'number' && meta.version !== expectedVersion) {
      throw new VersionConflict(expectedVersion, meta.version);
    }
    const nextMeta = buildPublishMeta(meta, { currentPlayer, waitingOn, winner, status, now: b.now() });
    tx.set(`games/${id}`, nextMeta);
    tx.set(`games/${id}/live/current`, { ...encodeLive(state, replay), version: nextMeta.version });
    return nextMeta.version;
  });
}

// Listen to a game's metadata document: status, guestUid, waitingOn, winner,
// version, currentPlayer. This is what the host-waiting screen watches for the
// guest to appear, and what the open game watches for whose-turn/status.
export function subscribeGameMeta(id, onMeta) {
  let stop = () => {};
  let cancelled = false;
  backend().then((b) => {
    if (cancelled) return;
    stop = b.onDoc(`games/${id}`, (snap) => onMeta(snap.data ?? null, snap));
  });
  return () => {
    cancelled = true;
    stop();
  };
}

// Listen to a game's live/current state document (§4.4). Delivers the shared
// state, replay frames and version, plus the echo flag so a client can ignore
// its own write coming back.
export function subscribeGameState(id, onState) {
  let stop = () => {};
  let cancelled = false;
  backend().then((b) => {
    if (cancelled) return;
    stop = b.onDoc(`games/${id}/live/current`, (snap) => {
      onState(
        snap.data
          ? { state: decodeState(snap.data.state), replay: decodeReplay(snap.data.replay), version: snap.data.version ?? null }
          : null,
        { hasPendingWrites: snap.hasPendingWrites, isEcho: (held) => isEcho({ hasPendingWrites: snap.hasPendingWrites, version: snap.data?.version }, held) }
      );
    });
  });
  return () => {
    cancelled = true;
    stop();
  };
}

// §2.5's name; it is the state listener.
export const subscribeGame = subscribeGameState;

// Listen to every game this device is a participant of, newest first. One
// subscription powers the whole lobby and the waiting-on-you badge. Delivers an
// array of metadata rows.
export function subscribeMyGames(onRows) {
  let stop = () => {};
  let cancelled = false;
  backend().then(async (b) => {
    if (cancelled) return;
    const uid = await b.ensureUid();
    if (cancelled) return;
    stop = b.onMyGames(uid, onRows);
  });
  return () => {
    cancelled = true;
    stop();
  };
}

// --- Real Firestore backend -------------------------------------------------
//
// A thin adapter from the generic backend primitives to the modular Firestore
// SDK. Kept deliberately mechanical: no protocol logic lives here.

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function makeFirestoreBackend() {
  const { auth, db, authMod, fsMod } = await getFirebase();

  // Resolve a path string to a Firestore DocumentReference. Paths are always an
  // even number of segments (collection/doc[/collection/doc...]).
  const ref = (path) => fsMod.doc(db, ...path.split('/'));

  let uidPromise = null;
  const ensureUid = () => {
    if (auth.currentUser) return Promise.resolve(auth.currentUser.uid);
    if (!uidPromise) {
      uidPromise = new Promise((resolve, reject) => {
        // signInAnonymously resolves with the credential; onAuthStateChanged
        // covers a session already restored from persistence.
        const unsub = authMod.onAuthStateChanged(auth, (user) => {
          if (user) {
            unsub();
            resolve(user.uid);
          }
        });
        authMod.signInAnonymously(auth).catch((err) => {
          unsub();
          reject(err);
        });
      });
    }
    return uidPromise;
  };

  return {
    ensureUid,
    now: () => fsMod.serverTimestamp(),

    async getDoc(path) {
      const snap = await fsMod.getDoc(ref(path));
      return snap.exists() ? snap.data() : null;
    },

    // Create-only write: fails if the document already exists, which is how a
    // code reservation detects a collision.
    async createDoc(path, data) {
      await fsMod.setDoc(ref(path), data);
    },

    async runTransaction(fn) {
      return fsMod.runTransaction(db, async (tx) => {
        const wrapped = {
          async get(path) {
            const snap = await tx.get(ref(path));
            return snap.exists() ? snap.data() : null;
          },
          set(path, data) {
            tx.set(ref(path), data);
          },
        };
        return fn(wrapped);
      });
    },

    onDoc(path, cb) {
      return fsMod.onSnapshot(ref(path), (snap) => {
        cb({
          exists: snap.exists(),
          data: snap.exists() ? snap.data() : null,
          hasPendingWrites: snap.metadata.hasPendingWrites,
        });
      });
    },

    onMyGames(uid, cb) {
      const q = fsMod.query(
        fsMod.collection(db, 'games'),
        fsMod.where('participants', 'array-contains', uid),
        fsMod.orderBy('updatedAt', 'desc')
      );
      return fsMod.onSnapshot(q, (snap) => {
        cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      });
    },
  };
}
