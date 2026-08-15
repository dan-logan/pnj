// The My Games lobby, as pure logic.
//
// The lobby lists every game this device is in — the solo game plus every remote
// game — with whose turn it is and how long since the last move, "your turn"
// games first. A badge on the lobby button shows how many games are waiting on
// you, so there is something to glance at without opening it. All of that is
// derived here from the metadata rows the `subscribeMyGames` listener delivers
// and the device's local labels, so it can be unit-tested without React.
//
// The one thing that is easy to get catastrophically wrong (plan §3.2): "your
// turn" is `waitingOn === seat`, NEVER `currentPlayer === seat`. A turn is
// published *after* it passes on, so every stored game is parked on an AI seat —
// currentPlayer is always 1 or 3, and `currentPlayer === seat` is false for
// every game, always. The badge would never leave zero. `waitingOn` is the human
// seat that must act next, written by the publisher; it is the only correct test.

import { HOST_SEAT, GUEST_SEAT, STATUS } from './protocol.js';

// The seat this device holds in a game, from the metadata's source of truth
// (participants), not from the local cache. Host → 0, guest → 2, else null.
export function seatForUid(meta, myUid) {
  if (!meta || !myUid) return null;
  if (meta.hostUid === myUid) return HOST_SEAT;
  if (meta.guestUid === myUid) return GUEST_SEAT;
  return null;
}

// Firestore timestamps arrive as objects, not numbers. Accept whatever shape is
// handed in — a millis number, a Firestore Timestamp (toMillis() or {seconds}),
// a Date, or null — and return milliseconds.
export function toMillis(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1e6);
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

// One lobby row per remote game, derived from its metadata and the device's
// local entry (label/archived). `yourTurn` is the whole point — see above.
export function toLobbyRow(meta, { myUid, local = null } = {}) {
  const seat = seatForUid(meta, myUid);
  const finished = meta.status === STATUS.FINISHED || (meta.winner !== null && meta.winner !== undefined);
  const active = meta.status === STATUS.ACTIVE;
  return {
    id: meta.id,
    kind: 'remote',
    label: local?.label ?? meta.code ?? meta.id,
    code: meta.code ?? null,
    status: meta.status,
    seat,
    waitingOn: typeof meta.waitingOn === 'number' ? meta.waitingOn : null,
    // Waiting on YOU: active game whose next human seat is the one you hold.
    yourTurn: active && seat !== null && meta.waitingOn === seat,
    finished,
    winner: meta.winner ?? null,
    lobby: meta.status === STATUS.LOBBY,
    archived: Boolean(local?.archived),
    updatedAtMs: toMillis(meta.updatedAt),
  };
}

// Build the remote rows for a set of metadata documents, dropping archived ones
// (they stay on the device but out of the lobby), sorted for display.
export function buildRemoteRows(metaRows, { myUid, localById = {} } = {}) {
  return sortLobbyRows(
    metaRows
      .map((meta) => toLobbyRow(meta, { myUid, local: localById[meta.id] }))
      .filter((row) => !row.archived)
  );
}

// Sort order: games waiting on you first, then most recently updated. Finished
// games sink (they are never "your turn"); the UI collapses them separately.
export function sortLobbyRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.yourTurn !== b.yourTurn) return a.yourTurn ? -1 : 1;
    if (a.finished !== b.finished) return a.finished ? 1 : -1;
    return b.updatedAtMs - a.updatedAtMs;
  });
}

// The badge: how many games are waiting on you right now. Drawn from the same
// rows, so it can never disagree with the list. Excludes finished and lobby
// games — only a live game whose move is yours counts.
export function countWaitingOnMe(rows) {
  return rows.filter((row) => row.yourTurn).length;
}

// "just now" / "3 minutes ago" / "2 hours ago" / "5 days ago". Deliberately
// coarse — this is "how stale is this game", not a clock.
export function relativeTime(thenMs, nowMs = Date.now()) {
  const then = toMillis(thenMs);
  if (!then) return '';
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

// What opening a game should actually do, from its metadata and whether the
// live document holds a state yet. Pure, because the branch it replaces is the
// one that made two different games look like the same game:
//
//   'adopt'       — there is a dealt state; show it.
//   'deal'        — our own game, a guest has claimed the seat, nobody has
//                   dealt: deal it now and publish.
//   'await_guest' — our own game, still nobody in the other seat: show the
//                   code and the invite link again.
//   'await_deal'  — we are the guest and the host hasn't dealt: just wait.
//
// Only 'adopt' has a board to show. Every other answer means the board must be
// BLANKED, not left as it was — leaving it was the bug: switching from a game
// in progress to one still waiting for a partner kept the first game's board on
// screen, under the second game's session.
export function openActionFor({ meta, hasState, seat }) {
  if (hasState) return 'adopt';
  if (seat === HOST_SEAT && meta?.status === STATUS.LOBBY) {
    return meta.guestUid ? 'deal' : 'await_guest';
  }
  return 'await_deal';
}

// What a fresh load should open. A reload is not a decision — it must land you
// back on the game you were already looking at, and switching games must stay
// something you do deliberately, from the lobby.
//
//   { kind: 'join',   id }        — an invite link (?g=) outranks everything.
//   { kind: 'remote', id, seat }  — the game this device last had on screen.
//   { kind: 'resume' }            — no remote game was open; offer the solo save.
//   { kind: 'solo' }              — nothing to restore; a fresh solo game.
//
// `activeId` (localSession) is the whole answer to "which game was on screen":
// it is written when a remote game is opened and cleared to null the moment you
// switch to solo or start a new solo game. The routing used to ignore it and
// instead auto-open the device's sole remote game, so a player with one remote
// game going was thrown into it by every reload of their solo board — including
// the reload right after a solo game ended, when the (deliberately cleared) save
// made the solo side look like nothing at all.
//
// Anything less than a clear answer means solo: an activeId pointing at a game
// this device no longer lists, or has archived, is not evidence of what was on
// screen. Never guess a remote game from the mere existence of one.
export function bootTargetFor({
  joinId = null,
  multiplayer = false,
  activeId = null,
  games = [],
  hasSave = false,
} = {}) {
  if (multiplayer && joinId) return { kind: 'join', id: joinId };
  if (multiplayer && activeId) {
    const game = games.find((g) => g.id === activeId && !g.archived);
    if (game) return { kind: 'remote', id: game.id, seat: game.seat ?? HOST_SEAT };
  }
  return hasSave ? { kind: 'resume' } : { kind: 'solo' };
}
