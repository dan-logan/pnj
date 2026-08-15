// What a move should shout about.
//
// The board already *shows* everything that happens, and that has turned out
// not to be enough: the three moments people most often miss are the ones with
// no travel to watch. A joker teleports (its animation path is empty by
// construction), a partner bump looks like an ordinary peg nudge unless you
// already know the rule, and a cascade moves two pegs at once so whichever one
// you happen to be looking at is the one you don't notice. Each of those gets
// said out loud, big, over the board.
//
// Pure and separate from the component for the usual reason: "which of these
// three fired?" is a question about a pair of peg states, not about React, and
// the interesting cases (a joker that is *also* a partner bump that *also*
// cascades) are exactly the ones worth a test rather than a hand-trace.

// The cartoon curse over a peg that has just been knocked back to start. It is
// the one piece of feedback aimed at the *victim* rather than the mover — being
// sent home is the worst thing in the game and until now it happened in
// silence, which is why people kept asking "wait, what just moved?".
export const TAUNT_TEXT = '@$#*!';

// How long an overlay stays up. Long enough to read twice at the slow pace the
// rest of the pacing table is built around, short enough that it is gone before
// the next seat plays (the shortest gap between two moves is `fast`'s think
// pause, and the message deliberately outlives that — overlapping messages
// stack rather than fight).
export const ANNOUNCE_MS = 1800;
export const TAUNT_MS = 1800;

export const ANNOUNCEMENTS = {
  // Purple, the card's own colour elsewhere in the UI.
  joker: { kind: 'joker', text: 'Joker!', color: '#A855F7' },
  // Green, matching the friendly-bump fly-back — the one bump that is good news.
  partnerBump: { kind: 'partnerBump', text: 'Partner Bump!', color: '#22C55E' },
  // Amber: two pegs moved, and you only watched one of them.
  doublePlay: { kind: 'doublePlay', text: 'Double Play!', color: '#F59E0B' },
};

// `bumps` / `friendly` are the engine's own diffs (findBumps /
// findFriendlyBumps); `isJoker` is the one thing they can't tell you, since a
// joker's effect on the board is indistinguishable from any other bump.
//
// Returned in display order, and a move can legitimately produce all three:
// a joker onto a partner sitting where an opponent wants to be is a joker, a
// partner bump and a cascade at once.
export function announcementsFor({ bumps = [], friendly = [], isJoker = false } = {}) {
  const out = [];
  if (isJoker) out.push(ANNOUNCEMENTS.joker);
  if (friendly.length > 0) out.push(ANNOUNCEMENTS.partnerBump);
  // "Two pegs moved that weren't the mover" — a friendly bump cascading into an
  // opponent, or any other chain. Counted across both kinds, because the point
  // is the number of pegs that were displaced, not which rule displaced them.
  if (bumps.length + friendly.length >= 2) out.push(ANNOUNCEMENTS.doublePlay);
  return out;
}
