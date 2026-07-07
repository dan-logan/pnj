// Core rules engine for Pegs and Jokers — all pure functions.
// State shape: pegs is a 4-element array (one per player) of 5 peg objects:
//   { location: 'start', index }                — in the start area
//   { location: 'track', position: 0-71, index } — on the main track
//   { location: 'home', homePosition: 0-4, index } — in the home corridor
import {
  CARD_VALUES,
  TRACK_LENGTH,
  NUM_PLAYERS,
  PEGS_PER_PLAYER,
  HOME_SIZE,
  PLAYER_NAMES
} from './constants.js';

export function createInitialPegs() {
  return Array(NUM_PLAYERS).fill(null).map(() =>
    Array(PEGS_PER_PLAYER).fill(null).map((_, i) => ({ location: 'start', index: i }))
  );
}

export function getStartPosition(player) {
  return player * 18 + 8;  // Position 8 on each player's side, adjacent to start area
}

export function getHomeEntrance(player) {
  return player * 18 + 3;  // Position 3 on each player's side, where home area connects
}

// Calculate how far a peg is from being fully home (lower = closer to winning)
export function getDistanceToHome(peg, player) {
  if (peg.location === 'home') {
    // In home: distance is how many spots until position 4 (final spot)
    return 4 - peg.homePosition;
  }
  if (peg.location === 'start') {
    // In start: very far (need to get out + travel + enter home)
    return 100;
  }
  // On track: calculate steps to home entry point
  const homeEntrance = getHomeEntrance(player);
  const homeEntryPoint = (homeEntrance + 1) % TRACK_LENGTH;
  let stepsToEntry = (homeEntryPoint - peg.position + TRACK_LENGTH) % TRACK_LENGTH;
  if (stepsToEntry === 0) stepsToEntry = TRACK_LENGTH; // At entry point, must go around
  // Add 5 because after entering home, need to reach position 4
  return stepsToEntry + 5;
}

// Generate a description of a move for the last move display
export function describeMoveAction(peg, newPeg, card, amount, bumpedPlayer = null) {
  const cardInfo = CARD_VALUES[card.rank];

  // Joker bump
  if (cardInfo.isJoker && bumpedPlayer !== null) {
    return `Joker bumped ${PLAYER_NAMES[bumpedPlayer]}`;
  }

  // Starting a peg
  if (peg.location === 'start' && cardInfo.canStart) {
    return 'Started a peg';
  }

  // Entering home from track
  if (peg.location === 'track' && newPeg.location === 'home') {
    return `Space ${peg.position} to Home ${newPeg.homePosition}`;
  }

  // Moving within home
  if (peg.location === 'home' && newPeg.location === 'home') {
    return `Home ${peg.homePosition} to Home ${newPeg.homePosition}`;
  }

  // Track movement
  if (peg.location === 'track' && newPeg.location === 'track') {
    return `Space ${peg.position} to Space ${newPeg.position}`;
  }

  return 'Moved';
}

export function findPegAtPosition(position, playerPegs) {
  for (let p = 0; p < NUM_PLAYERS; p++) {
    for (let i = 0; i < PEGS_PER_PLAYER; i++) {
      const peg = playerPegs[p][i];
      if (peg.location === 'track' && peg.position === position) {
        return { player: p, pegIndex: i };
      }
    }
  }
  return null;
}

export function isValidMove(player, pegIndex, card, currentPegs, moveAmount = null) {
  const peg = currentPegs[player][pegIndex];
  const cardInfo = CARD_VALUES[card.rank];

  // Handle pegs already in home - can only move forward within home
  if (peg.location === 'home') {
    // Can't use Joker or backward cards in home
    if (cardInfo.isJoker || cardInfo.backward) return false;

    // For 9 card (mustSplit), only allow positive (forward) splits - reject if no amount or backward
    if (cardInfo.mustSplit && (moveAmount === null || moveAmount <= 0)) {
      return false;
    }

    const amount = moveAmount !== null ? moveAmount : cardInfo.value;
    if (amount <= 0) return false; // Can only move forward in home

    const newHomePos = peg.homePosition + amount;
    // Must land exactly on a valid home position (0-4)
    if (newHomePos > HOME_SIZE - 1) return false;

    // Check if destination is occupied
    const homeOccupied = currentPegs[player].some(
      p => p.location === 'home' && p.homePosition === newHomePos
    );
    if (homeOccupied) return false;

    // Check if jumping over own peg in home
    for (let pos = peg.homePosition + 1; pos < newHomePos; pos++) {
      const blocked = currentPegs[player].some(
        p => p.location === 'home' && p.homePosition === pos
      );
      if (blocked) return false;
    }

    return true;
  }

  if (peg.location === 'start') {
    // Joker can also be used from start
    if (cardInfo.isJoker) {
      for (let p = 0; p < NUM_PLAYERS; p++) {
        if (p === player) continue;
        for (let i = 0; i < PEGS_PER_PLAYER; i++) {
          const otherPeg = currentPegs[p][i];
          if (otherPeg.location === 'track') return true;
        }
      }
      return false;
    }

    // Check if own peg is already at come-out spot
    if (cardInfo.canStart) {
      const startPos = getStartPosition(player);
      const ownPegAtStart = currentPegs[player].some(
        p => p.location === 'track' && p.position === startPos
      );
      if (ownPegAtStart) return false;
    }

    return cardInfo.canStart;
  }

  if (cardInfo.isJoker) {
    for (let p = 0; p < NUM_PLAYERS; p++) {
      if (p === player) continue; // Can't bump own pegs
      for (let i = 0; i < PEGS_PER_PLAYER; i++) {
        const otherPeg = currentPegs[p][i];
        if (otherPeg.location === 'track') return true;
      }
    }
    return false;
  }

  // For 9 card (mustSplit), moveAmount must be specified - cannot move a single peg 9 spaces
  if (cardInfo.mustSplit && moveAmount === null) {
    return false;
  }

  const amount = moveAmount !== null ? moveAmount : cardInfo.value;
  const homeEntrance = getHomeEntrance(player);
  const currentPos = peg.position;

  let newPos;
  if (amount > 0) {
    newPos = (currentPos + amount) % TRACK_LENGTH;
  } else {
    newPos = (currentPos + amount + TRACK_LENGTH) % TRACK_LENGTH;
  }

  // Check if passing through home entrance (only for forward movement)
  if (amount > 0) {
    let stepsToHome = 0;
    for (let step = 1; step <= amount; step++) {
      const checkPos = (currentPos + step) % TRACK_LENGTH;
      if (checkPos === (homeEntrance + 1) % TRACK_LENGTH && stepsToHome === 0) {
        stepsToHome = step;
      }
    }

    if (stepsToHome > 0 && stepsToHome <= amount) {
      const homeSteps = amount - stepsToHome;

      // Check if home position is valid (0-4)
      if (homeSteps >= 0 && homeSteps < HOME_SIZE) {
        // Check if destination home position is occupied
        const homeOccupied = currentPegs[player].some(
          p => p.location === 'home' && p.homePosition === homeSteps
        );
        if (homeOccupied) {
          // Can't enter home here, will continue on track - check track move validity below
        } else {
          // Check if we'd jump over own pegs on track before home entrance
          let trackBlocked = false;
          for (let step = 1; step < stepsToHome; step++) {
            const checkPos = (currentPos + step) % TRACK_LENGTH;
            const pegAtCheck = findPegAtPosition(checkPos, currentPegs);
            if (pegAtCheck && pegAtCheck.player === player) {
              trackBlocked = true;
              break;
            }
          }

          // Check if we'd jump over own pegs in home corridor
          let homeBlocked = false;
          for (let homePos = 0; homePos < homeSteps; homePos++) {
            const blocked = currentPegs[player].some(
              p => p.location === 'home' && p.homePosition === homePos
            );
            if (blocked) {
              homeBlocked = true;
              break;
            }
          }

          if (!trackBlocked && !homeBlocked) {
            return true; // Valid home entry
          }
          // Otherwise, can't enter home - check if track move is valid below
        }
      }
      // If homeSteps >= 5, we overshoot home - continue on track
    }
  }

  // Check if landing on own peg
  const pegAtNewPos = findPegAtPosition(newPos, currentPegs);
  if (pegAtNewPos && pegAtNewPos.player === player) {
    return false;
  }

  // Check if jumping over own peg
  const direction = amount > 0 ? 1 : -1;
  for (let step = direction; Math.abs(step) < Math.abs(amount); step += direction) {
    const checkPos = (currentPos + step + TRACK_LENGTH) % TRACK_LENGTH;
    const pegAtCheck = findPegAtPosition(checkPos, currentPegs);
    if (pegAtCheck && pegAtCheck.player === player) {
      return false;
    }
  }

  return true;
}

export function hasAnyValidMove(player, hand, currentPegs) {
  for (const card of hand) {
    const cardInfo = CARD_VALUES[card.rank];

    for (let pegIndex = 0; pegIndex < PEGS_PER_PLAYER; pegIndex++) {
      // Check basic move
      if (isValidMove(player, pegIndex, card, currentPegs)) {
        return true;
      }

      // Check 7 splits
      if (cardInfo.canSplit) {
        for (let split = 1; split <= 6; split++) {
          if (isValidMove(player, pegIndex, card, currentPegs, split)) {
            return true;
          }
        }
      }

      // Check 9 splits (forward/backward combinations)
      if (cardInfo.mustSplit) {
        for (let split = 1; split <= 8; split++) {
          if (isValidMove(player, pegIndex, card, currentPegs, split)) {
            return true;
          }
          if (isValidMove(player, pegIndex, card, currentPegs, -split)) {
            return true;
          }
        }
      }
    }

    // Check Joker - valid if any opponent has a peg on track
    if (cardInfo.isJoker) {
      const hasOpponentOnTrack = currentPegs.some((playerPegs, p) =>
        p !== player && playerPegs.some(peg => peg.location === 'track')
      );
      const hasOwnPegToMove = currentPegs[player].some(peg =>
        peg.location === 'start' || peg.location === 'track'
      );
      if (hasOpponentOnTrack && hasOwnPegToMove) {
        return true;
      }
    }
  }
  return false;
}

// Apply a move to the peg state. Returns { newPegs, bumpedOpponent } without
// mutating the input. Assumes the move has already been validated.
export function applyMove(player, pegIndex, card, amount, currentPegs) {
  const newPegs = currentPegs.map(p => p.map(peg => ({ ...peg })));
  const peg = newPegs[player][pegIndex];
  const cardInfo = CARD_VALUES[card.rank];

  // Handle movement within home corridor
  if (peg.location === 'home') {
    const moveAmount = amount !== null ? amount : cardInfo.value;
    peg.homePosition = peg.homePosition + moveAmount;
    return { newPegs, bumpedOpponent: false };
  }

  if (peg.location === 'start' && cardInfo.canStart) {
    const startPos = getStartPosition(player);
    const pegAtStart = findPegAtPosition(startPos, newPegs);

    // Safety check: can't start if own peg is at come-out spot
    if (pegAtStart && pegAtStart.player === player) {
      return { newPegs, bumpedOpponent: false };
    }

    // Bump opponent peg if present
    const bumpedOpponent = pegAtStart && pegAtStart.player !== player;
    if (bumpedOpponent) {
      newPegs[pegAtStart.player][pegAtStart.pegIndex] = { location: 'start', index: pegAtStart.pegIndex };
    }
    peg.location = 'track';
    peg.position = startPos;
    return { newPegs, bumpedOpponent };
  }

  if (cardInfo.isJoker) {
    // Find any opponent peg on track to bump
    for (let p = 0; p < NUM_PLAYERS; p++) {
      if (p === player) continue;
      for (let i = 0; i < PEGS_PER_PLAYER; i++) {
        const otherPeg = newPegs[p][i];
        if (otherPeg.location === 'track') {
          const targetPos = otherPeg.position;
          newPegs[p][i] = { location: 'start', index: i };
          peg.location = 'track';
          peg.position = targetPos;
          return { newPegs, bumpedOpponent: true };
        }
      }
    }
    return { newPegs, bumpedOpponent: false };
  }

  const homeEntrance = getHomeEntrance(player);
  const currentPos = peg.position;
  const moveAmount = amount !== null ? amount : cardInfo.value;

  // Check if we should enter home (only for forward movement)
  let shouldEnterHome = false;
  let homeSteps = 0;

  if (moveAmount > 0) {
    let stepsToHome = 0;
    for (let step = 1; step <= moveAmount; step++) {
      const checkPos = (currentPos + step) % TRACK_LENGTH;
      if (checkPos === (homeEntrance + 1) % TRACK_LENGTH && stepsToHome === 0) {
        stepsToHome = step;
      }
    }

    if (stepsToHome > 0 && stepsToHome <= moveAmount) {
      homeSteps = moveAmount - stepsToHome;

      if (homeSteps >= 0 && homeSteps < HOME_SIZE) {
        // Check if destination home position is occupied
        const homeOccupied = newPegs[player].some(
          p => p.location === 'home' && p.homePosition === homeSteps
        );

        if (!homeOccupied) {
          // Check if we'd jump over own pegs on track before home entrance
          let trackBlocked = false;
          for (let step = 1; step < stepsToHome; step++) {
            const checkPos = (currentPos + step) % TRACK_LENGTH;
            const pegAtCheck = findPegAtPosition(checkPos, newPegs);
            if (pegAtCheck && pegAtCheck.player === player) {
              trackBlocked = true;
              break;
            }
          }

          // Check if we'd jump over own pegs in home corridor
          let homeBlocked = false;
          for (let homePos = 0; homePos < homeSteps; homePos++) {
            const blocked = newPegs[player].some(
              p => p.location === 'home' && p.homePosition === homePos
            );
            if (blocked) {
              homeBlocked = true;
              break;
            }
          }

          if (!trackBlocked && !homeBlocked) {
            shouldEnterHome = true;
          }
        }
      }
    }
  }

  if (shouldEnterHome) {
    peg.location = 'home';
    peg.homePosition = homeSteps;
    return { newPegs, bumpedOpponent: false };
  }

  // Continue on track
  let newPos;
  if (moveAmount > 0) {
    newPos = (currentPos + moveAmount) % TRACK_LENGTH;
  } else {
    newPos = (currentPos + moveAmount + TRACK_LENGTH) % TRACK_LENGTH;
  }

  const pegAtNewPos = findPegAtPosition(newPos, newPegs);
  if (pegAtNewPos && pegAtNewPos.player !== player) {
    newPegs[pegAtNewPos.player][pegAtNewPos.pegIndex] = { location: 'start', index: pegAtNewPos.pegIndex };
  }

  peg.position = newPos;
  return { newPegs, bumpedOpponent: !!pegAtNewPos };
}

export function checkWinner(currentPegs) {
  for (let p = 0; p < NUM_PLAYERS; p++) {
    if (currentPegs[p].every(peg => peg.location === 'home')) {
      return p;
    }
  }
  return null;
}

// Calculate the path of positions a peg travels during a move (for animation)
export function calculateMovePath(player, pegIndex, card, amount, currentPegs) {
  const peg = currentPegs[player][pegIndex];
  const cardInfo = CARD_VALUES[card.rank];
  const path = [];

  // Starting from start area - just show appear at start position
  if (peg.location === 'start' && cardInfo.canStart) {
    const startPos = getStartPosition(player);
    path.push({ type: 'track', position: startPos });
    return path;
  }

  // Joker - we handle this separately (just appear at target)
  if (cardInfo.isJoker) {
    return path; // Empty path, handled specially
  }

  // Movement within home
  if (peg.location === 'home') {
    const moveAmount = amount !== null ? amount : cardInfo.value;
    for (let step = 1; step <= moveAmount; step++) {
      path.push({ type: 'home', position: peg.homePosition + step });
    }
    return path;
  }

  // Track movement
  if (peg.location === 'track') {
    const homeEntrance = getHomeEntrance(player);
    const currentPos = peg.position;
    const moveAmount = amount !== null ? amount : cardInfo.value;
    const direction = moveAmount > 0 ? 1 : -1;

    // Check if we'll enter home
    let stepsToHome = 0;
    if (moveAmount > 0) {
      for (let step = 1; step <= moveAmount; step++) {
        const checkPos = (currentPos + step) % TRACK_LENGTH;
        if (checkPos === (homeEntrance + 1) % TRACK_LENGTH && stepsToHome === 0) {
          stepsToHome = step;
        }
      }
    }

    // Check if home entry is valid
    let willEnterHome = false;
    let homeSteps = 0;
    if (stepsToHome > 0 && stepsToHome <= moveAmount) {
      homeSteps = moveAmount - stepsToHome;
      if (homeSteps >= 0 && homeSteps < HOME_SIZE) {
        const homeOccupied = currentPegs[player].some(
          p => p.location === 'home' && p.homePosition === homeSteps
        );
        if (!homeOccupied) {
          willEnterHome = true;
        }
      }
    }

    if (willEnterHome) {
      // Animate to home entrance, then into home
      for (let step = 1; step <= stepsToHome; step++) {
        const pos = (currentPos + step) % TRACK_LENGTH;
        path.push({ type: 'track', position: pos });
      }
      for (let step = 0; step <= homeSteps; step++) {
        path.push({ type: 'home', position: step });
      }
    } else {
      // Animate along track
      for (let step = direction; Math.abs(step) <= Math.abs(moveAmount); step += direction) {
        const pos = (currentPos + step + TRACK_LENGTH) % TRACK_LENGTH;
        path.push({ type: 'track', position: pos });
      }
    }
  }

  return path;
}
