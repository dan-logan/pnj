// The device's local record of its remote games, in localStorage under
// `pnj:games:v1`.
//
// This is a cache and a nickname store, NOT the source of truth. Firestore knows
// which games are yours via each document's `participants` array and your
// anonymous uid, so a device that keeps its uid recovers its games from the
// server without this. What lives here and nowhere else:
//
//   - `label` — a local nickname ("Sara", "Topher"). There are no accounts, so
//     there are no real partner names; the player types one at create/join time
//     (defaulting to the code) and it never leaves the device.
//   - `seat` — which seat this device plays in that game, so the board orients
//     correctly the instant you switch in, before any document has loaded.
//   - `archived` — hides a finished or abandoned game from the lobby without
//     touching the shared document.
//   - `activeId` — which game is on screen, so a reload can restore it.
//
// Same injectable-storage pattern as stats.js / persistence.js: every function
// takes an optional storage and is a no-op (or returns the empty shape) when no
// storage is available.

export const GAMES_STORAGE_KEY = 'pnj:games:v1';
export const GAMES_VERSION = 1;

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function emptyLocalGames() {
  return { version: GAMES_VERSION, activeId: null, games: [] };
}

// Normalise whatever is in storage into the current shape, dropping anything
// malformed. Never throws.
export function loadLocalGames(storage) {
  const store = resolveStorage(storage);
  if (!store) return emptyLocalGames();
  try {
    const raw = store.getItem(GAMES_STORAGE_KEY);
    if (!raw) return emptyLocalGames();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.games)) return emptyLocalGames();
    const games = parsed.games
      .filter((g) => g && typeof g.id === 'string')
      .map((g) => ({
        id: g.id,
        seat: typeof g.seat === 'number' ? g.seat : 0,
        code: typeof g.code === 'string' ? g.code : null,
        label: typeof g.label === 'string' ? g.label : null,
        createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0,
        archived: Boolean(g.archived),
      }));
    return {
      version: GAMES_VERSION,
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      games,
    };
  } catch {
    return emptyLocalGames();
  }
}

export function saveLocalGames(data, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(GAMES_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked — the game list is a convenience cache, so ignore.
  }
}

// True when this device has any remote game recorded (archived or not). Gates
// whether the lobby opens on load (§3.4): a solo-only player has none and gets
// today's exact resume flow.
export function hasLocalGames(storage) {
  return loadLocalGames(storage).games.length > 0;
}

export function getLocalGame(id, storage) {
  return loadLocalGames(storage).games.find((g) => g.id === id) ?? null;
}

// Add a game, or merge fields into an existing one (idempotent on id). Returns
// the updated store object.
export function upsertLocalGame(game, storage) {
  const data = loadLocalGames(storage);
  const idx = data.games.findIndex((g) => g.id === game.id);
  if (idx === -1) {
    data.games = [
      ...data.games,
      {
        id: game.id,
        seat: game.seat ?? 0,
        code: game.code ?? null,
        label: game.label ?? game.code ?? null,
        createdAt: game.createdAt ?? Date.now(),
        archived: Boolean(game.archived),
      },
    ];
  } else {
    data.games = data.games.map((g, i) => (i === idx ? { ...g, ...game } : g));
  }
  saveLocalGames(data, storage);
  return data;
}

// Merge a patch into one game (label, seat, archived, …). No-op for an unknown
// id. Returns the updated store object.
export function updateLocalGame(id, patch, storage) {
  const data = loadLocalGames(storage);
  if (!data.games.some((g) => g.id === id)) return data;
  data.games = data.games.map((g) => (g.id === id ? { ...g, ...patch } : g));
  saveLocalGames(data, storage);
  return data;
}

export function archiveLocalGame(id, storage) {
  return updateLocalGame(id, { archived: true }, storage);
}

// Forget a game entirely (e.g. a create the host abandoned before anyone
// joined). Clears activeId if it pointed here.
export function removeLocalGame(id, storage) {
  const data = loadLocalGames(storage);
  data.games = data.games.filter((g) => g.id !== id);
  if (data.activeId === id) data.activeId = null;
  saveLocalGames(data, storage);
  return data;
}

export function getActiveId(storage) {
  return loadLocalGames(storage).activeId;
}

// Set (or clear, with null) which game is on screen. `null` is the solo game.
export function setActiveId(id, storage) {
  const data = loadLocalGames(storage);
  data.activeId = id ?? null;
  saveLocalGames(data, storage);
  return data;
}

// The games to show in the lobby: non-archived by default, newest first.
export function activeLocalGames(storage) {
  return loadLocalGames(storage)
    .games.filter((g) => !g.archived)
    .sort((a, b) => b.createdAt - a.createdAt);
}
