// The wire protocol, as pure functions.
//
// Firestore is the whole backend — there is no server code to enforce anything,
// only the security rules (firestore/firestore.rules). So the shapes a client
// writes have to line up *exactly* with what those rules allow, or a write is
// rejected with a permission error. Keeping the document builders here, pure and
// separate from the Firestore transport in session.js, means they can be tested
// against the same expectations the rules encode without standing up an
// emulator: create writes version 0 / status 'lobby' / participants == [host];
// a guest claim only adds itself and freezes the host; a publish advances the
// version by exactly one and never touches membership.
//
// Turn-exchange (actually moving) is Package 4 — buildPublishMeta is here
// because publishing the *initial* dealt state (startGame, Package 3) is the
// same metadata write, and it is far easier to get the version arithmetic right
// in one tested place than to duplicate it later.

// The four board seats and the fixed remote partner layout. Phase 1 is
// partner-only: the two humans sit opposite (host 0, guest 2) with AI between
// them (1, 3). The seat model supports other layouts; the UI never offers them.
export const HOST_SEAT = 0;
export const GUEST_SEAT = 2;

export const STATUS = {
  LOBBY: 'lobby', // created, waiting for a guest to claim the seat
  ACTIVE: 'active', // dealt and in play
  FINISHED: 'finished', // someone (a team) has won
};

// Metadata for a freshly created game. Mirrors `allow create` in the rules:
// hostUid is the creator, guestUid is null, participants is exactly [host],
// version is 0, status is 'lobby'. currentPlayer/waitingOn start on the host's
// seat; they mean nothing until the game is dealt but are written so every
// metadata document has a consistent shape for the lobby to read.
export function buildCreateMeta({ hostUid, code, mode = 'partners', now }) {
  return {
    participants: [hostUid],
    hostUid,
    guestUid: null,
    code,
    mode,
    status: STATUS.LOBBY,
    version: 0,
    currentPlayer: HOST_SEAT,
    waitingOn: HOST_SEAT,
    winner: null,
    createdAt: now,
    updatedAt: now,
  };
}

// The metadata after a guest claims the empty seat. Mirrors update rule (a):
// only guestUid and participants change (participants gains exactly the joiner),
// hostUid is frozen, and the version does NOT advance — claiming a seat is not a
// turn. Returns the seat the guest takes so the client can set its seatOwners.
export function buildJoinMeta(meta, guestUid, now) {
  return {
    meta: {
      ...meta,
      guestUid,
      participants: [...meta.participants, guestUid],
      updatedAt: now,
    },
    seat: GUEST_SEAT,
  };
}

// The metadata written when a human turn is published (and when the host
// publishes the initial deal). Mirrors update rule (b): membership is frozen and
// the version advances by exactly one, so two clients can never both advance the
// same version — the database enforces the compare-and-swap, the client doesn't
// merely promise to be the only writer.
export function buildPublishMeta(meta, { currentPlayer, waitingOn, winner = null, status, now }) {
  return {
    ...meta,
    currentPlayer,
    waitingOn,
    winner,
    status: status ?? (winner !== null && winner !== undefined ? STATUS.FINISHED : STATUS.ACTIVE),
    version: meta.version + 1,
    updatedAt: now,
  };
}

// Your own write comes straight back through your own listener. Adopting it
// would rewind the board you just advanced, so ignore an echo. Firestore flags a
// not-yet-acknowledged local write with metadata.hasPendingWrites (the cheap
// test); a version you already hold is the belt-and-braces fallback for a
// server-confirmed echo. `held` is the version currently applied on this client.
export function isEcho({ hasPendingWrites = false, version } = {}, held) {
  if (hasPendingWrites) return true;
  if (typeof version === 'number' && typeof held === 'number') {
    return version <= held;
  }
  return false;
}

// The seat a metadata document says must act next. In Phase 1 the two human
// seats are 0 and 2, so a valid waitingOn is one of those; this is what the
// lobby compares against a device's stored seat to decide "your turn" and to
// drive the waiting-on-you badge (§3.2) — never currentPlayer, which is always
// parked on an AI seat after a publish.
export function waitingSeatOf(meta) {
  return meta && typeof meta.waitingOn === 'number' ? meta.waitingOn : null;
}
