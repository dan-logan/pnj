import { describe, it, expect } from 'vitest';
import { GAME_MODES, getPartner, sameTeam } from './constants.js';
import {
  createInitialPegs,
  getStartPosition,
  getHomeEntrance,
  isValidMove,
  applyMove,
  applyJoker,
  checkWinner,
  getValidDestinations,
  getMovablePegs,
  findFriendlyBumps
} from './engine.js';
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

// Partner-mode options: player 0 acting.
const P0 = { actor: 0, mode: GAME_MODES.PARTNERS };

describe('team helpers', () => {
  it('pairs players sitting opposite (0+2, 1+3)', () => {
    expect(getPartner(0)).toBe(2);
    expect(getPartner(2)).toBe(0);
    expect(getPartner(1)).toBe(3);
    expect(getPartner(3)).toBe(1);
  });

  it('sameTeam is true for a player, its partner, and itself', () => {
    expect(sameTeam(0, 2)).toBe(true);
    expect(sameTeam(0, 0)).toBe(true);
    expect(sameTeam(0, 1)).toBe(false);
    expect(sameTeam(1, 3)).toBe(true);
  });
});

describe('checkWinner in partner mode', () => {
  const allHome = (player) =>
    [0, 1, 2, 3, 4].map((i) => [player, i, inHome(i)]);

  it('does not win when only one partner is fully home', () => {
    const pegs = pegState(allHome(0));
    expect(checkWinner(pegs, GAME_MODES.PARTNERS)).toBeNull();
  });

  it('wins when both partners are fully home (returns team index)', () => {
    const pegs = pegState([...allHome(0), ...allHome(2)]);
    expect(checkWinner(pegs, GAME_MODES.PARTNERS)).toBe(0);
  });

  it('recognises the other team winning', () => {
    const pegs = pegState([...allHome(1), ...allHome(3)]);
    expect(checkWinner(pegs, GAME_MODES.PARTNERS)).toBe(1);
  });

  it('still returns a single player in classic mode', () => {
    const pegs = pegState(allHome(2));
    expect(checkWinner(pegs)).toBe(2);
  });
});

describe('friendly partner bump: destination is the entrance space', () => {
  it('landing on a partner sends them to their home-entrance space', () => {
    const pegs = pegState([[0, 0, onTrack(30)], [2, 0, onTrack(35)]]);
    const { newPegs, bumpedOpponent } = applyMove(0, 0, card('5'), null, pegs, P0);
    expect(bumpedOpponent).toBe(true);
    expect(newPegs[0][0].position).toBe(35);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
  });

  it('a joker onto a partner sends them to their home-entrance space', () => {
    const pegs = pegState([[0, 0, onTrack(10)], [2, 0, onTrack(35)]]);
    const { newPegs, bumped, bumpedPlayer } = applyJoker(0, 0, 2, 0, pegs, P0);
    expect(bumped).toBe(true);
    expect(bumpedPlayer).toBe(2);
    expect(newPegs[0][0].position).toBe(35);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
  });

  it('bumping a partner off the come-out spot sends them to their entrance', () => {
    const startPos = getStartPosition(0);
    const pegs = pegState([[2, 0, onTrack(startPos)]]);
    const { newPegs } = applyMove(0, 0, card('K'), null, pegs, P0);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: startPos });
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
  });

  it('an opponent is still knocked back to start, not to an entrance', () => {
    const pegs = pegState([[0, 0, onTrack(30)], [1, 0, onTrack(35)]]);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs, P0);
    expect(newPegs[1][0]).toMatchObject({ location: 'start' });
  });
});

describe('friendly partner bump: cascades at the entrance', () => {
  it('cascades an opponent occupying the entrance back to start', () => {
    const pegs = pegState([
      [0, 0, onTrack(30)],
      [2, 0, onTrack(35)],
      [1, 0, onTrack(getHomeEntrance(2))],
    ]);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs, P0);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
    expect(newPegs[1][0]).toMatchObject({ location: 'start' });
  });

  it('cascades your own peg on the entrance to your own entrance', () => {
    const pegs = pegState([
      [0, 0, onTrack(30)],
      [0, 1, onTrack(getHomeEntrance(2))],
      [2, 0, onTrack(35)],
    ]);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs, P0);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
    expect(newPegs[0][1]).toMatchObject({ location: 'track', position: getHomeEntrance(0) });
    expect(newPegs[0][0].position).toBe(35);
  });
});

describe('friendly partner bump: illegal when the entrance is blocked by a sibling', () => {
  it('rejects a landing bump that would push a partner onto their own peg', () => {
    // Partner peg A sits on its entrance; partner peg B is one space past it.
    const pegs = pegState([
      [0, 0, onTrack(getHomeEntrance(2) - 2)],
      [2, 0, onTrack(getHomeEntrance(2))],
      [2, 1, onTrack(getHomeEntrance(2) + 1)],
    ]);
    // Player 0 with a 3 would land on peg B and try to bump it to the entrance,
    // which peg A already holds → illegal in partner mode.
    expect(isValidMove(0, 0, card('3'), pegs, null, P0)).toBe(false);
    // In classic mode the same move is a legal opponent-style bump.
    expect(isValidMove(0, 0, card('3'), pegs)).toBe(true);
  });

  it('rejects a joker whose only target is a partner already on their entrance', () => {
    const pegs = pegState([[0, 0, onTrack(10)], [2, 0, onTrack(getHomeEntrance(2))]]);
    // The friendly bump would need to send the partner to the space it already
    // occupies, which the mover is taking → no legal target.
    expect(isValidMove(0, 0, card('JOKER'), pegs, null, P0)).toBe(false);
  });
});

describe('playing for your partner (owner != actor)', () => {
  it('lets the actor advance a partner peg with a plain card', () => {
    const pegs = pegState([[2, 0, onTrack(50)]]);
    expect(isValidMove(2, 0, card('5'), pegs, null, P0)).toBe(true);
    const { newPegs } = applyMove(2, 0, card('5'), null, pegs, P0);
    expect(newPegs[2][0].position).toBe(55);
  });

  it('routes a partner peg into the partner home corridor, not the actor', () => {
    // Partner (player 2) peg one step from its home entry point.
    const pegs = pegState([[2, 0, onTrack(getHomeEntrance(2))]]);
    const dests = getValidDestinations(2, 0, card('3'), pegs, P0);
    expect(dests).toContainEqual({ amount: null, location: 'home', homePosition: 2 });
  });

  it('getMovablePegs reports partner pegs the actor can move', () => {
    const pegs = pegState([[2, 0, onTrack(50)], [2, 1, inHome(4)]]);
    const movable = getMovablePegs(2, card('5'), pegs, P0);
    expect(movable).toContain(0);
    expect(movable).not.toContain(1); // already home at the final spot
  });
});

describe('partner-aware AI', () => {
  const partnersMode = { mode: GAME_MODES.PARTNERS };
  const allHome = (player) => [0, 1, 2, 3, 4].map((i) => [player, i, inHome(i)]);

  it('plays for its partner once its own pegs are all home', () => {
    const pegs = pegState([...allHome(0), [2, 0, onTrack(50)]]);
    // Classic: nothing to do (own pegs all home, no partner control).
    expect(findBestAIMove(0, [card('5')], pegs)).toBeNull();
    // Partner mode: it advances the partner's peg instead.
    const move = findBestAIMove(0, [card('5')], pegs, partnersMode);
    expect(move).not.toBeNull();
    expect(move.owner).toBe(2);
    expect(move.newPegs[2][0].position).toBe(55);
  });

  it('uses a joker to friendly-bump a lagging partner to their home entrance', () => {
    // Own peg on track to act as the joker source; partner far back on the track.
    const pegs = pegState([[0, 0, onTrack(10)], [2, 0, onTrack(40)]]);
    const move = findBestAIMove(0, [card('JOKER')], pegs, partnersMode);
    expect(move).not.toBeNull();
    expect(move.type).toBe('joker');
    expect(move.targetPlayer).toBe(2);
    expect(move.newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
  });

  it('scores by team distance, tagging every move with its owner', () => {
    const pegs = pegState([[0, 0, onTrack(30)], [2, 0, onTrack(50)]]);
    const moves = getPossibleMoves(0, [card('5')], pegs, partnersMode);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.owner === 0)).toBe(true);
  });
});

describe('findFriendlyBumps', () => {
  it('reports a partner shoved forward to its entrance, excluding the mover', () => {
    const pegs = pegState([[0, 0, onTrack(30)], [2, 0, onTrack(35)]]);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs, P0);
    const bumps = findFriendlyBumps(pegs, newPegs, { player: 0, pegIndex: 0 });
    expect(bumps).toEqual([
      { player: 2, pegIndex: 0, fromPosition: 35, toPosition: getHomeEntrance(2) },
    ]);
  });
});
