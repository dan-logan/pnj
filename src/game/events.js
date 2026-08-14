// What visibly *happened* across one move, for the benefit of someone who is
// listening rather than staring at the board.
//
// The engine already reports bumps (`findBumps` / `findFriendlyBumps`), but the
// other two things a player at a real table hears — a peg coming out of start,
// and a peg reaching home — were never derived anywhere; the UI just played one
// generic chime from whichever call site happened to know. Deriving them from
// the before/after peg states instead means every mover gets the same
// announcement, whether the move was yours, your partner's, an AI's, or an AI's
// simulated on the other device.

import { NUM_PLAYERS, PEGS_PER_PLAYER } from './constants.js';

const allHome = (playerPegs) =>
  playerPegs.length === PEGS_PER_PLAYER && playerPegs.every((p) => p.location === 'home');

// `cameOut`     — pegs that went from the start area onto the track
// `reachedHome` — pegs that entered the home corridor this move
// `finishedAll` — players whose *last* peg just landed, i.e. they are now done
//
// Every entry is `{ player, pegIndex }` except `finishedAll`, which is a list
// of player indices. Pure: takes both peg states, returns a plain object.
export function diffPegEvents(oldPegs, newPegs) {
  const cameOut = [];
  const reachedHome = [];
  const finishedAll = [];

  for (let player = 0; player < NUM_PLAYERS; player++) {
    const before = oldPegs?.[player];
    const after = newPegs?.[player];
    if (!before || !after) continue;

    for (let pegIndex = 0; pegIndex < after.length; pegIndex++) {
      const from = before[pegIndex];
      const to = after[pegIndex];
      if (!from || !to) continue;
      if (from.location === 'start' && to.location === 'track') {
        cameOut.push({ player, pegIndex });
      }
      if (from.location !== 'home' && to.location === 'home') {
        reachedHome.push({ player, pegIndex });
      }
    }

    // Only the transition counts: a player who was already finished (their
    // partner is still playing their pegs, in partner mode) must not re-fire
    // the flourish on every subsequent move.
    if (!allHome(before) && allHome(after)) finishedAll.push(player);
  }

  return { cameOut, reachedHome, finishedAll };
}
