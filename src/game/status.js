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
function myTurnPrompt({ splitRemaining, splitCard, jokerMode, burnMode, burnCard, mode }) {
  // A burn is a two-tap action — pick the card, then press the button — so the
  // line says which tap is outstanding. The old single prompt ("Select a card
  // to discard.") described a mode you had to *enter* first, which is exactly
  // the step that made the whole thing hard to find.
  if (burnMode) {
    return burnCard
      ? `No valid move. Press "Burn this card" to burn ${describeCard(burnCard)}.`
      : 'No valid move — tap a card to burn it.';
  }
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

// A card, as it reads in a sentence: "7♠", "a Joker".
export function describeCard(card) {
  if (!card) return null;
  return card.rank === 'JOKER' ? 'a Joker' : `${card.rank}${card.suit}`;
}

// The status line, as parts rather than as one string, so the seat's *name* can
// be drawn in the seat's own colour. `text` is the same words joined with
// spaces, which is what `describeStatus` returns and what a screen reader
// hears — the two can't drift apart because there is only one derivation.
//
// `who` is the coloured span and `player` is the seat it belongs to; `prefix`
// is anything that reads before the name ("Waiting for", "📺 Replay 2/3") and
// `detail` anything after it.
function parts({ prefix = null, player = null, who = null, detail = null }) {
  return { prefix, player, who, detail, text: [prefix, who, detail].filter(Boolean).join(' ') };
}

// The move currently on screen: who played what, and what it did. This is the
// status line's job now — it used to be a pill floating over the middle of the
// board, which is one more thing to look at in the one place the board is
// busiest. The status box is already where a player looks to find out what is
// happening, and it is already the right size.
function moveParts({ player, card, description, mine = false }, names) {
  const label = describeCard(card);
  const detail = [label && `played ${label}`, description && `— ${description}`]
    .filter(Boolean).join(' ');
  return parts({ player, who: mine ? 'You' : names[player], detail: detail || null });
}

export function describeStatusParts({
  phase,
  currentPlayer,
  splitRemaining = 0,
  splitCard = null,
  jokerMode = false,
  // True when the hand has no legal move at all and the only thing left to do
  // is burn a card; `burnCard` is the card picked to burn, if one is yet.
  burnMode = false,
  burnCard = null,
  mode = GAME_MODES.CLASSIC,
  names = PLAYER_NAMES,
  // True while a peg is actually travelling. "Blue is thinking…" printed over
  // a peg that is visibly counting its way around the board is a small lie,
  // and a confusing one for anyone relying on the words rather than the
  // movement — the two halves of the screen should agree.
  moving = false,
  // The move being shown right now (`{ player, card, description, mine }`), if
  // any. It replaces "Blue is moving…" — strictly more information in the same
  // line — but never an *instruction*: a prompt telling you to tap something
  // outranks commentary about a peg you can already see travelling.
  move = null,
  // `{ player, description, index, total }` while an instant replay runs.
  replay = null,
}) {
  switch (phase) {
    case PHASES.FINISHED:
      // The winning move is still on screen for as long as it takes to play
      // out (the component holds the result back for it — see `resultPending`),
      // and while it is, saying what won is better than saying it is over: the
      // board is still moving, and "Game over." over a travelling peg is the
      // same small lie as "Blue is thinking…" over one.
      if (move) return moveParts(move, names);
      return parts({ detail: 'Game over.' });
    case PHASES.REPLAYING:
      if (replay) {
        return parts({
          prefix: `📺 Replay ${replay.index}/${replay.total}`,
          player: replay.player,
          who: names[replay.player],
          detail: replay.description ? `— ${replay.description}` : null,
        });
      }
      return parts({ detail: 'Replaying the last round…' });
    case PHASES.DEALING:
      return parts({ detail: 'Dealing…' });
    case PHASES.MY_TURN: {
      // Mid-split, mid-joker and mid-burn the line is a prompt, and the prompt
      // wins: the first half of a split animates while the second half is
      // still waiting on a tap.
      const pending = burnMode || jokerMode || splitRemaining;
      if (!pending && move) return moveParts(move, names);
      if (!pending && moving) return parts({ detail: 'Moving…' });
      return parts({ detail: myTurnPrompt({ splitRemaining, splitCard, jokerMode, burnMode, burnCard, mode }) });
    }
    case PHASES.WAITING_PARTNER:
      if (move) return moveParts(move, names);
      return parts({ prefix: 'Waiting for', player: currentPlayer, who: names[currentPlayer], detail: 'to play…' });
    case PHASES.AI_TURN:
    default:
      if (move) return moveParts(move, names);
      return parts({
        player: currentPlayer,
        who: names[currentPlayer],
        detail: moving ? 'is moving…' : 'is thinking...',
      });
  }
}

// The status line. Never "Blue is thinking…" once the game is over.
export function describeStatus(args) {
  return describeStatusParts(args).text;
}

// Burning a card: what the button says, and whether it does anything yet.
//
// "Burning" is what this is called at a kitchen table — you have no legal move,
// so a card goes on the pile and you draw a replacement. It used to be a red
// button reading "No Valid Move - Select Card to Discard", which is a sentence
// describing your predicament rather than an action, and pressing it only
// opened a *second* step where the cards became tappable. Nobody found it.
// So the cards are live the moment you're stuck, and the button is the commit:
// dead until you've picked one, and then named after what it will do.
//
// `stuckCount` is the burns already on this seat's pile *before* this one, so
// at 2 the next burn is the third and earns a free peg out of start.
export function describeBurn({ card = null, stuckCount = 0 } = {}) {
  const ready = card !== null && card !== undefined;
  return {
    ready,
    label: ready ? '🔥 Burn this card' : 'Tap a card to burn',
    hint: stuckCount >= 2
      ? 'Two burnt already — this one starts a peg for you.'
      : stuckCount === 1
        ? 'One burnt. Three in a row starts a peg for you.'
        : 'Three burns in a row starts a peg for you.',
  };
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
