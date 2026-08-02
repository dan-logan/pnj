// Save/resume for an in-progress Pegs and Jokers game, persisted to
// localStorage. Mobile browsers evict backgrounded tabs aggressively, so the
// full game state is snapshotted after every move and offered back on load.
//
// Everything in the snapshot is plain JSON (cards are `{ rank, suit, id }`,
// pegs are plain objects), so serialization is a straight JSON round-trip.
// load/save/clear accept an optional storage argument (defaulting to
// window.localStorage) and are no-ops when no storage is available (server-side
// render or a private-mode failure).

export const SAVE_STORAGE_KEY = 'pnj:savedGame:v1';
export const SAVE_VERSION = 2;

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

// Build the serializable snapshot. Kept separate from saveGame so it can be
// unit-tested without a storage backend.
export function serializeGame(state) {
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    // Identity of the game, so resuming it cannot record its result twice in
    // the player stats (see recordFinishedGame). Optional: an older save
    // without one is given a fresh id on load.
    gameId: state.gameId ?? null,
    mode: state.mode ?? 'classic',
    pegs: state.pegs,
    hands: state.hands,
    deck: state.deck,
    discardPiles: state.discardPiles,
    stuckCounts: state.stuckCounts,
    currentPlayer: state.currentPlayer,
    splitRemaining: state.splitRemaining ?? 0,
    splitCard: state.splitCard ?? null,
    splitPegIndex: state.splitPegIndex ?? null,
    splitOwner: state.splitOwner ?? null,
    lastMoves: state.lastMoves ?? [null, null, null, null],
    moveHistory: state.moveHistory ?? [],
    // Per-game stat tallies so a resumed game still records correct stats.
    tallies: {
      turns: state.turns ?? 0,
      jokersPlayed: state.jokersPlayed ?? 0,
      bumpsDelivered: state.bumpsDelivered ?? 0,
      timesBumped: state.timesBumped ?? 0,
      startMode: state.startMode ?? 'chosen',
    },
  };
}

// True only for a snapshot that represents a live, resumable game.
export function isResumable(saved) {
  if (!saved || typeof saved !== 'object') return false;
  // Accept any known save version (v1 predates partner mode and loads as classic).
  if (!(saved.version >= 1 && saved.version <= SAVE_VERSION)) return false;
  const { pegs, hands, deck, discardPiles, currentPlayer } = saved;
  if (!Array.isArray(pegs) || pegs.length !== 4) return false;
  if (!Array.isArray(hands) || hands.length !== 4) return false;
  if (!Array.isArray(deck)) return false;
  if (!Array.isArray(discardPiles) || discardPiles.length !== 4) return false;
  if (typeof currentPlayer !== 'number' || currentPlayer < 0 || currentPlayer > 3) return false;
  // A finished game (someone already home) is not worth resuming.
  const anyDealt = hands.some((h) => Array.isArray(h) && h.length > 0);
  return anyDealt;
}

export function saveGame(state, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(SAVE_STORAGE_KEY, JSON.stringify(serializeGame(state)));
  } catch {
    // Storage full or blocked — a lost save is non-fatal, so ignore.
  }
}

// Returns the saved snapshot if one exists and is resumable, otherwise null.
export function loadGame(storage) {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(SAVE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isResumable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearGame(storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(SAVE_STORAGE_KEY);
  } catch {
    // ignore
  }
}
