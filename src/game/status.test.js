import { describe, it, expect } from 'vitest';
import { PHASES, derivePhase, describeStatus, describeStatusParts, describeCard, describeBurn, describeOutcome, attributeFrameDescription } from './status.js';
import { GAME_MODES } from './constants.js';

const SOLO = ['me', 'ai', 'ai', 'ai'];
const HOST = ['me', 'ai', 'them', 'ai'];
const GUEST = ['them', 'ai', 'me', 'ai'];

const base = {
  winner: null,
  isReplaying: false,
  dealt: true,
  isMyTurn: false,
  currentPlayer: 1,
  seatOwners: SOLO,
};

describe('derivePhase', () => {
  it('reports a finished game above everything except an in-flight replay', () => {
    // This is the bug the derived model exists to kill: mid-animation, mid-AI
    // turn — once there is a winner the phase is finished.
    expect(derivePhase({ ...base, winner: 0 })).toBe(PHASES.FINISHED);
    expect(derivePhase({ ...base, winner: 0, dealt: false })).toBe(PHASES.FINISHED);
  });

  it('treats winner 0 as a winner, not as falsy', () => {
    expect(derivePhase({ ...base, winner: 0, isMyTurn: true })).toBe(PHASES.FINISHED);
  });

  it('locks into replaying while playback runs, even after the game has ended', () => {
    // Package 5: a remote win auto-replays the winning move before the
    // end-of-game overlay appears. `winner` is set immediately (so nothing can
    // move afterwards) but the phase stays REPLAYING until playback finishes,
    // so the status line doesn't say "Game over" out from under the replay.
    expect(derivePhase({ ...base, isReplaying: true, isMyTurn: true })).toBe(PHASES.REPLAYING);
    expect(derivePhase({ ...base, winner: 1, isReplaying: true, isMyTurn: true })).toBe(PHASES.REPLAYING);
  });

  it('is dealing before any cards are out', () => {
    expect(derivePhase({ ...base, dealt: false, isMyTurn: true })).toBe(PHASES.DEALING);
  });

  it('is your turn when you own the seat to move', () => {
    expect(derivePhase({ ...base, isMyTurn: true, currentPlayer: 0 })).toBe(PHASES.MY_TURN);
    expect(derivePhase({ ...base, seatOwners: GUEST, isMyTurn: true, currentPlayer: 2 })).toBe(PHASES.MY_TURN);
  });

  it('distinguishes an AI seat from a remote partner', () => {
    expect(derivePhase({ ...base, seatOwners: HOST, currentPlayer: 1 })).toBe(PHASES.AI_TURN);
    expect(derivePhase({ ...base, seatOwners: HOST, currentPlayer: 2 })).toBe(PHASES.WAITING_PARTNER);
    expect(derivePhase({ ...base, seatOwners: GUEST, currentPlayer: 0 })).toBe(PHASES.WAITING_PARTNER);
  });

  it('never reports waiting_partner in a solo game', () => {
    for (const currentPlayer of [1, 2, 3]) {
      expect(derivePhase({ ...base, currentPlayer })).toBe(PHASES.AI_TURN);
    }
  });
});

describe('describeStatus while a peg is travelling', () => {
  it('says an AI is moving, not thinking, once its peg is on the way', () => {
    expect(describeStatus({ phase: PHASES.AI_TURN, currentPlayer: 1, moving: true }))
      .toBe('Blue is moving…');
    expect(describeStatus({ phase: PHASES.AI_TURN, currentPlayer: 1 }))
      .toBe('Blue is thinking...');
  });

  it('replaces your own prompt while your peg is counting itself along', () => {
    expect(describeStatus({ phase: PHASES.MY_TURN, currentPlayer: 0, moving: true }))
      .toBe('Moving…');
  });

  it('never overrides a finished game', () => {
    expect(describeStatus({ phase: PHASES.FINISHED, currentPlayer: 1, moving: true }))
      .toBe('Game over.');
  });
});

describe('describeStatus', () => {
  it('says the game is over rather than who is thinking', () => {
    expect(describeStatus({ phase: PHASES.FINISHED, currentPlayer: 1 })).toBe('Game over.');
  });

  it('names the seat that is thinking', () => {
    expect(describeStatus({ phase: PHASES.AI_TURN, currentPlayer: 3 })).toBe('Green is thinking...');
  });

  it('names a remote partner it is waiting on', () => {
    expect(describeStatus({ phase: PHASES.WAITING_PARTNER, currentPlayer: 2 }))
      .toBe('Waiting for Pink to play…');
  });

  it('prompts for a card and peg on your turn', () => {
    expect(describeStatus({ phase: PHASES.MY_TURN, currentPlayer: 0 }))
      .toBe('Your turn! Select a card and peg to move.');
  });

  it('prompts for the remainder of a 7 split', () => {
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, splitRemaining: 4, splitCard: { rank: '7' },
    })).toBe('Tap a glowing peg to move the remaining 4 spaces (or Undo).');
  });

  it('carries the direction of a 9 split remainder', () => {
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, splitRemaining: 5, splitCard: { rank: '9' },
    })).toBe('Tap a glowing peg to move 5 spaces forward (or Undo).');
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, splitRemaining: -5, splitCard: { rank: '9' },
    })).toBe('Tap a glowing peg to move 5 spaces backward (or Undo).');
  });

  it('explains joker targeting differently in partner mode', () => {
    const classic = describeStatus({ phase: PHASES.MY_TURN, currentPlayer: 0, jokerMode: true });
    const partners = describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, jokerMode: true, mode: GAME_MODES.PARTNERS,
    });
    expect(classic).toMatch(/opponent's peg/);
    expect(partners).toMatch(/partner/);
  });

  it('puts burn mode ahead of the other prompts', () => {
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, burnMode: true, jokerMode: true,
    })).toBe('No valid move — tap a card to burn it.');
  });

  it('asks for the remaining tap once a card is picked to burn', () => {
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, burnMode: true, burnCard: { rank: '7', suit: '♠' },
    })).toBe('No valid move. Press "Burn this card" to burn 7♠.');
  });
});

// The move commentary used to be a pill floating over the middle of the board.
// It is the status line now: same words, no second thing to look at, and — the
// point of the change — no element whose size depends on the move.
describe('describeStatus carrying the move being played', () => {
  const move = { player: 1, card: { rank: '7', suit: '♠' }, description: 'Space 20 to Space 25' };

  it('says what an opponent played instead of that they are moving', () => {
    expect(describeStatus({ phase: PHASES.AI_TURN, currentPlayer: 1, moving: true, move }))
      .toBe('Blue played 7♠ — Space 20 to Space 25');
  });

  it('names your own seat "You"', () => {
    expect(describeStatus({
      phase: PHASES.AI_TURN, currentPlayer: 1, move: { ...move, player: 0, mine: true },
    })).toBe('You played 7♠ — Space 20 to Space 25');
  });

  it('reads a joker by name rather than as a rank and suit', () => {
    expect(describeStatus({
      phase: PHASES.AI_TURN, currentPlayer: 1,
      move: { player: 1, card: { rank: 'JOKER' }, description: 'Bumped Pink' },
    })).toBe('Blue played a Joker — Bumped Pink');
  });

  it('covers a remote partner the same way', () => {
    expect(describeStatus({ phase: PHASES.WAITING_PARTNER, currentPlayer: 2, move }))
      .toBe('Blue played 7♠ — Space 20 to Space 25');
  });

  it('never displaces a prompt that is waiting on a tap', () => {
    // The first half of a split animates while the second half still needs a
    // peg: commentary about the peg you can already see would cost you the
    // instruction you actually need.
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, splitRemaining: 4, splitCard: { rank: '7' },
      moving: true, move: { ...move, player: 0, mine: true },
    })).toBe('Tap a glowing peg to move the remaining 4 spaces (or Undo).');

    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, jokerMode: true, move,
    })).toMatch(/opponent's peg/);
  });

  it('says what won while the winning move is still on screen', () => {
    // A finished game holds its result back until the move that ended it has
    // played out (the component's `resultPending`), and for those few seconds
    // the board is still moving. "Game over." over a travelling peg is the same
    // small lie as "Blue is thinking…" over one — and the winning card is the
    // one card in the game you least want to have missed.
    expect(describeStatus({ phase: PHASES.FINISHED, currentPlayer: 1, move }))
      .toBe('Blue played 7♠ — Space 20 to Space 25');
  });

  it('falls back to "Game over." once the winning move has cleared', () => {
    expect(describeStatus({ phase: PHASES.FINISHED, currentPlayer: 1, move: null, moving: true }))
      .toBe('Game over.');
  });

  it('falls back to the plain line with no move on screen', () => {
    expect(describeStatus({ phase: PHASES.AI_TURN, currentPlayer: 1, moving: true, move: null }))
      .toBe('Blue is moving…');
  });
});

describe('describeStatusParts', () => {
  it('separates the seat name out so it can be drawn in the seat colour', () => {
    const p = describeStatusParts({ phase: PHASES.AI_TURN, currentPlayer: 3 });
    expect(p).toMatchObject({ prefix: null, player: 3, who: 'Green', detail: 'is thinking...' });
    expect(p.text).toBe('Green is thinking...');
  });

  it('puts the name in the middle of a "waiting for" line', () => {
    const p = describeStatusParts({ phase: PHASES.WAITING_PARTNER, currentPlayer: 2 });
    expect(p).toMatchObject({ prefix: 'Waiting for', player: 2, who: 'Pink', detail: 'to play…' });
    expect(p.text).toBe('Waiting for Pink to play…');
  });

  it('has no seat to colour for a prompt', () => {
    const p = describeStatusParts({ phase: PHASES.MY_TURN, currentPlayer: 0 });
    expect(p.player).toBeNull();
    expect(p.who).toBeNull();
  });

  it('carries the replay frame instead of a generic "replaying" line', () => {
    const p = describeStatusParts({
      phase: PHASES.REPLAYING, currentPlayer: 0,
      replay: { player: 1, description: 'Space 20 to Space 25', index: 2, total: 3 },
    });
    expect(p).toMatchObject({ prefix: '📺 Replay 2/3', player: 1, who: 'Blue' });
    expect(p.text).toBe('📺 Replay 2/3 Blue — Space 20 to Space 25');
  });

  it('still says something with no frame info yet', () => {
    expect(describeStatusParts({ phase: PHASES.REPLAYING, currentPlayer: 0 }).text)
      .toBe('Replaying the last round…');
  });
});

describe('describeCard', () => {
  it('joins rank and suit, and names a joker', () => {
    expect(describeCard({ rank: 'K', suit: '♦' })).toBe('K♦');
    expect(describeCard({ rank: 'JOKER' })).toBe('a Joker');
    expect(describeCard(null)).toBeNull();
  });
});

describe('describeOutcome', () => {
  it('is null with no winner', () => {
    expect(describeOutcome(null)).toBeNull();
  });

  it('phrases a classic win and loss', () => {
    expect(describeOutcome(0, GAME_MODES.CLASSIC, [0])).toMatchObject({ won: true, text: 'You win!' });
    expect(describeOutcome(1, GAME_MODES.CLASSIC, [0])).toMatchObject({ won: false, text: 'Blue wins.' });
  });

  it('names both partners in partner mode', () => {
    expect(describeOutcome(0, GAME_MODES.PARTNERS, [0])).toMatchObject({
      won: true, text: 'You and Pink win!',
    });
    expect(describeOutcome(1, GAME_MODES.PARTNERS, [0])).toMatchObject({
      won: false, text: 'Blue and Green win.',
    });
  });

  it('reads correctly from the guest seat', () => {
    // The guest sits in seat 2 and is on team 0 with the host.
    expect(describeOutcome(0, GAME_MODES.PARTNERS, [2])).toMatchObject({
      won: true, text: 'You and Yellow win!',
    });
    expect(describeOutcome(1, GAME_MODES.PARTNERS, [2])).toMatchObject({
      won: false, text: 'Blue and Green win.',
    });
  });

  it('puts you first however the team is ordered', () => {
    expect(describeOutcome(1, GAME_MODES.PARTNERS, [3]).text).toBe('You and Blue win!');
  });
});

describe('describeBurn', () => {
  it('is not ready, and says so, until a card is picked', () => {
    const burn = describeBurn({ card: null });
    expect(burn.ready).toBe(false);
    expect(burn.label).toBe('Tap a card to burn');
  });

  it('names the action once a card is picked', () => {
    const burn = describeBurn({ card: { rank: '7', suit: '♠' } });
    expect(burn.ready).toBe(true);
    expect(burn.label).toBe('🔥 Burn this card');
  });

  it('warns on the burn that will start a peg', () => {
    // stuckCount is the burns already on the pile, so 2 means this is the third.
    expect(describeBurn({ stuckCount: 2 }).hint).toMatch(/starts a peg/);
    expect(describeBurn({ stuckCount: 2 }).hint).toMatch(/^Two burnt already/);
    expect(describeBurn({ stuckCount: 1 }).hint).toMatch(/^One burnt/);
    expect(describeBurn({ stuckCount: 0 }).hint).toMatch(/^Three burns in a row/);
  });
});

describe('attributeFrameDescription', () => {
  it('leaves the description alone when the actor moved their own peg', () => {
    expect(attributeFrameDescription('Space 3 to Space 10', 0, 0)).toBe('Space 3 to Space 10');
  });

  it('names the peg owner when it differs from the actor (playing a partner\'s hand)', () => {
    expect(attributeFrameDescription('Space 3 to Space 10', 0, 2))
      .toBe("Space 3 to Space 10 (moved Pink's peg)");
  });
});
