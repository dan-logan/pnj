import { describe, it, expect } from 'vitest';
import { diffPegEvents } from './events.js';
import { createInitialPegs, applyMove, applyComeOut } from './engine.js';

const card = (rank, suit = '♠') => ({ rank, suit, id: `${rank}${suit}test` });

// A board where `player`'s pegs sit wherever you say, and everyone else is
// still in their start area.
const boardWith = (player, placements) => {
  const pegs = createInitialPegs();
  placements.forEach((p, i) => {
    pegs[player][i] = { ...pegs[player][i], ...p };
  });
  return pegs;
};

describe('diffPegEvents', () => {
  it('reports nothing for an unchanged board', () => {
    const pegs = createInitialPegs();
    expect(diffPegEvents(pegs, pegs)).toEqual({ cameOut: [], reachedHome: [], finishedAll: [] });
  });

  it('reports a peg coming out of start', () => {
    const before = createInitialPegs();
    const { newPegs } = applyComeOut(0, 0, before);
    const events = diffPegEvents(before, newPegs);
    expect(events.cameOut).toEqual([{ player: 0, pegIndex: 0 }]);
    expect(events.reachedHome).toEqual([]);
    expect(events.finishedAll).toEqual([]);
  });

  it('reports a peg reaching home', () => {
    // Player 0's home entrance is space 3, and a peg turns in when it would
    // step onto space 4 — so an A played from 3 lands in the corridor.
    const before = boardWith(0, [{ location: 'track', position: 3 }]);
    const { newPegs } = applyMove(0, 0, card('A'), null, before);
    expect(newPegs[0][0].location).toBe('home');

    const events = diffPegEvents(before, newPegs);
    expect(events.reachedHome).toEqual([{ player: 0, pegIndex: 0 }]);
    expect(events.cameOut).toEqual([]);
  });

  it('flags the seat that just finished, once', () => {
    // Home fills from the back: a peg cannot jump over its own pegs in the
    // corridor, so the last one home is the one that takes slot 0.
    const before = boardWith(0, [
      { location: 'home', homePosition: 1 },
      { location: 'home', homePosition: 2 },
      { location: 'home', homePosition: 3 },
      { location: 'home', homePosition: 4 },
      { location: 'track', position: 3 },
    ]);
    const { newPegs } = applyMove(0, 4, card('A'), null, before);
    expect(newPegs[0].every(p => p.location === 'home')).toBe(true);

    const events = diffPegEvents(before, newPegs);
    expect(events.finishedAll).toEqual([0]);
    expect(events.reachedHome).toEqual([{ player: 0, pegIndex: 4 }]);
  });

  it('does not re-flag a seat that was already finished', () => {
    // The partner-mode case: your pegs are all home and your cards are moving
    // your partner's. Without the transition check this would fire the "all
    // home" flourish on every remaining move of the game.
    const before = boardWith(0, [
      { location: 'home', homePosition: 0 },
      { location: 'home', homePosition: 1 },
      { location: 'home', homePosition: 2 },
      { location: 'home', homePosition: 3 },
      { location: 'home', homePosition: 4 },
    ]);
    const after = before.map(row => row.map(p => ({ ...p })));
    after[2][0] = { ...after[2][0], location: 'track', position: 40 };

    const events = diffPegEvents(before, after);
    expect(events.finishedAll).toEqual([]);
    expect(events.cameOut).toEqual([{ player: 2, pegIndex: 0 }]);
  });

  it('reports events for every seat, not just the mover', () => {
    // A bump sends someone else's peg back to start; that is not a "came out"
    // and must not be announced as one.
    const before = createInitialPegs();
    const after = before.map(row => row.map(p => ({ ...p })));
    after[1][0] = { ...after[1][0], location: 'track', position: 26 };
    after[3][2] = { ...after[3][2], location: 'track', position: 62 };

    const events = diffPegEvents(before, after);
    expect(events.cameOut).toEqual([
      { player: 1, pegIndex: 0 },
      { player: 3, pegIndex: 2 },
    ]);
  });

  it('treats a peg knocked back to start as no event at all', () => {
    const before = createInitialPegs();
    before[1][0] = { ...before[1][0], location: 'track', position: 26 };
    const after = createInitialPegs();

    expect(diffPegEvents(before, after)).toEqual({
      cameOut: [], reachedHome: [], finishedAll: [],
    });
  });

  it('tolerates a missing or partial board', () => {
    const pegs = createInitialPegs();
    expect(() => diffPegEvents(null, pegs)).not.toThrow();
    expect(() => diffPegEvents(pegs, undefined)).not.toThrow();
    expect(diffPegEvents(null, pegs).cameOut).toEqual([]);
  });
});
