import { describe, it, expect } from 'vitest';
import {
  createInitialPegs,
  getStartPosition,
  getHomeEntrance,
  getDistanceToHome,
  describeMoveAction,
  findPegAtPosition,
  isValidMove,
  hasAnyValidMove,
  applyMove,
  checkWinner,
  calculateMovePath,
  getValidDestinations,
  getMovablePegs,
  explainNoMove,
  findBumps
} from './engine.js';
import { TRACK_LENGTH } from './constants.js';

const card = (rank, suit = '♠') => ({ rank, suit, id: `${rank}${suit}test` });

// Build a full 4x5 peg state, then place specific pegs.
// placements: array of [player, pegIndex, peg] tuples
function pegState(placements = []) {
  const pegs = createInitialPegs();
  for (const [player, pegIndex, peg] of placements) {
    pegs[player][pegIndex] = { index: pegIndex, ...peg };
  }
  return pegs;
}

const onTrack = (position) => ({ location: 'track', position });
const inHome = (homePosition) => ({ location: 'home', homePosition });

describe('board geometry', () => {
  it('come-out spot is position 8 on each side', () => {
    expect(getStartPosition(0)).toBe(8);
    expect(getStartPosition(1)).toBe(26);
    expect(getStartPosition(2)).toBe(44);
    expect(getStartPosition(3)).toBe(62);
  });

  it('home entrance is position 3 on each side', () => {
    expect(getHomeEntrance(0)).toBe(3);
    expect(getHomeEntrance(3)).toBe(57);
  });
});

describe('getDistanceToHome', () => {
  it('is large for pegs in start', () => {
    expect(getDistanceToHome({ location: 'start', index: 0 }, 0)).toBe(100);
  });

  it('counts remaining home spots for pegs in home', () => {
    expect(getDistanceToHome(inHome(4), 0)).toBe(0);
    expect(getDistanceToHome(inHome(0), 0)).toBe(4);
  });

  it('decreases as a track peg approaches its home entry point', () => {
    const far = getDistanceToHome(onTrack(10), 0);
    const near = getDistanceToHome(onTrack(70), 0);
    expect(near).toBeLessThan(far);
  });
});

describe('isValidMove: leaving start', () => {
  it('allows A, J, Q, K from start', () => {
    const pegs = pegState();
    for (const rank of ['A', 'J', 'Q', 'K']) {
      expect(isValidMove(0, 0, card(rank), pegs)).toBe(true);
    }
  });

  it('rejects number cards from start', () => {
    const pegs = pegState();
    for (const rank of ['2', '5', '7', '8', '9', '10']) {
      expect(isValidMove(0, 0, card(rank), pegs)).toBe(false);
    }
  });

  it('rejects starting when own peg occupies the come-out spot', () => {
    const pegs = pegState([[0, 1, onTrack(getStartPosition(0))]]);
    expect(isValidMove(0, 0, card('A'), pegs)).toBe(false);
  });

  it('allows starting onto an opponent peg at the come-out spot (bump)', () => {
    const pegs = pegState([[1, 0, onTrack(getStartPosition(0))]]);
    expect(isValidMove(0, 0, card('A'), pegs)).toBe(true);
  });
});

describe('isValidMove: track movement', () => {
  it('allows a simple forward move', () => {
    const pegs = pegState([[0, 0, onTrack(20)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(true);
  });

  it('moves backward with an 8', () => {
    const pegs = pegState([[0, 0, onTrack(20)]]);
    expect(isValidMove(0, 0, card('8'), pegs)).toBe(true);
    const { newPegs } = applyMove(0, 0, card('8'), null, pegs);
    expect(newPegs[0][0].position).toBe(12);
  });

  it('wraps backward moves around position 0', () => {
    const pegs = pegState([[0, 0, onTrack(5)]]);
    const { newPegs } = applyMove(0, 0, card('8'), null, pegs);
    expect(newPegs[0][0].position).toBe(69);
  });

  it('rejects landing on your own peg', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [0, 1, onTrack(25)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(false);
  });

  it('rejects jumping over your own peg', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [0, 1, onTrack(22)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(false);
  });

  it('rejects jumping over your own peg when moving backward', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [0, 1, onTrack(15)]]);
    expect(isValidMove(0, 0, card('8'), pegs)).toBe(false);
  });

  it('allows landing on an opponent peg (bump)', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [1, 0, onTrack(25)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(true);
  });

  it('allows jumping over opponent pegs', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [1, 0, onTrack(22)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(true);
  });

  it('rejects a 9 played without a split amount', () => {
    const pegs = pegState([[0, 0, onTrack(20)]]);
    expect(isValidMove(0, 0, card('9'), pegs)).toBe(false);
    expect(isValidMove(0, 0, card('9'), pegs, 4)).toBe(true);
    expect(isValidMove(0, 0, card('9'), pegs, -5)).toBe(true);
  });
});

describe('isValidMove: home entry and home movement', () => {
  // Player 0's home entry point is track position 4 (one past entrance 3)

  it('enters home when passing the entry point with an exact fit', () => {
    // From 0, a 5 reaches entry point (4) in 4 steps, then 1 step into home
    const pegs = pegState([[0, 0, onTrack(0)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(true);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs);
    expect(newPegs[0][0]).toMatchObject({ location: 'home', homePosition: 1 });
  });

  it('continues on track when the move would overshoot the home corridor', () => {
    // From 0, a 10 would need home position 6 - overshoots, stays on track
    const pegs = pegState([[0, 0, onTrack(0)]]);
    const { newPegs } = applyMove(0, 0, card('10'), null, pegs);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: 10 });
  });

  it('continues on track when the home destination is occupied', () => {
    const pegs = pegState([[0, 0, onTrack(0)], [0, 1, inHome(1)]]);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(true);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: 5 });
  });

  it('rejects entering home past your own peg in the corridor', () => {
    // Entering at home position 1 would jump over own peg at home 0
    const pegs = pegState([[0, 0, onTrack(0)], [0, 1, inHome(0)]]);
    const { newPegs } = applyMove(0, 0, card('5'), null, pegs);
    expect(newPegs[0][0].location).toBe('track'); // fell through to track move
  });

  it('does not enter an opponent home corridor', () => {
    // Player 1 peg passing player 0's entry point stays on track
    const pegs = pegState([[1, 0, onTrack(0)]]);
    const { newPegs } = applyMove(1, 0, card('5'), null, pegs);
    expect(newPegs[1][0]).toMatchObject({ location: 'track', position: 5 });
  });

  it('moves forward within home with an exact fit only', () => {
    const pegs = pegState([[0, 0, inHome(0)]]);
    expect(isValidMove(0, 0, card('4'), pegs)).toBe(true);
    expect(isValidMove(0, 0, card('5'), pegs)).toBe(false); // overshoots position 4
  });

  it('rejects landing on or jumping over your own peg in home', () => {
    const pegs = pegState([[0, 0, inHome(0)], [0, 1, inHome(2)]]);
    expect(isValidMove(0, 0, card('2'), pegs)).toBe(false); // lands on it
    expect(isValidMove(0, 0, card('3'), pegs)).toBe(false); // jumps over it
  });

  it('rejects backward cards and jokers in home', () => {
    const pegs = pegState([[0, 0, inHome(2)], [1, 0, onTrack(30)]]);
    expect(isValidMove(0, 0, card('8'), pegs)).toBe(false);
    expect(isValidMove(0, 0, card('JOKER'), pegs)).toBe(false);
  });

  it('allows only forward amounts for a 9 in home', () => {
    const pegs = pegState([[0, 0, inHome(0)]]);
    expect(isValidMove(0, 0, card('9'), pegs, 3)).toBe(true);
    expect(isValidMove(0, 0, card('9'), pegs, -3)).toBe(false);
    expect(isValidMove(0, 0, card('9'), pegs)).toBe(false);
  });
});

describe('isValidMove: joker', () => {
  it('is valid from start or track when an opponent is on the track', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [1, 0, onTrack(40)]]);
    expect(isValidMove(0, 0, card('JOKER'), pegs)).toBe(true); // from track
    expect(isValidMove(0, 1, card('JOKER'), pegs)).toBe(true); // from start
  });

  it('is invalid when no opponent peg is on the track', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [1, 0, inHome(0)]]);
    expect(isValidMove(0, 0, card('JOKER'), pegs)).toBe(false);
  });
});

describe('applyMove', () => {
  it('does not mutate the input peg state', () => {
    const pegs = pegState([[0, 0, onTrack(20)]]);
    applyMove(0, 0, card('5'), null, pegs);
    expect(pegs[0][0].position).toBe(20);
  });

  it('wraps forward moves around the track', () => {
    const pegs = pegState([[1, 0, onTrack(70)]]);
    const { newPegs } = applyMove(1, 0, card('5'), null, pegs);
    expect(newPegs[1][0].position).toBe(3);
  });

  it('bumps an opponent peg back to start on landing', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [1, 0, onTrack(25)]]);
    const { newPegs, bumpedOpponent } = applyMove(0, 0, card('5'), null, pegs);
    expect(bumpedOpponent).toBe(true);
    expect(newPegs[0][0].position).toBe(25);
    expect(newPegs[1][0]).toMatchObject({ location: 'start', index: 0 });
  });

  it('starting a peg places it at the come-out spot and bumps an opponent there', () => {
    const startPos = getStartPosition(0);
    const pegs = pegState([[1, 0, onTrack(startPos)]]);
    const { newPegs, bumpedOpponent } = applyMove(0, 0, card('K'), null, pegs);
    expect(bumpedOpponent).toBe(true);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: startPos });
    expect(newPegs[1][0].location).toBe('start');
  });

  it('joker bumps an opponent and takes its spot', () => {
    const pegs = pegState([[1, 2, onTrack(33)]]);
    const { newPegs, bumpedOpponent } = applyMove(0, 0, card('JOKER'), null, pegs);
    expect(bumpedOpponent).toBe(true);
    expect(newPegs[0][0]).toMatchObject({ location: 'track', position: 33 });
    expect(newPegs[1][2].location).toBe('start');
  });

  it('advances within the home corridor', () => {
    const pegs = pegState([[0, 0, inHome(1)]]);
    const { newPegs } = applyMove(0, 0, card('3'), null, pegs);
    expect(newPegs[0][0]).toMatchObject({ location: 'home', homePosition: 4 });
  });
});

describe('checkWinner', () => {
  it('returns null when no player has all pegs home', () => {
    expect(checkWinner(pegState())).toBeNull();
  });

  it('returns the player index once all 5 pegs are home', () => {
    const pegs = pegState([
      [2, 0, inHome(0)], [2, 1, inHome(1)], [2, 2, inHome(2)], [2, 3, inHome(3)], [2, 4, inHome(4)]
    ]);
    expect(checkWinner(pegs)).toBe(2);
  });
});

describe('hasAnyValidMove', () => {
  it('is false with only number cards and all pegs in start', () => {
    const pegs = pegState();
    expect(hasAnyValidMove(0, [card('5'), card('2'), card('10')], pegs)).toBe(false);
  });

  it('is true when holding a start card with pegs in start', () => {
    const pegs = pegState();
    expect(hasAnyValidMove(0, [card('5'), card('A')], pegs)).toBe(true);
  });

  it('is true when a 9 has a legal forward/backward split', () => {
    const pegs = pegState([[0, 0, onTrack(20)], [0, 1, onTrack(40)]]);
    expect(hasAnyValidMove(0, [card('9')], pegs)).toBe(true);
  });

  it('detects a playable joker when an opponent is on the track', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    expect(hasAnyValidMove(0, [card('JOKER')], pegs)).toBe(true);
  });

  it('joker alone is not playable when opponents are all in start', () => {
    const pegs = pegState();
    expect(hasAnyValidMove(0, [card('JOKER')], pegs)).toBe(false);
  });
});

describe('calculateMovePath', () => {
  it('emits one step per space for a track move', () => {
    const pegs = pegState([[0, 0, onTrack(20)]]);
    const path = calculateMovePath(0, 0, card('5'), null, pegs);
    expect(path).toHaveLength(5);
    expect(path[path.length - 1]).toEqual({ type: 'track', position: 25 });
  });

  it('routes into home when entering the corridor', () => {
    const pegs = pegState([[0, 0, onTrack(0)]]);
    const path = calculateMovePath(0, 0, card('5'), null, pegs);
    expect(path).toHaveLength(5);
    expect(path[path.length - 1]).toEqual({ type: 'home', position: 1 });
    // Space 4 is home slot 0, so it is never drawn as a track space.
    expect(path).toEqual([
      { type: 'track', position: 1 },
      { type: 'track', position: 2 },
      { type: 'track', position: 3 },
      { type: 'home', position: 0 },
      { type: 'home', position: 1 }
    ]);
  });

  it('emits exactly one step per space when entering home from the entrance', () => {
    // Green (player 3) sits on its own home entrance (57) and plays a 5,
    // landing in Home 4. That is five spaces, not six.
    const pegs = pegState([[3, 0, onTrack(getHomeEntrance(3))]]);
    const path = calculateMovePath(3, 0, card('5'), null, pegs);
    expect(path).toEqual([
      { type: 'home', position: 0 },
      { type: 'home', position: 1 },
      { type: 'home', position: 2 },
      { type: 'home', position: 3 },
      { type: 'home', position: 4 }
    ]);
  });

  it('never counts more spaces than the card is worth on any home entry', () => {
    for (const player of [0, 1, 2, 3]) {
      const entrance = getHomeEntrance(player);
      for (const value of [2, 3, 4, 5, 6, 10, 12, 13]) {
        // Place the peg so the move ends on home slot (value - stepsToHome).
        for (let stepsToHome = 1; stepsToHome <= value; stepsToHome++) {
          const homeSteps = value - stepsToHome;
          if (homeSteps >= 5) continue;
          const from = (entrance + 1 - stepsToHome + TRACK_LENGTH) % TRACK_LENGTH;
          const pegs = pegState([[player, 0, onTrack(from)]]);
          const rank = value === 10 ? '10' : value === 12 ? 'Q' : value === 13 ? 'K' : String(value);
          const path = calculateMovePath(player, 0, card(rank), null, pegs);
          expect(path).toHaveLength(value);
          expect(path[path.length - 1]).toEqual({ type: 'home', position: homeSteps });
        }
      }
    }
  });

  it('agrees with applyMove about where the peg ends up', () => {
    const pegs = pegState([[3, 0, onTrack(getHomeEntrance(3))]]);
    const path = calculateMovePath(3, 0, card('5'), null, pegs);
    const { newPegs } = applyMove(3, 0, card('5'), null, pegs);
    expect(path[path.length - 1]).toEqual({
      type: 'home',
      position: newPegs[3][0].homePosition
    });
  });

  it('stays on the track when a peg in the corridor blocks the home entry', () => {
    // Blue (player 1) sits on its own home entrance (21) with a peg already in
    // Home 2, and plays a 5. The entry to Home 4 jumps that peg, so the engine
    // moves along the track to 26 — the path must not animate through home.
    const pegs = pegState([
      [1, 0, onTrack(getHomeEntrance(1))],
      [1, 1, inHome(2)]
    ]);
    const path = calculateMovePath(1, 0, card('5'), null, pegs);
    expect(path).toEqual([
      { type: 'track', position: 22 },
      { type: 'track', position: 23 },
      { type: 'track', position: 24 },
      { type: 'track', position: 25 },
      { type: 'track', position: 26 }
    ]);

    const { newPegs } = applyMove(1, 0, card('5'), null, pegs);
    expect(newPegs[1][0]).toMatchObject({ location: 'track', position: 26 });
  });

  it('stays on the track when the destination home slot is occupied', () => {
    const pegs = pegState([
      [0, 0, onTrack(0)],
      [0, 1, inHome(1)]
    ]);
    const path = calculateMovePath(0, 0, card('5'), null, pegs);
    expect(path.every(step => step.type === 'track')).toBe(true);
    expect(path[path.length - 1]).toEqual({ type: 'track', position: 5 });
  });

  it('stays on the track when an own peg blocks the way to the entrance', () => {
    // Yellow (player 0) at 71 plays a 5, but its own peg on 2 is in the way of
    // the home entry, so the engine takes the track move past it to space 4.
    const pegs = pegState([
      [0, 0, onTrack(71)],
      [0, 1, onTrack(2)]
    ]);
    const path = calculateMovePath(0, 0, card('5'), null, pegs);
    expect(path.every(step => step.type === 'track')).toBe(true);
    expect(path[path.length - 1]).toEqual({ type: 'track', position: 4 });
  });

  it('ends where applyMove puts the peg for every home-entry blocker', () => {
    // The path is a second reading of the move; it must never disagree with the
    // move itself about the destination.
    const player = 1;
    const entrance = getHomeEntrance(player); // 21
    const blockers = [
      [],
      [[player, 1, inHome(0)]],
      [[player, 1, inHome(2)]],
      [[player, 1, inHome(4)]],
      [[player, 1, onTrack(entrance)]],
      [[player, 1, onTrack(entrance + 1)]],
      [[2, 1, onTrack(entrance + 1)]]
    ];
    for (const blocker of blockers) {
      for (const [rank, from] of [['5', entrance], ['4', entrance - 2], ['2', entrance + 1], ['6', entrance - 3]]) {
        const pegs = pegState([[player, 0, onTrack((from + TRACK_LENGTH) % TRACK_LENGTH)], ...blocker]);
        if (!isValidMove(player, 0, card(rank), pegs)) continue;
        const path = calculateMovePath(player, 0, card(rank), null, pegs);
        const dest = applyMove(player, 0, card(rank), null, pegs).newPegs[player][0];
        expect(path).toHaveLength(Number(rank));
        expect(path[path.length - 1]).toEqual(
          dest.location === 'home'
            ? { type: 'home', position: dest.homePosition }
            : { type: 'track', position: dest.position }
        );
      }
    }
  });

  it('is empty for jokers (handled without step animation)', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    expect(calculateMovePath(0, 0, card('JOKER'), null, pegs)).toHaveLength(0);
  });
});

describe('describeMoveAction', () => {
  it('describes starting a peg', () => {
    const desc = describeMoveAction({ location: 'start', index: 0 }, onTrack(8), card('A'), null);
    expect(desc).toBe('Started a peg');
  });

  it('describes track and home transitions', () => {
    expect(describeMoveAction(onTrack(20), onTrack(25), card('5'), null)).toBe('Space 20 to Space 25');
    expect(describeMoveAction(onTrack(0), inHome(1), card('5'), null)).toBe('Space 0 to Home 1');
    expect(describeMoveAction(inHome(1), inHome(4), card('3'), null)).toBe('Home 1 to Home 4');
  });

  it('describes a joker bump', () => {
    expect(describeMoveAction({ location: 'start', index: 0 }, onTrack(33), card('JOKER'), null, 1)).toBe('Joker bumped Blue');
  });
});

describe('findPegAtPosition', () => {
  it('finds a track peg by position', () => {
    const pegs = pegState([[2, 3, onTrack(50)]]);
    expect(findPegAtPosition(50, pegs)).toEqual({ player: 2, pegIndex: 3 });
  });

  it('returns null for empty spaces and ignores start/home pegs', () => {
    const pegs = pegState([[0, 0, inHome(2)]]);
    expect(findPegAtPosition(10, pegs)).toBeNull();
  });
});

describe('getValidDestinations', () => {
  it('gives a single face-value destination for a simple card on track', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    const dests = getValidDestinations(1, 0, card('5'), pegs);
    expect(dests).toEqual([{ amount: null, location: 'track', position: 35 }]);
  });

  it('gives the backward destination for an 8, wrapping around 0', () => {
    const pegs = pegState([[1, 0, onTrack(5)]]);
    const dests = getValidDestinations(1, 0, card('8'), pegs);
    expect(dests).toEqual([{ amount: null, location: 'track', position: 69 }]);
  });

  it('gives the come-out spot for a start card with a peg in start', () => {
    const pegs = pegState();
    const dests = getValidDestinations(1, 0, card('K'), pegs);
    expect(dests).toEqual([{ amount: null, location: 'track', position: getStartPosition(1) }]);
  });

  it('is empty for a start card when own peg blocks the come-out spot', () => {
    const pegs = pegState([[1, 1, onTrack(getStartPosition(1))]]);
    expect(getValidDestinations(1, 0, card('K'), pegs)).toHaveLength(0);
  });

  it('offers only the full 7 when no second peg can complete a split', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    const dests = getValidDestinations(1, 0, card('7'), pegs);
    expect(dests).toEqual([{ amount: null, location: 'track', position: 37 }]);
  });

  it('offers the full 7 plus all completable split amounts with two track pegs', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(50)]]);
    const dests = getValidDestinations(1, 0, card('7'), pegs);
    const amounts = dests.map(d => d.amount).sort((a, b) => (a ?? 7) - (b ?? 7));
    expect(amounts).toEqual([1, 2, 3, 4, 5, 6, null]);
    for (const d of dests) {
      expect(d.position).toBe(30 + (d.amount ?? 7));
    }
  });

  it('is empty for a 9 with only one peg out (split cannot be completed)', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    expect(getValidDestinations(1, 0, card('9'), pegs)).toHaveLength(0);
  });

  it('offers both forward and backward 9-split destinations with two pegs out', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(50)]]);
    const dests = getValidDestinations(1, 0, card('9'), pegs);
    const amounts = dests.map(d => d.amount);
    expect(amounts).toContain(4);   // forward 4, other peg goes back 5
    expect(amounts).toContain(-4);  // backward 4, other peg goes forward 5
    for (const d of dests) {
      expect(d.position).toBe(30 + d.amount);
    }
  });

  it('handles home-corridor pegs (forward only, exact fit)', () => {
    const pegs = pegState([[1, 0, inHome(0)]]);
    expect(getValidDestinations(1, 0, card('4'), pegs))
      .toEqual([{ amount: null, location: 'home', homePosition: 4 }]);
    expect(getValidDestinations(1, 0, card('5'), pegs)).toHaveLength(0);
  });

  it('only offers forward 9-splits for a peg in home', () => {
    const pegs = pegState([[1, 0, inHome(0)], [1, 1, onTrack(50)]]);
    const dests = getValidDestinations(1, 0, card('9'), pegs);
    expect(dests.length).toBeGreaterThan(0);
    for (const d of dests) {
      expect(d.amount).toBeGreaterThan(0);
      expect(d.location).toBe('home');
    }
  });

  it('returns [] for a joker (targets are pegs, not spaces)', () => {
    const pegs = pegState([[0, 0, onTrack(10)], [1, 0, onTrack(30)]]);
    expect(getValidDestinations(1, 0, card('JOKER'), pegs)).toHaveLength(0);
  });

  it('every returned amount passes isValidMove', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [1, 1, onTrack(36)], [2, 0, onTrack(33)]]);
    for (const rank of ['5', '7', '8', '9', 'K']) {
      for (const d of getValidDestinations(1, 0, card(rank), pegs)) {
        expect(isValidMove(1, 0, card(rank), pegs, d.amount)).toBe(true);
      }
    }
  });
});

describe('getMovablePegs', () => {
  it('lists only pegs that can actually move with the card', () => {
    // Peg 0 on track can move 5; pegs in start cannot use a 5
    const pegs = pegState([[1, 0, onTrack(30)]]);
    expect(getMovablePegs(1, card('5'), pegs)).toEqual([0]);
  });

  it('lists every start peg for a start card with an open come-out spot', () => {
    const pegs = pegState();
    expect(getMovablePegs(1, card('A'), pegs)).toEqual([0, 1, 2, 3, 4]);
  });

  it('excludes pegs that cannot complete a mandatory 9 split', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    expect(getMovablePegs(1, card('9'), pegs)).toHaveLength(0);
  });

  it('for a joker, lists start and track pegs when an opponent is on track', () => {
    const pegs = pegState([[0, 0, onTrack(10)], [1, 0, onTrack(30)], [1, 1, inHome(2)]]);
    const movable = getMovablePegs(1, card('JOKER'), pegs);
    expect(movable).toContain(0);       // track peg can be the joker source
    expect(movable).toContain(2);       // start pegs too
    expect(movable).not.toContain(1);   // home pegs cannot use a joker
  });

  it('for a joker, lists nothing when no opponent is on track', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    expect(getMovablePegs(1, card('JOKER'), pegs)).toHaveLength(0);
  });
});

describe('explainNoMove', () => {
  const jack = card('J');

  it('says nothing about a peg that can move', () => {
    const pegs = pegState();
    expect(explainNoMove(0, 0, jack, pegs)).toBeNull();
  });

  it('names your own peg on the come-out space, which blocks every peg in start', () => {
    // The reported board: one peg parked on the come-out spot, the rest in
    // start, a Jack in hand — and no start peg can be played.
    const pegs = pegState([[0, 4, onTrack(getStartPosition(0))]]);
    expect(getMovablePegs(0, jack, pegs)).toEqual([4]);
    for (const i of [0, 1, 2, 3]) {
      expect(explainNoMove(0, i, jack, pegs)).toMatch(/own peg .* come-out space \(8\)/);
    }
  });

  it('says nothing when the come-out space holds an opponent — you bump them', () => {
    const pegs = pegState([[1, 0, onTrack(getStartPosition(0))]]);
    expect(getMovablePegs(0, jack, pegs)).toEqual([0, 1, 2, 3, 4]);
    expect(explainNoMove(0, 0, jack, pegs)).toBeNull();
  });

  it('says nothing about a peg on the home entrance, which blocks nothing', () => {
    const pegs = pegState([[0, 4, onTrack(getHomeEntrance(0))]]);
    expect(getMovablePegs(0, jack, pegs)).toEqual([0, 1, 2, 3, 4]);
    expect(explainNoMove(0, 0, jack, pegs)).toBeNull();
  });

  it('names the cards that can bring a peg out when the card cannot', () => {
    const pegs = pegState();
    expect(explainNoMove(0, 0, card('7'), pegs)).toMatch(/Ace, Jack, Queen, King or Joker/);
  });

  it('falls through to null for an ordinary "it just does not reach" refusal', () => {
    // Peg 0 on the track, blocked from moving 5 by its own peg 5 spaces ahead.
    const pegs = pegState([[0, 0, onTrack(30)], [0, 1, onTrack(35)]]);
    expect(getMovablePegs(0, card('5'), pegs)).not.toContain(0);
    expect(explainNoMove(0, 0, card('5'), pegs)).toBeNull();
  });
});

describe('findBumps', () => {
  it('reports a peg bumped by landing on it, with its former position', () => {
    const pegs = pegState([[1, 0, onTrack(30)], [2, 0, onTrack(35)]]);
    const { newPegs } = applyMove(1, 0, card('5'), null, pegs);
    expect(findBumps(pegs, newPegs)).toEqual([{ player: 2, pegIndex: 0, fromPosition: 35 }]);
  });

  it('reports nothing for a move that bumps no one', () => {
    const pegs = pegState([[1, 0, onTrack(30)]]);
    const { newPegs } = applyMove(1, 0, card('5'), null, pegs);
    expect(findBumps(pegs, newPegs)).toHaveLength(0);
  });

  it('reports a joker bump', () => {
    const pegs = pegState([[0, 0, onTrack(10)], [1, 0, onTrack(30)]]);
    const { newPegs } = applyMove(1, 0, card('JOKER'), null, pegs);
    expect(findBumps(pegs, newPegs)).toEqual([{ player: 0, pegIndex: 0, fromPosition: 10 }]);
  });
});
