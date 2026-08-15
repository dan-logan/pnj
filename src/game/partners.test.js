import { describe, it, expect } from 'vitest';
import { GAME_MODES, getPartner, sameTeam } from './constants.js';
import {
  createInitialPegs,
  getStartPosition,
  getHomeEntrance,
  isValidMove,
  applyMove,
  applyComeOut,
  applyJoker,
  checkWinner,
  getValidDestinations,
  getMovablePegs,
  splitCompleter
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

  it('allows a joker whose only target is a partner already on their entrance', () => {
    const pegs = pegState([[0, 0, onTrack(10)], [2, 0, onTrack(getHomeEntrance(2))]]);
    // The partner keeps its entrance and the mover is friendly-bumped on to its
    // own home entrance instead (the "swap"), so the joker is a legal play.
    expect(isValidMove(0, 0, card('JOKER'), pegs, null, P0)).toBe(true);
    const { newPegs, bumped } = applyJoker(0, 0, 2, 0, pegs, P0);
    expect(bumped).toBe(true);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: getHomeEntrance(0) });
  });
});

describe('friendly partner bump: landing on a partner already on its own entrance', () => {
  // A partner sitting on its own home-entrance space can still be bumped: it
  // keeps that space (a peg can't block itself) and the mover is friendly-bumped
  // on to its own home entrance instead.
  const entrance2 = getHomeEntrance(2); // 39, the partner's home entrance

  it('lets a backward move land on a partner sitting on its entrance', () => {
    // Yellow eight spaces past the partner's entrance; partner is on the entrance.
    const pegs = pegState([[0, 0, onTrack(entrance2 + 8)], [2, 0, onTrack(entrance2)]]);
    expect(isValidMove(0, 0, card('8'), pegs, null, P0)).toBe(true);
    const { newPegs, bumpedOpponent } = applyMove(0, 0, card('8'), null, pegs, P0);
    expect(bumpedOpponent).toBe(true);
    // Partner stays put on its entrance; the mover is shoved to its own entrance.
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: entrance2 });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: getHomeEntrance(0) });
  });

  it('cascades an opponent off the mover’s own entrance during the swap', () => {
    const pegs = pegState([
      [0, 0, onTrack(entrance2 + 8)],
      [2, 0, onTrack(entrance2)],
      [1, 0, onTrack(getHomeEntrance(0))], // opponent squatting on the mover's entrance
    ]);
    const { newPegs } = applyMove(0, 0, card('8'), null, pegs, P0);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: entrance2 });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: getHomeEntrance(0) });
    expect(newPegs[1][0]).toMatchObject({ location: 'start' });
  });

  it('rejects the swap when the mover’s own entrance is held by its own peg', () => {
    const pegs = pegState([
      [0, 0, onTrack(entrance2 + 8)],
      [0, 1, onTrack(getHomeEntrance(0))], // mover's own peg blocks its entrance
      [2, 0, onTrack(entrance2)],
    ]);
    expect(isValidMove(0, 0, card('8'), pegs, null, P0)).toBe(false);
  });

  it('still knocks a non-partner off that space back to start in classic mode', () => {
    const pegs = pegState([[0, 0, onTrack(entrance2 + 8)], [2, 0, onTrack(entrance2)]]);
    const { newPegs } = applyMove(0, 0, card('8'), null, pegs); // classic
    expect(newPegs[2][0]).toMatchObject({ location: 'start' });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: entrance2 });
  });
});

describe('applyComeOut (stuck-3 mercy start) keeps partner rules', () => {
  const startPos0 = getStartPosition(0);

  it('friendly-bumps a partner off the come-out space to its home entrance', () => {
    const pegs = pegState([[2, 0, onTrack(startPos0)]]);
    const { newPegs, ok } = applyComeOut(0, 0, pegs, { actor: 0, mode: GAME_MODES.PARTNERS });
    expect(ok).toBe(true);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: startPos0 });
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
  });

  it('falls back to start only when the partner’s entrance is blocked by its own peg', () => {
    const pegs = pegState([
      [2, 0, onTrack(startPos0)],
      [2, 1, onTrack(getHomeEntrance(2))], // blocks the friendly bump
    ]);
    const { newPegs, ok } = applyComeOut(0, 0, pegs, { actor: 0, mode: GAME_MODES.PARTNERS });
    expect(ok).toBe(true);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: startPos0 });
    expect(newPegs[2][0]).toMatchObject({ location: 'start' });
    expect(newPegs[2][1]).toMatchObject({ location: 'track', position: getHomeEntrance(2) });
  });

  it('knocks an opponent on the come-out space back to start', () => {
    const pegs = pegState([[1, 0, onTrack(startPos0)]]);
    const { newPegs, ok, bumpedOpponent } = applyComeOut(0, 0, pegs, { actor: 0, mode: GAME_MODES.PARTNERS });
    expect(ok).toBe(true);
    expect(bumpedOpponent).toBe(true);
    expect(newPegs[1][0]).toMatchObject({ location: 'start' });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: startPos0 });
  });

  it('refuses when one of the player’s own pegs already holds the come-out space', () => {
    const pegs = pegState([[0, 1, onTrack(startPos0)]]);
    const { ok } = applyComeOut(0, 0, pegs, { actor: 0, mode: GAME_MODES.PARTNERS });
    expect(ok).toBe(false);
  });

  it('a normal validated come-out is still blocked when the partner’s entrance is jammed', () => {
    // The scenario that used to silently revert to solo rules: partner on your
    // come-out space, its entrance held by its own peg. A face-card start is
    // rejected; only the mercy start (applyComeOut) may force it.
    const pegs = pegState([
      [2, 0, onTrack(startPos0)],
      [2, 1, onTrack(getHomeEntrance(2))],
    ]);
    expect(isValidMove(0, 0, card('K'), pegs, null, P0)).toBe(false);
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

// The engine reports what it displaced; nothing about a friendly bump is
// recovered by diffing the board afterwards. Two cases are the reason, and both
// used to be wrong when this was a diff (`findFriendlyBumps`, now gone):
//
//   * an ordinary move that parks a peg on its own home entrance — the last
//     track space before the home corridor, so a completely routine landing —
//     was indistinguishable from a peg shoved there, and raised a phantom
//     "Partner Bump!" over an empty space whenever the diff wasn't told that
//     peg had moved (a split moves two, and only one was ever named);
//   * the entrance swap, where the peg displaced is the *mover* itself, which
//     any diff necessarily excludes as "the peg that meant to move" — so the
//     fanciest partner bump in the game announced nothing at all.
describe('applyMove displacements', () => {
  it('reports a partner shoved forward to its entrance, and who shoved it', () => {
    const pegs = pegState([[0, 0, onTrack(30)], [2, 0, onTrack(35)]]);
    const { displacements } = applyMove(0, 0, card('5'), null, pegs, P0);
    expect(displacements).toEqual([
      {
        player: 2, pegIndex: 0, fromPosition: 35, toPosition: getHomeEntrance(2),
        friendly: true, byPlayer: 0, byPegIndex: 0,
      },
    ]);
  });

  it('reports nothing when a split simply parks a peg on its own entrance', () => {
    const entrance0 = getHomeEntrance(0); // 3
    const pegs = pegState([[0, 0, onTrack(10)], [0, 1, onTrack(entrance0 - 3)]]);

    // A 7 split: 4 with one peg, then 3 with the other — landing it exactly on
    // its own entrance, with nothing else on the board to bump.
    const first = applyMove(0, 0, card('7'), 4, pegs, P0);
    const second = applyMove(0, 1, card('7'), 3, first.newPegs, P0);

    expect(second.newPegs[0][1].position).toBe(entrance0);
    expect(first.displacements).toEqual([]);
    expect(second.displacements).toEqual([]);
  });

  it('reports the swap: the mover is the peg displaced, by the partner it landed on', () => {
    const entrance0 = getHomeEntrance(0); // 3
    const entrance2 = getHomeEntrance(2); // 39
    // Yellow at 34 plays a 5 onto Pink, which is parked on its own entrance.
    const pegs = pegState([[0, 0, onTrack(34)], [2, 0, onTrack(entrance2)]]);
    const { newPegs, displacements } = applyMove(0, 0, card('5'), null, pegs, P0);

    // Pink keeps its entrance; Yellow is shoved on to its own.
    expect(newPegs[2][0].position).toBe(entrance2);
    expect(newPegs[0][0].position).toBe(entrance0);
    expect(displacements).toEqual([
      {
        player: 0, pegIndex: 0, fromPosition: entrance2, toPosition: entrance0,
        friendly: true, byPlayer: 2, byPegIndex: 0,
      },
    ]);
  });

  it('reports a cascade in causal order: friendly shove first, then who it knocked off', () => {
    const entrance2 = getHomeEntrance(2); // 39
    // Blue (opponent) is squatting on Pink's entrance; Yellow bumps Pink onto it.
    const pegs = pegState([
      [0, 0, onTrack(30)], [2, 0, onTrack(35)], [1, 0, onTrack(entrance2)],
    ]);
    const { displacements } = applyMove(0, 0, card('5'), null, pegs, P0);

    expect(displacements).toEqual([
      {
        player: 2, pegIndex: 0, fromPosition: 35, toPosition: entrance2,
        friendly: true, byPlayer: 0, byPegIndex: 0,
      },
      {
        player: 1, pegIndex: 0, fromPosition: entrance2, toPosition: null,
        friendly: false, byPlayer: 2, byPegIndex: 0,
      },
    ]);
  });

  it('reports an ordinary opponent bump as a send-to-start', () => {
    const pegs = pegState([[0, 0, onTrack(30)], [1, 0, onTrack(35)]]);
    const { displacements } = applyMove(0, 0, card('5'), null, pegs, P0);
    expect(displacements).toEqual([
      {
        player: 1, pegIndex: 0, fromPosition: 35, toPosition: null,
        friendly: false, byPlayer: 0, byPegIndex: 0,
      },
    ]);
  });

  it('reports the joker swap the same way as the track swap', () => {
    const entrance0 = getHomeEntrance(0);
    const entrance2 = getHomeEntrance(2);
    const pegs = pegState([[0, 0, onTrack(50)], [2, 0, onTrack(entrance2)]]);
    const { displacements } = applyJoker(0, 0, 2, 0, pegs, P0);
    expect(displacements).toEqual([
      {
        player: 0, pegIndex: 0, fromPosition: entrance2, toPosition: entrance0,
        friendly: true, byPlayer: 2, byPegIndex: 0,
      },
    ]);
  });
});

describe('joker onto a partner sitting on its own home entrance (Topher/Sara bug)', () => {
  // Jokering a teammate that's parked on its own home entrance used to be
  // rejected ("That joker bump is not legal"). It's the same swap as a track
  // move that lands there: the partner keeps its entrance and the mover is
  // friendly-bumped on to its own home entrance instead.
  const entrance0 = getHomeEntrance(0); // 3
  const entrance2 = getHomeEntrance(2); // 39, the partner's entrance

  it('is legal: partner keeps its entrance, the mover swaps to its own entrance', () => {
    const pegs = pegState([[0, 0, onTrack(50)], [2, 0, onTrack(entrance2)]]);
    const { newPegs, bumped, bumpedPlayer } = applyJoker(0, 0, 2, 0, pegs, P0);
    expect(bumped).toBe(true);
    expect(bumpedPlayer).toBe(2);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: entrance2 });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: entrance0 });
  });

  it('cascades an opponent off the mover’s own entrance during the swap', () => {
    const pegs = pegState([
      [0, 0, onTrack(50)],
      [2, 0, onTrack(entrance2)],
      [1, 0, onTrack(entrance0)], // opponent squatting on the mover's entrance
    ]);
    const { newPegs, bumped } = applyJoker(0, 0, 2, 0, pegs, P0);
    expect(bumped).toBe(true);
    expect(newPegs[2][0]).toMatchObject({ location: 'track', position: entrance2 });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: entrance0 });
    expect(newPegs[1][0]).toMatchObject({ location: 'start' });
  });

  it('is illegal when the mover’s own entrance is blocked by its own peg', () => {
    const pegs = pegState([
      [0, 0, onTrack(50)],
      [0, 1, onTrack(entrance0)], // mover's own peg blocks its entrance
      [2, 0, onTrack(entrance2)],
    ]);
    const { bumped } = applyJoker(0, 0, 2, 0, pegs, P0);
    expect(bumped).toBe(false);
  });

  it('still sends a non-partner back to start in classic mode (no swap)', () => {
    const pegs = pegState([[0, 0, onTrack(50)], [2, 0, onTrack(entrance2)]]);
    const { newPegs, bumped } = applyJoker(0, 0, 2, 0, pegs); // classic
    expect(bumped).toBe(true);
    expect(newPegs[2][0]).toMatchObject({ location: 'start' });
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: entrance2 });
  });
});

describe('splitCompleter: who finishes a 7/9 split', () => {
  const allHome = (player) => [0, 1, 2, 3, 4].map((i) => [player, i, inHome(i)]);

  it('hands the remainder to the partner once your last peg reaches home', () => {
    const afterFirst = pegState([...allHome(0), [2, 0, onTrack(20)]]);
    expect(splitCompleter(0, afterFirst, P0)).toBe(2);
  });

  it('keeps the split within your own pegs while any are still out', () => {
    const afterFirst = pegState([[0, 0, onTrack(20)], [2, 0, onTrack(20)]]);
    expect(splitCompleter(0, afterFirst, P0)).toBe(0);
  });

  it('never hands off in classic mode', () => {
    const afterFirst = pegState([...allHome(0), [2, 0, onTrack(20)]]);
    expect(splitCompleter(0, afterFirst, { mode: GAME_MODES.CLASSIC })).toBe(0);
  });

  it('does not hand off when both partners are already home (that is a win)', () => {
    const afterFirst = pegState([...allHome(0), ...allHome(2)]);
    expect(splitCompleter(0, afterFirst, P0)).toBe(0);
  });
});

describe('cross-team 7 split: your last peg home + partner takes the rest (Topher/Sara bug)', () => {
  const allHomeExceptLast = [
    [0, 0, inHome(1)],
    [0, 1, inHome(2)],
    [0, 2, inHome(3)],
    [0, 3, inHome(4)],
    [0, 4, onTrack(getHomeEntrance(0))], // last peg on its own entrance (space 3)
  ];

  it('offers the 1-into-home split when a partner peg can absorb the remaining 6', () => {
    const pegs = pegState([...allHomeExceptLast, [2, 0, onTrack(20)]]);
    const dests = getValidDestinations(0, 4, card('7'), pegs, P0);
    // amount 1 sends the last peg to Home 0 and hands the remaining 6 to Pink.
    expect(dests).toContainEqual({ amount: 1, location: 'home', homePosition: 0 });
    // The peg is therefore movable with the 7.
    expect(getMovablePegs(0, card('7'), pegs, P0)).toContain(4);
  });

  it('does not offer it when no partner peg can take the remaining 6', () => {
    // Partner pegs all in start (can't move by count), so the split can't complete.
    const pegs = pegState([...allHomeExceptLast]);
    const dests = getValidDestinations(0, 4, card('7'), pegs, P0);
    expect(dests).not.toContainEqual({ amount: 1, location: 'home', homePosition: 0 });
  });

  it('applies the two halves across both owners', () => {
    const pegs = pegState([...allHomeExceptLast, [2, 0, onTrack(20)]]);
    // First half: your last peg goes home.
    const { newPegs: afterFirst } = applyMove(0, 4, card('7'), 1, pegs, P0);
    expect(afterFirst[0].every((p) => p.location === 'home')).toBe(true);
    // Handoff: the remaining 6 is played on the partner's peg.
    expect(splitCompleter(0, afterFirst, P0)).toBe(2);
    const { newPegs: afterSecond } = applyMove(2, 0, card('7'), 6, afterFirst, P0);
    expect(afterSecond[2][0]).toMatchObject({ location: 'track', position: 26 });
  });
});

describe('AI handoff split: finish your last peg home, advance your partner', () => {
  const allHomeExceptLast = [
    [0, 0, inHome(1)],
    [0, 1, inHome(2)],
    [0, 2, inHome(3)],
    [0, 3, inHome(4)],
    [0, 4, onTrack(getHomeEntrance(0))], // last peg on its own entrance (space 3)
  ];

  it('enumerates a 7 split whose remainder is played on the partner', () => {
    const pegs = pegState([...allHomeExceptLast, [2, 0, onTrack(20)]]);
    const moves = getPossibleMoves(0, [card('7')], pegs, { mode: GAME_MODES.PARTNERS });
    const handoff = moves.find(
      (m) => m.type === 'split7' && m.amount === 1 && m.secondOwner === 2
    );
    expect(handoff).toBeTruthy();
    expect(handoff.secondPeg).toBe(0);
    expect(handoff.remaining).toBe(6);
    // Result: your last peg is home and the partner advanced 6.
    expect(handoff.newPegs[0].every((p) => p.location === 'home')).toBe(true);
    expect(handoff.newPegs[2][0]).toMatchObject({ location: 'track', position: 26 });
  });

  it('prefers the handoff split when it advances the team most', () => {
    const pegs = pegState([...allHomeExceptLast, [2, 0, onTrack(20)]]);
    const best = findBestAIMove(0, [card('7')], pegs, { mode: GAME_MODES.PARTNERS });
    expect(best.type).toBe('split7');
    expect(best.secondOwner).toBe(2);
    expect(best.newPegs[0].every((p) => p.location === 'home')).toBe(true);
  });
});
