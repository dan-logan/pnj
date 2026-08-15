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

// A partner bump is the one bump that is a *favour*, so the two pegs involved
// say so to each other: the peg that got the free ride to its own home entrance
// thanks the one that shoved it there, which answers back a beat later. Which
// peg says which is not always the obvious way round — in the entrance swap it
// is the *mover* that gets carried to its entrance by the partner it landed on,
// so the mover is the one saying thanks. The engine names both parties on each
// displacement (`byPlayer`/`byPegIndex`), so neither the exchange nor its
// direction has to be guessed from the board.
export const THANKS_TEXT = 'Thanks!';
export const WELCOME_TEXT = "You're welcome!";

// The other half of a knock-back. The victim has always had the last word
// ("@$#*!") while the peg that did it stood there innocently, which reads as
// something that happened *to* a peg rather than something a peg *did*. The
// culprit gets to gloat, a beat after the complaint, so the two read as an
// exchange between two pegs rather than one peg sulking on its own.
export const GLOAT_TEXT = 'Hee hee!';

// The reply's beat. Short enough that both bubbles are on screen together for
// most of their life (they last TAUNT_MS each), long enough to read as an
// answer rather than as two pegs talking over each other.
export const REPLY_MS = 650;

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

// `bumps` is the engine's knock-back diff (findBumps) and `friendly` is the
// friendly half of a move's `displacements`; `isJoker` is the one thing neither
// can tell you, since a joker's effect on the board is indistinguishable from
// any other bump.
//
// Returned in display order, and a move can legitimately produce all three:
// a joker onto a partner sitting where an opponent wants to be is a joker, a
// partner bump and a cascade at once.
// A play with more than one moving part — the ones that are hard to follow and
// that therefore earn the extra emphasis: the joker's card and peg flight, the
// slowed fly-back, and the pause afterwards (SPECIAL_PAUSE_MS in anim.js).
//
// Deliberately wider than `announcementsFor`: an ordinary knock-back raises no
// banner (you can see the peg fly, so it needs no caption) but is absolutely a
// play worth a beat to take in, since a peg has just been sent the length of
// the board back to where it started.
export function isSpecialPlay({ bumps = [], friendly = [], isJoker = false } = {}) {
  return isJoker || bumps.length > 0 || friendly.length > 0;
}

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
