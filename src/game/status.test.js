import { describe, it, expect } from 'vitest';
import { PHASES, derivePhase, describeStatus, describeOutcome } from './status.js';
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
  it('reports a finished game above everything else', () => {
    // This is the bug the derived model exists to kill: mid-animation, mid-AI
    // turn, mid-replay — once there is a winner the phase is finished.
    expect(derivePhase({ ...base, winner: 0 })).toBe(PHASES.FINISHED);
    expect(derivePhase({ ...base, winner: 1, isReplaying: true, isMyTurn: true })).toBe(PHASES.FINISHED);
    expect(derivePhase({ ...base, winner: 0, dealt: false })).toBe(PHASES.FINISHED);
  });

  it('treats winner 0 as a winner, not as falsy', () => {
    expect(derivePhase({ ...base, winner: 0, isMyTurn: true })).toBe(PHASES.FINISHED);
  });

  it('locks into replaying while playback runs', () => {
    expect(derivePhase({ ...base, isReplaying: true, isMyTurn: true })).toBe(PHASES.REPLAYING);
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

  it('puts discard mode ahead of the other prompts', () => {
    expect(describeStatus({
      phase: PHASES.MY_TURN, currentPlayer: 0, discardMode: true, jokerMode: true,
    })).toBe('Select a card to discard.');
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
