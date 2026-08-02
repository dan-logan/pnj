// Seat ownership: who controls each of the four seats from THIS client's point
// of view. Everything here is pure so it can be unit-tested without React.
//
// The board always has four seats (0 Yellow, 1 Blue, 2 Pink, 3 Green) in the
// fixed turn order 0 → 1 → 2 → 3 → 0. What changes between a solo game and a
// remote one is only *who* is behind each seat:
//
//   solo          ['me',   'ai', 'ai',   'ai']
//   remote host   ['me',   'ai', 'them', 'ai']
//   remote guest  ['them', 'ai', 'me',   'ai']
//
// Solo is not a special case in the code — it is just the layout where the only
// non-AI seat is seat 0.

import { NUM_PLAYERS } from '../game/constants.js';

export const SEAT_ME = 'me';
export const SEAT_AI = 'ai';
export const SEAT_THEM = 'them';

// The layout for a local single-player game.
export const SOLO_SEAT_OWNERS = [SEAT_ME, SEAT_AI, SEAT_AI, SEAT_AI];

// Every seat this client controls, in turn order. An array (not a scalar) even
// though Phase 1 only ever puts one seat in it, so that a client driving two
// seats needs no second refactor.
export function mySeatsOf(seatOwners) {
  const seats = [];
  for (let i = 0; i < seatOwners.length; i++) {
    if (seatOwners[i] === SEAT_ME) seats.push(i);
  }
  return seats;
}

// The seat this client is "sitting in": the one whose hand is shown, whose
// board edge faces the player, and who acts as the actor for engine moves.
// Falls back to seat 0 for a spectator layout with no owned seat.
export function primarySeat(seatOwners) {
  const seats = mySeatsOf(seatOwners);
  return seats.length > 0 ? seats[0] : 0;
}

export function isMySeat(seatOwners, player) {
  return seatOwners[player] === SEAT_ME;
}

export function isAISeat(seatOwners, player) {
  return seatOwners[player] === SEAT_AI;
}

// True when the seat to move is one this client controls.
export function isMyTurnFor(seatOwners, currentPlayer) {
  return isMySeat(seatOwners, currentPlayer);
}

// --- Board orientation ---
//
// The board is drawn with four visual sides: 0 top, 1 right, 2 bottom, 3 left.
// Your own seat must always be at the bottom, so seat `x` is drawn on side
// `(x - mySeat + 2) mod 4`. With `mySeat = 0` this collapses to the original
// `(x + 2) % 4`, which is why solo rendering is untouched by remote play.

export function visualSideFor(x, mySeat) {
  return (x - mySeat + 2 + NUM_PLAYERS) % NUM_PLAYERS;
}

// Inverse of visualSideFor: which seat is drawn on a given visual side.
export function seatAtVisualSide(visualSide, mySeat) {
  return (visualSide + mySeat + 2) % NUM_PLAYERS;
}
