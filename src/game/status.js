// What the game is doing right now, and how to say it.
//
// The status line used to be imperative state (`gameMessage`) written from ~40
// call sites, several of them on 800–1500 ms timers. Anything that finished the
// game returned before updating it, and the timers then fired *after* the win
// and overwrote whatever the win path had set — which is how a "Blue is
// thinking…" line ended up sitting under a "You win!" banner.
//
// So: don't set the status, derive it. Everything here is pure, takes the state
// it needs as arguments, and is unit-testable without React. A derived line
// cannot go stale and cannot be clobbered by a timer that outlived its turn.

import { CARD_VALUES, PLAYER_NAMES, GAME_MODES } from './constants.js';
import { didIWin, winningSeats } from './stats.js';

export const PHASES = {
  DEALING: 'dealing',
  MY_TURN: 'my_turn',
  AI_TURN: 'ai_turn',
  WAITING_PARTNER: 'waiting_partner',
  REPLAYING: 'replaying',
  FINISHED: 'finished',
};

// The one source of truth for "what is happening". Order matters: a replay
// outranks even a finished game, so a remote win can be watched (the auto-
// replay of the winning move, Package 5) before the end-of-game overlay
// appears — `winner` is set immediately when the game ends (so nothing can
// move afterwards) but the *overlay* is presented only once the replay
// finishes (`winner !== null && !isReplaying`, gated in the component). Once
// a replay isn't running, a finished game outranks everything else.
export function derivePhase({ winner, isReplaying, dealt, isMyTurn, currentPlayer, seatOwners }) {
  if (isReplaying) return PHASES.REPLAYING;
  if (winner !== null && winner !== undefined) return PHASES.FINISHED;
  if (!dealt) return PHASES.DEALING;
  if (isMyTurn) return PHASES.MY_TURN;
  return seatOwners[currentPlayer] === 'them' ? PHASES.WAITING_PARTNER : PHASES.AI_TURN;
}

// The prompt shown while it is your turn, which depends on what you are part
// way through rather than on the phase alone.
function myTurnPrompt({ splitRemaining, splitCard, jokerMode, discardMode, mode }) {
  if (discardMode) return 'Select a card to discard.';
  if (jokerMode) {
    return mode === GAME_MODES.PARTNERS
      ? 'Click a peg on the track to bump — hit your partner to send them to their home stretch.'
      : "Now click an opponent's peg on the track to bump it.";
  }
  if (splitRemaining) {
    const amount = Math.abs(splitRemaining);
    // A 9 must split in both directions, so its remainder carries a direction;
    // a 7's remainder is always forward.
    if (CARD_VALUES[splitCard?.rank]?.mustSplit) {
      const direction = splitRemaining < 0 ? 'backward' : 'forward';
      return `Tap a glowing peg to move ${amount} spaces ${direction} (or Undo).`;
    }
    return `Tap a glowing peg to move the remaining ${amount} spaces (or Undo).`;
  }
  return 'Your turn! Select a card and peg to move.';
}

// The status line. Never "Blue is thinking…" once the game is over.
export function describeStatus({
  phase,
  currentPlayer,
  splitRemaining = 0,
  splitCard = null,
  jokerMode = false,
  discardMode = false,
  mode = GAME_MODES.CLASSIC,
  names = PLAYER_NAMES,
}) {
  switch (phase) {
    case PHASES.FINISHED:
      return 'Game over.';
    case PHASES.REPLAYING:
      return 'Replaying the last round…';
    case PHASES.DEALING:
      return 'Dealing…';
    case PHASES.MY_TURN:
      return myTurnPrompt({ splitRemaining, splitCard, jokerMode, discardMode, mode });
    case PHASES.WAITING_PARTNER:
      return `Waiting for ${names[currentPlayer]} to play…`;
    case PHASES.AI_TURN:
    default:
      return `${names[currentPlayer]} is thinking...`;
  }
}

// How to announce the result, phrased for the mode and for who you are:
// "You and Pink win!" / "Blue and Green win" / "You win!" / "Blue wins".
export function describeOutcome(winner, mode = GAME_MODES.CLASSIC, mySeats = [0], names = PLAYER_NAMES) {
  if (winner === null || winner === undefined) return null;
  const seats = winningSeats(winner, mode);
  const won = didIWin(winner, mode, mySeats);
  // Your own seat reads as "You"; put it first so it's "You and Pink".
  const ordered = [...seats].sort((a, b) => (mySeats.includes(b) ? 1 : 0) - (mySeats.includes(a) ? 1 : 0));
  const labels = ordered.map((seat) => (mySeats.includes(seat) ? 'You' : names[seat]));
  const subject = labels.join(' and ');
  // "You win", "You and Pink win", "Blue and Green win" — but "Blue wins".
  const verb = labels.length > 1 || won ? 'win' : 'wins';
  return { won, seats: ordered, text: `${subject} ${verb}${won ? '!' : '.'}` };
}

// §5.3: in partner mode, once a player's own pegs are all home their cards
// move their *partner's* pegs (`controlledOwnerFor`). A replay frame's
// `player` is the actor (whose turn it is / whose card was played), which can
// differ from the peg's owner — watching your own peg move in a frame
// attributed to your partner's turn is confusing without saying so. Named by
// seat (not "your peg") so the text reads correctly for every viewer,
// including a third party watching neither seat.
export function attributeFrameDescription(description, actor, owner, names = PLAYER_NAMES) {
  if (actor === owner) return description;
  return `${description} (moved ${names[owner]}'s peg)`;
}
