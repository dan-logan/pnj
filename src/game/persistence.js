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

// A single number, or a per-seat [n0, n1, n2, n3] array. Accept either on the
// way in (so an old save/payload with a plain number still loads) and always
// normalize to the array shape on the way out.
function toPerSeat(value) {
  if (Array.isArray(value)) return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
  return [value ?? 0, 0, 0, 0];
}

// Build the serializable snapshot. Kept separate from saveGame so it can be
// unit-tested without a storage backend. This is also the shape published to
// the wire for a remote turn (Package 4) — see commitTurn in the component.
//
// tallies.jokersPlayed/bumpsDelivered/timesBumped are per-seat arrays, not a
// single number. They used to be personal to whichever client computed them
// (gated on `ownsSeat`), which silently corrupted them the moment play went
// remote: each client would overwrite its partner's numbers with its own, and
// neither side ever saw a bump an AI delivered while the OTHER client was
// simulating it. A per-seat array is objective — whichever client actually
// simulates a seat's move records it at that seat's index — so it rides the
// wire correctly and each client sums only its own seats (`mySeats`) at
// stats-record time. `turns` stays a single shared counter: it is
// incremented once per seat that actually moves, which is already an
// objective fact both clients agree on.
//
// `startMode` ("did *I* choose to go first") is a host-only, local concept —
// a remote game should count toward neither the chosenFirst nor randomFirst
// stat bucket, so the component passes `null` for a remote turn (see
// commitTurn) rather than inheriting whatever the guest's default would be.
//
// `moveHistory` was write-only dead state (set, never read) and is dropped.
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
    // Per-game stat tallies so a resumed game still records correct stats.
    tallies: {
      turns: state.turns ?? 0,
      jokersPlayed: toPerSeat(state.jokersPlayed),
      bumpsDelivered: toPerSeat(state.bumpsDelivered),
      timesBumped: toPerSeat(state.timesBumped),
      // 'chosen' by default (today's solo behavior); a remote deal/turn passes
      // `startMode: null` explicitly so it counts toward neither stat bucket.
      startMode: state.startMode === undefined ? 'chosen' : state.startMode,
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
