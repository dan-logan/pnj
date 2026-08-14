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
  PLAYER_NAMES,
  GAME_MODES,
  TEAMS,
  getPartner,
  sameTeam
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

// Resolve where a bumped peg lands, mutating `newPegs` in place. Returns true on
// success, false if the placement is illegal (so the whole originating move must
// be rejected).
//
// Classic rule (or an opponent bump in partner mode): the peg goes back to its
// start area. Partner rule: bumping a teammate's peg is a *friendly* bump that
// sends it to the track space immediately before that owner's home corridor
// (their home-entrance space), positioning it to go home. If that entrance space
// is occupied by an opponent, the opponent is bumped by the same rule (cascade);
// if it is occupied by one of that owner's own pegs, the friendly bump has
// nowhere to go and the move is illegal — just like landing on your own peg.
//
// `reservedPos` is the track space the mover itself will occupy. `mover`
// (`{ player, pegIndex }` or null) identifies that moving peg so the "peg on its
// own entrance" swap below can relocate it.
function resolveDisplacement(newPegs, ownerP, idx, actor, mode, reservedPos, mover = null, depth = 0) {
  if (depth > 12) return false; // guard against a pathological cascade cycle
  const friendly = mode === GAME_MODES.PARTNERS && sameTeam(ownerP, actor);
  if (!friendly) {
    newPegs[ownerP][idx] = { location: 'start', index: idx };
    return true;
  }
  const target = getHomeEntrance(ownerP);
  if (target === reservedPos) {
    // The friendly-bump destination is exactly the space the mover is taking.
    // This only happens when the bumped peg is already sitting on its own home
    // entrance and the mover lands on it. A peg can't block itself: the bumped
    // peg keeps that space and instead shoves the mover onward — a friendly bump
    // of the mover to its own home entrance (cascading from there). Without a
    // mover to relocate (e.g. the joker path, which we don't support here) the
    // bump has nowhere to resolve and is illegal.
    if (!mover) return false;
    return resolveDisplacement(newPegs, mover.player, mover.pegIndex, actor, mode, reservedPos, null, depth + 1);
  }
  // Detach the peg first so a cascade lookup can't treat it as blocking itself.
  newPegs[ownerP][idx] = { location: 'start', index: idx };
  const occ = findPegAtPosition(target, newPegs);
  if (occ) {
    if (occ.player === ownerP) return false; // this owner's own peg holds the entrance
    if (!resolveDisplacement(newPegs, occ.player, occ.pegIndex, actor, mode, reservedPos, mover, depth + 1)) {
      return false;
    }
  }
  newPegs[ownerP][idx] = { location: 'track', position: target, index: idx };
  return true;
}

// True when the peg at `position` can be legally bumped by `actor` (used by
// isValidMove). Opponent bumps are always legal; a friendly partner bump is only
// illegal when its placement (or cascade) has nowhere to go.
function canBumpPegAt(position, actor, mode, currentPegs, reservedPos, mover = null) {
  const occ = findPegAtPosition(position, currentPegs);
  if (!occ) return true;
  const clone = currentPegs.map(p => p.map(pg => ({ ...pg })));
  return resolveDisplacement(clone, occ.player, occ.pegIndex, actor, mode, reservedPos, mover);
}

// True when the joker has at least one legally bumpable target: any peg on the
// track that is not the mover's own and whose bump (friendly or not) is legal.
// A teammate sitting on its own home entrance is a legal target only via the
// "swap" (the mover is shoved to its own entrance instead), which needs a
// concrete mover peg — so for that case we try each of the owner's movable pegs.
function hasLegalJokerTarget(owner, actor, mode, currentPegs) {
  const movers = [];
  for (let i = 0; i < PEGS_PER_PLAYER; i++) {
    const pg = currentPegs[owner][i];
    if (pg.location === 'track' || pg.location === 'start') movers.push(i);
  }
  for (let p = 0; p < NUM_PLAYERS; p++) {
    if (p === owner) continue; // can't bump the mover's own pegs
    for (let i = 0; i < PEGS_PER_PLAYER; i++) {
      const otherPeg = currentPegs[p][i];
      if (otherPeg.location !== 'track') continue;
      // Opponent bump, or a plain friendly bump that needs no swap.
      if (canBumpPegAt(otherPeg.position, actor, mode, currentPegs, otherPeg.position)) return true;
      // Otherwise it may be a teammate on its own entrance: legal if some mover
      // peg can take the swap (its own entrance clears / cascades).
      for (const m of movers) {
        if (canBumpPegAt(otherPeg.position, actor, mode, currentPegs, otherPeg.position, { player: owner, pegIndex: m })) {
          return true;
        }
      }
    }
  }
  return false;
}

// Apply a joker: the owner's peg jumps to `targetPlayer`/`targetPegIndex`'s
// track space and that peg is bumped (friendly-bumped to its home entrance for a
// teammate, back to start otherwise). Shared by the UI and AI so the partner rule
// stays in one place. Returns { newPegs, bumped, bumpedPlayer }.
export function applyJoker(owner, pegIndex, targetPlayer, targetPegIndex, currentPegs, options = {}) {
  const { actor = owner, mode = GAME_MODES.CLASSIC } = options;
  const newPegs = currentPegs.map(p => p.map(pg => ({ ...pg })));
  const target = newPegs[targetPlayer][targetPegIndex];
  if (target.location !== 'track') return { newPegs: currentPegs, bumped: false, bumpedPlayer: null };
  const targetPos = target.position;

  // Jokering a teammate that's sitting on its own home entrance is the same
  // "a peg can't block itself" swap as a track move landing there: the teammate
  // keeps that space and the mover is friendly-bumped on to its own home
  // entrance (cascading from there) instead of onto the target's space.
  const swap = mode === GAME_MODES.PARTNERS
    && sameTeam(targetPlayer, actor)
    && getHomeEntrance(targetPlayer) === targetPos;

  // Detach the mover during the cascade so it can't block a friendly placement,
  // then drop it onto the vacated space. Passing the mover lets resolveDisplacement
  // perform the entrance swap above (which needs a peg to shove onward).
  const mover = newPegs[owner][pegIndex];
  newPegs[owner][pegIndex] = { location: 'start', index: pegIndex };
  const ok = resolveDisplacement(newPegs, targetPlayer, targetPegIndex, actor, mode, targetPos, { player: owner, pegIndex });
  if (!ok) return { newPegs: currentPegs, bumped: false, bumpedPlayer: null };
  if (swap) {
    // The teammate kept its entrance and resolveDisplacement friendly-bumped the
    // mover on to its own home entrance; don't re-place it at targetPos.
    return { newPegs, bumped: true, bumpedPlayer: targetPlayer };
  }
  newPegs[owner][pegIndex] = { ...mover, location: 'track', position: targetPos };
  return { newPegs, bumped: true, bumpedPlayer: targetPlayer };
}

export function isValidMove(player, pegIndex, card, currentPegs, moveAmount = null, options = {}) {
  const { actor = player, mode = GAME_MODES.CLASSIC } = options;
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
      return hasLegalJokerTarget(player, actor, mode, currentPegs);
    }

    // Check if own peg is already at come-out spot
    if (cardInfo.canStart) {
      const startPos = getStartPosition(player);
      const ownPegAtStart = currentPegs[player].some(
        p => p.location === 'track' && p.position === startPos
      );
      if (ownPegAtStart) return false;
      // A teammate on the come-out spot gets friendly-bumped; reject if that
      // bump would be illegal (its home entrance is blocked by its own peg).
      if (!canBumpPegAt(startPos, actor, mode, currentPegs, startPos)) return false;
    }

    return cardInfo.canStart;
  }

  if (cardInfo.isJoker) {
    return hasLegalJokerTarget(player, actor, mode, currentPegs);
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
  // Landing on a teammate friendly-bumps them; reject if that bump is illegal.
  // Pass the mover so a landing on a partner sitting on its own home entrance
  // (which shoves the mover onward instead) can be resolved.
  if (pegAtNewPos && !canBumpPegAt(newPos, actor, mode, currentPegs, newPos, { player, pegIndex })) {
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

export function hasAnyValidMove(player, hand, currentPegs, options = {}) {
  for (const card of hand) {
    const cardInfo = CARD_VALUES[card.rank];

    for (let pegIndex = 0; pegIndex < PEGS_PER_PLAYER; pegIndex++) {
      // Check basic move
      if (isValidMove(player, pegIndex, card, currentPegs, null, options)) {
        return true;
      }

      // Check 7 splits
      if (cardInfo.canSplit) {
        for (let split = 1; split <= 6; split++) {
          if (isValidMove(player, pegIndex, card, currentPegs, split, options)) {
            return true;
          }
        }
      }

      // Check 9 splits (forward/backward combinations)
      if (cardInfo.mustSplit) {
        for (let split = 1; split <= 8; split++) {
          if (isValidMove(player, pegIndex, card, currentPegs, split, options)) {
            return true;
          }
          if (isValidMove(player, pegIndex, card, currentPegs, -split, options)) {
            return true;
          }
        }
      }
    }

    // Check Joker - valid if any legally bumpable peg is on the track
    if (cardInfo.isJoker) {
      const hasOwnPegToMove = currentPegs[player].some(peg =>
        peg.location === 'start' || peg.location === 'track'
      );
      if (hasOwnPegToMove &&
          hasLegalJokerTarget(player, options.actor ?? player, options.mode ?? GAME_MODES.CLASSIC, currentPegs)) {
        return true;
      }
    }
  }
  return false;
}

// Apply a move to the peg state. Returns { newPegs, bumpedOpponent } without
// mutating the input. Assumes the move has already been validated.
// `options.actor`/`options.mode` drive the partner friendly-bump rule; both
// default to classic behavior (actor === owner, no friendly bumps).
export function applyMove(player, pegIndex, card, amount, currentPegs, options = {}) {
  const { actor = player, mode = GAME_MODES.CLASSIC } = options;
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

    // Bump the occupying peg if present (opponent → start, teammate → friendly).
    const bumpedOpponent = pegAtStart && pegAtStart.player !== player;
    if (bumpedOpponent) {
      // If the friendly bump is illegal (a partner whose entrance is blocked by
      // its own peg), the come-out is illegal too — leave the state untouched.
      // isValidMove already guards this, so this is defensive.
      if (!resolveDisplacement(newPegs, pegAtStart.player, pegAtStart.pegIndex, actor, mode, startPos)) {
        return { newPegs: currentPegs, bumpedOpponent: false };
      }
    }
    peg.location = 'track';
    peg.position = startPos;
    return { newPegs, bumpedOpponent };
  }

  if (cardInfo.isJoker) {
    // Bump the first legally bumpable peg on the track (opponent or teammate).
    for (let p = 0; p < NUM_PLAYERS; p++) {
      if (p === player) continue;
      for (let i = 0; i < PEGS_PER_PLAYER; i++) {
        const otherPeg = newPegs[p][i];
        if (otherPeg.location === 'track' &&
            canBumpPegAt(otherPeg.position, actor, mode, newPegs, otherPeg.position, { player, pegIndex })) {
          const { newPegs: afterJoker, bumped } = applyJoker(player, pegIndex, p, i, newPegs, { actor, mode });
          return { newPegs: afterJoker, bumpedOpponent: bumped };
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
    const swap = mode === GAME_MODES.PARTNERS
      && sameTeam(pegAtNewPos.player, actor)
      && getHomeEntrance(pegAtNewPos.player) === newPos;
    // Detach the mover during the cascade so it can't block a friendly bump.
    newPegs[player][pegIndex] = { location: 'start', index: pegIndex };
    resolveDisplacement(newPegs, pegAtNewPos.player, pegAtNewPos.pegIndex, actor, mode, newPos, { player, pegIndex });
    if (swap) {
      // Landed on a partner sitting on its own home entrance: the partner keeps
      // that space and the mover was friendly-bumped on to its own home entrance
      // by resolveDisplacement, so don't re-place the mover at newPos.
      return { newPegs, bumpedOpponent: true };
    }
    // Otherwise land the mover on the vacated space.
    newPegs[player][pegIndex] = peg;
  }

  peg.position = newPos;
  return { newPegs, bumpedOpponent: !!pegAtNewPos };
}

// Move a peg out of the start area onto its come-out space, applying the partner
// friendly-bump rule to whatever occupies that space. Used by the "stuck 3 turns"
// mercy start, which frees a player regardless of the cards in hand and so isn't
// routed through applyMove. In partner mode a teammate on the come-out space is
// friendly-bumped to its home entrance (cascading) exactly like any other move.
// The one concession to keeping a stuck player moving: if that friendly bump is
// illegal because the teammate's entrance is blocked by its own peg, the occupant
// is sent back to start rather than aborting the mercy start. Returns
// { newPegs, ok, bumpedOpponent }; ok is false only when one of the player's own
// pegs already holds the come-out space.
export function applyComeOut(player, pegIndex, currentPegs, options = {}) {
  const { actor = player, mode = GAME_MODES.CLASSIC } = options;
  const newPegs = currentPegs.map(p => p.map(pg => ({ ...pg })));
  const startPos = getStartPosition(player);
  const occ = findPegAtPosition(startPos, newPegs);
  if (occ && occ.player === player) {
    return { newPegs: currentPegs, ok: false, bumpedOpponent: false };
  }
  let bumpedOpponent = false;
  if (occ) {
    bumpedOpponent = mode !== GAME_MODES.PARTNERS || !sameTeam(occ.player, actor);
    if (!resolveDisplacement(newPegs, occ.player, occ.pegIndex, actor, mode, startPos)) {
      // Partner's entrance is blocked; fall back to a plain send-to-start so the
      // stuck player can still break free.
      newPegs[occ.player][occ.pegIndex] = { location: 'start', index: occ.pegIndex };
    }
  }
  newPegs[player][pegIndex] = { location: 'track', position: startPos, index: pegIndex };
  return { newPegs, ok: true, bumpedOpponent };
}

// Who owns the peg that completes a 7/9 split. Normally the same player who
// played the first half. In partner mode there's one exception: if that first
// half brought the player's *last* peg home (all of their pegs are now home in
// `afterFirst`, but the partner still has pegs on the board), the remainder is
// played on the partner's pegs — the same "your last peg home hands control to
// your partner" boundary the UI uses. This lets a split double as the handoff
// move: one part finishes you, the rest advances your partner.
export function splitCompleter(player, afterFirst, options = {}) {
  const { mode = GAME_MODES.CLASSIC } = options;
  if (mode !== GAME_MODES.PARTNERS) return player;
  const partner = getPartner(player);
  const playerAllHome = afterFirst[player].every(p => p.location === 'home');
  const partnerAllHome = afterFirst[partner].every(p => p.location === 'home');
  return playerAllHome && !partnerAllHome ? partner : player;
}

// Enumerate every legal landing spot for playing `card` with this peg.
// Returns [{ amount, location: 'track'|'home', position? , homePosition? }] where
// `amount` is the value to pass to the move executor (null = card's face value).
// Split amounts (7s and 9s) are only included when another peg can complete the
// split afterward. Jokers return [] — their targets are opponent pegs, not spaces.
export function getValidDestinations(player, pegIndex, card, currentPegs, options = {}) {
  const cardInfo = CARD_VALUES[card.rank];
  if (cardInfo.isJoker) return [];

  const candidates = [];
  if (cardInfo.canSplit) {
    candidates.push(null); // full 7
    for (let n = 1; n <= 6; n++) candidates.push(n);
  } else if (cardInfo.mustSplit) {
    for (let n = 1; n <= 8; n++) {
      candidates.push(n);
      candidates.push(-n);
    }
  } else {
    candidates.push(null);
  }

  const destinations = [];
  const seen = new Set();
  for (const amount of candidates) {
    if (!isValidMove(player, pegIndex, card, currentPegs, amount, options)) continue;

    if (amount !== null && (cardInfo.canSplit || cardInfo.mustSplit)) {
      const remaining = cardInfo.canSplit
        ? 7 - amount
        : (amount > 0 ? -(9 - amount) : 9 - Math.abs(amount));
      const { newPegs: afterFirst } = applyMove(player, pegIndex, card, amount, currentPegs, options);
      const completer = splitCompleter(player, afterFirst, options);
      let completable = false;
      for (let second = 0; second < PEGS_PER_PLAYER; second++) {
        if (completer === player && second === pegIndex) continue;
        if (isValidMove(completer, second, card, afterFirst, remaining, options)) {
          completable = true;
          break;
        }
      }
      if (!completable) continue;
    }

    const dest = applyMove(player, pegIndex, card, amount, currentPegs, options).newPegs[player][pegIndex];
    const key = dest.location === 'home' ? `h${dest.homePosition}` : `t${dest.position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    destinations.push(
      dest.location === 'home'
        ? { amount, location: 'home', homePosition: dest.homePosition }
        : { amount, location: 'track', position: dest.position }
    );
  }
  return destinations;
}

// Indices of the player's pegs that have at least one legal play with this card.
export function getMovablePegs(player, card, currentPegs, options = {}) {
  const cardInfo = CARD_VALUES[card.rank];
  const movable = [];
  for (let i = 0; i < PEGS_PER_PLAYER; i++) {
    if (cardInfo.isJoker) {
      if (isValidMove(player, i, card, currentPegs, null, options)) movable.push(i);
    } else if (getValidDestinations(player, i, card, currentPegs, options).length > 0) {
      movable.push(i);
    }
  }
  return movable;
}

// Diff two peg states and report pegs that were knocked from the track back to
// start (i.e. bumped), with the track position they were bumped from.
export function findBumps(oldPegs, newPegs) {
  const bumps = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    for (let i = 0; i < PEGS_PER_PLAYER; i++) {
      const before = oldPegs[p][i];
      const after = newPegs[p][i];
      if (before.location === 'track' && after.location === 'start') {
        bumps.push({ player: p, pegIndex: i, fromPosition: before.position });
      }
    }
  }
  return bumps;
}

// Diff two peg states for friendly partner bumps: a peg (other than the mover)
// that was shoved forward on the track to its own home-entrance space. Returns
// [{ player, pegIndex, fromPosition, toPosition }]. Used to animate the friendly
// bump distinctly from a knock-back-to-start.
export function findFriendlyBumps(oldPegs, newPegs, mover = null) {
  const bumps = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    for (let i = 0; i < PEGS_PER_PLAYER; i++) {
      if (mover && mover.player === p && mover.pegIndex === i) continue;
      const before = oldPegs[p][i];
      const after = newPegs[p][i];
      if (before.location === 'track' && after.location === 'track' &&
          before.position !== after.position && after.position === getHomeEntrance(p)) {
        bumps.push({ player: p, pegIndex: i, fromPosition: before.position, toPosition: after.position });
      }
    }
  }
  return bumps;
}

// Winner detection. In classic mode returns the first player with all pegs home.
// In partner mode returns the winning team index (0 or 1) once both partners have
// all their pegs home, or null.
export function checkWinner(currentPegs, mode = GAME_MODES.CLASSIC) {
  const allHome = (p) => currentPegs[p].every(peg => peg.location === 'home');
  if (mode === GAME_MODES.PARTNERS) {
    for (let t = 0; t < TEAMS.length; t++) {
      if (TEAMS[t].every(allHome)) return t;
    }
    return null;
  }
  for (let p = 0; p < NUM_PLAYERS; p++) {
    if (allHome(p)) return p;
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
      // Animate up to the home entrance, then into home.
      // The step that would land on `homeEntrance + 1` is the step into home
      // slot 0 (that is what makes `homeSteps = moveAmount - stepsToHome` the
      // final slot), so it must not also be drawn as a track space — otherwise
      // the peg counts one space more than the card played.
      for (let step = 1; step < stepsToHome; step++) {
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
