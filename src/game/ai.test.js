import { describe, it, expect } from 'vitest';
import { createInitialPegs, getStartPosition, isValidMove } from './engine.js';
import { getPossibleMoves, findBestAIMove } from './ai.js';

const card = (rank, suit = '♠') => ({ rank, suit, id: `${rank}${suit}test` });

function pegState(placements = []) {
  const pegs = createInitialPegs();
  for (const [player, pegIndex, peg] of placements) {
    pegs[player][pegIndex] = { index: pegIndex, ...peg };
  }
  return pegs;
}

const onTrack = (position) => ({ location: 'track', position });
const inHome = (homePosition) => ({ location: 'home', homePosition });

describe('findBestAIMove', () => {
  it('returns null when the hand has no legal play', () => {
    // All pegs in start, no start cards
    const pegs = pegState();
    expect(findBestAIMove(1, [card('5'), card('2'), card('10')], pegs)).toBeNull();
  });

  it('starts a peg when holding a start card with everything in start', () => {
    const pegs = pegState();
    const move = findBestAIMove(1, [card('K'), card('5')], pegs);
    expect(move).not.toBeNull();
    // Start cards are enumerated via both the 'simple' and 'start' branches;
    // either way the peg must come out to the come-out spot
    expect(move.card.rank).toBe('K');
    expect(move.newPegs[1][move.pegIndex]).toMatchObject({
      location: 'track',
      position: getStartPosition(1)
    });
  });

  it('always returns a move that passes validation', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(40)], [2, 0, onTrack(35)]]);
    const hand = [card('5'), card('8'), card('A')];
    const move = findBestAIMove(1, hand, pegs);
    expect(move).not.toBeNull();
    expect(isValidMove(1, move.pegIndex, move.card, pegs, move.amount)).toBe(true);
  });

  it('uses a joker to bump an opponent when that is the only play', () => {
    const pegs = pegState([[0, 0, onTrack(30)]]);
    const move = findBestAIMove(1, [card('JOKER')], pegs);
    expect(move).not.toBeNull();
    expect(move.type).toBe('joker');
    expect(move.targetPlayer).toBe(0);
    expect(move.newPegs[0][move.targetPeg].location).toBe('start');
    expect(move.newPegs[1][move.pegIndex]).toMatchObject({ location: 'track', position: 30 });
  });

  it('prefers advancing a peg deep in home over a plain track move', () => {
    // Home move carries a +10 bonus, so with equal distance gain it should win
    const pegs = pegState([[1, 0, inHome(0)], [1, 1, onTrack(40)]]);
    const move = findBestAIMove(1, [card('4')], pegs);
    expect(move).not.toBeNull();
    expect(move.pegIndex).toBe(0);
    expect(move.newPegs[1][0]).toMatchObject({ location: 'home', homePosition: 4 });
  });

  it('completes a 9 as a two-peg forward/backward split', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(50)]]);
    const move = findBestAIMove(1, [card('9')], pegs);
    expect(move).not.toBeNull();
    expect(move.type).toBe('split9');
    expect(move.secondPeg).not.toBe(move.pegIndex);
    // Forward + backward amounts total 9
    expect(move.amount + Math.abs(move.remaining)).toBe(9);
    expect(move.amount).toBeGreaterThan(0);
    expect(move.remaining).toBeLessThan(0);
  });
});

describe('getPossibleMoves', () => {
  it('enumerates no moves for an unplayable hand', () => {
    const pegs = pegState();
    expect(getPossibleMoves(1, [card('5')], pegs)).toHaveLength(0);
  });

  it('includes both the full 7 and split-7 variants when legal', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(50)]]);
    const moves = getPossibleMoves(1, [card('7')], pegs);
    const types = new Set(moves.map(m => m.type));
    expect(types.has('simple')).toBe(true); // full 7
    expect(types.has('split7')).toBe(true); // split across two pegs
  });

  it('split-7 moves always use two different pegs', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(50)]]);
    const splits = getPossibleMoves(1, [card('7')], pegs).filter(m => m.type === 'split7');
    expect(splits.length).toBeGreaterThan(0);
    for (const move of splits) {
      expect(move.secondPeg).not.toBe(move.pegIndex);
      expect(move.amount + move.remaining).toBe(7);
    }
  });

  it('never proposes moving a peg parked on the final home spot', () => {
    const pegs = pegState([[1, 0, inHome(4)], [1, 1, onTrack(30)]]);
    const moves = getPossibleMoves(1, [card('2')], pegs);
    expect(moves.every(m => m.pegIndex !== 0)).toBe(true);
  });

  it('penalizes landing on an opponent come-out spot', () => {
    // Peg landing exactly on player 0's come-out spot (8) vs a safe spot
    const riskyPegs = pegState([[1, 0, onTrack(3)]]);  // 3 + 5 = 8 (Yellow's come-out)
    const safePegs = pegState([[1, 0, onTrack(4)]]);   // 4 + 5 = 9 (safe)
    const [risky] = getPossibleMoves(1, [card('5')], riskyPegs);
    const [safe] = getPossibleMoves(1, [card('5')], safePegs);
    expect(risky.bonus).toBeLessThan(safe.bonus);
  });
});
