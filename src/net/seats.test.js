import { describe, it, expect } from 'vitest';
import {
  SOLO_SEAT_OWNERS,
  mySeatsOf,
  primarySeat,
  isMySeat,
  isAISeat,
  isMyTurnFor,
  visualSideFor,
  seatAtVisualSide,
  nextHumanSeat,
} from './seats.js';

const SOLO = SOLO_SEAT_OWNERS;
const HOST = ['me', 'ai', 'them', 'ai'];
const GUEST = ['them', 'ai', 'me', 'ai'];

describe('seat ownership', () => {
  it('finds the owned seats for each layout', () => {
    expect(mySeatsOf(SOLO)).toEqual([0]);
    expect(mySeatsOf(HOST)).toEqual([0]);
    expect(mySeatsOf(GUEST)).toEqual([2]);
  });

  it('supports a client driving more than one seat', () => {
    expect(mySeatsOf(['me', 'ai', 'me', 'ai'])).toEqual([0, 2]);
    expect(primarySeat(['me', 'ai', 'me', 'ai'])).toBe(0);
  });

  it('picks the primary seat, defaulting to 0 with nothing owned', () => {
    expect(primarySeat(SOLO)).toBe(0);
    expect(primarySeat(GUEST)).toBe(2);
    expect(primarySeat(['them', 'ai', 'them', 'ai'])).toBe(0);
  });

  it('classifies seats', () => {
    expect(isMySeat(GUEST, 2)).toBe(true);
    expect(isMySeat(GUEST, 0)).toBe(false);
    expect(isAISeat(GUEST, 1)).toBe(true);
    expect(isAISeat(GUEST, 0)).toBe(false); // 'them' is not an AI seat
    expect(isAISeat(SOLO, 3)).toBe(true);
  });

  it('gates turns on seat ownership, not on seat 0', () => {
    expect(isMyTurnFor(SOLO, 0)).toBe(true);
    expect([1, 2, 3].every(p => !isMyTurnFor(SOLO, p))).toBe(true);

    expect(isMyTurnFor(GUEST, 2)).toBe(true);
    expect([0, 1, 3].every(p => !isMyTurnFor(GUEST, p))).toBe(true);
  });
});

describe('board orientation', () => {
  // Visual sides: 0 top, 1 right, 2 bottom, 3 left.
  it('is identical to the original (x + 2) % 4 when mySeat is 0', () => {
    for (const x of [0, 1, 2, 3]) {
      expect(visualSideFor(x, 0)).toBe((x + 2) % 4);
    }
  });

  it('puts your own seat at the bottom for every seat', () => {
    for (const mySeat of [0, 1, 2, 3]) {
      expect(visualSideFor(mySeat, mySeat)).toBe(2);
    }
  });

  it('keeps the seating order around the board (partner opposite you)', () => {
    for (const mySeat of [0, 1, 2, 3]) {
      const partner = (mySeat + 2) % 4;
      expect(visualSideFor(partner, mySeat)).toBe(0); // partner is across the top
    }
  });

  it('maps the four seats onto the four sides without collisions', () => {
    for (const mySeat of [0, 1, 2, 3]) {
      const sides = [0, 1, 2, 3].map(x => visualSideFor(x, mySeat));
      expect([...sides].sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it('never produces a negative side', () => {
    // (x - mySeat + 2) goes negative for x=0, mySeat=3 without the wrap.
    expect(visualSideFor(0, 3)).toBe(3);
    for (const mySeat of [0, 1, 2, 3]) {
      for (const x of [0, 1, 2, 3]) {
        expect(visualSideFor(x, mySeat)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('seatAtVisualSide inverts visualSideFor', () => {
    for (const mySeat of [0, 1, 2, 3]) {
      for (const x of [0, 1, 2, 3]) {
        expect(seatAtVisualSide(visualSideFor(x, mySeat), mySeat)).toBe(x);
      }
    }
  });

  it('reproduces today’s solo label placement', () => {
    // Today: Pink (2) top, Green (3) right, Yellow (0) bottom, Blue (1) left.
    expect(seatAtVisualSide(0, 0)).toBe(2);
    expect(seatAtVisualSide(1, 0)).toBe(3);
    expect(seatAtVisualSide(2, 0)).toBe(0);
    expect(seatAtVisualSide(3, 0)).toBe(1);
  });

  it('gives the guest the same view of their own side', () => {
    // Guest sits in seat 2: their pegs at the bottom, host (0) across the top,
    // and the two AI seats on the same left/right sides relative to them.
    expect(visualSideFor(2, 2)).toBe(2);
    expect(visualSideFor(0, 2)).toBe(0);
    expect(visualSideFor(3, 2)).toBe(3);
    expect(visualSideFor(1, 2)).toBe(1);
  });
});

describe('nextHumanSeat', () => {
  const HOST = ['me', 'ai', 'them', 'ai'];
  const GUEST = ['them', 'ai', 'me', 'ai'];

  it('returns the same seat when it is already human', () => {
    expect(nextHumanSeat(0, HOST)).toBe(0);
    expect(nextHumanSeat(2, HOST)).toBe(2);
  });

  it('walks the fixed turn order to the next human seat', () => {
    // After the host (0) moves, currentPlayer parks on AI seat 1; the next human
    // is the guest at 2.
    expect(nextHumanSeat(1, HOST)).toBe(2);
    // After the guest (2) moves, currentPlayer parks on AI seat 3; the next human
    // is the host at 0.
    expect(nextHumanSeat(3, HOST)).toBe(0);
  });

  it('gives the same absolute seat whichever client’s layout you pass', () => {
    // This is why it is safe to store in the shared metadata: seats 1 and 3 are
    // 'ai' in both layouts, so the answer does not depend on point of view.
    for (const from of [0, 1, 2, 3]) {
      expect(nextHumanSeat(from, HOST)).toBe(nextHumanSeat(from, GUEST));
    }
  });

  it('in solo, every seat leads back to seat 0', () => {
    for (const from of [0, 1, 2, 3]) {
      expect(nextHumanSeat(from, SOLO_SEAT_OWNERS)).toBe(0);
    }
  });
});
