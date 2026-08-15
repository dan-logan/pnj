// AI move selection — pure functions over the peg/hand state.
import { CARD_VALUES, NUM_PLAYERS, PEGS_PER_PLAYER, GAME_MODES, getPartner, sameTeam } from './constants.js';
import {
  getStartPosition,
  getDistanceToHome,
  isValidMove,
  applyMove,
  applyJoker,
  splitCompleter
} from './engine.js';

// Calculate total distance for all of a player's pegs (lower is better)
function getTotalDistance(pegState, player) {
  return pegState[player].reduce((sum, peg) => sum + getDistanceToHome(peg, player), 0);
}

// The distance the AI is trying to minimize: its own pegs in classic mode, or
// the whole team's pegs in partner mode (so it values advancing its partner too).
function getReferenceDistance(pegState, actor, mode) {
  if (mode === GAME_MODES.PARTNERS) {
    return getTotalDistance(pegState, actor) + getTotalDistance(pegState, getPartner(actor));
  }
  return getTotalDistance(pegState, actor);
}

// Whose peg the AI moves this turn: normally its own, but once its own pegs are
// all home in partner mode it plays its hand on its partner's pegs.
function getControlledOwner(actor, mode, pegs) {
  if (mode === GAME_MODES.PARTNERS && pegs[actor].every(p => p.location === 'home')) {
    return getPartner(actor);
  }
  return actor;
}

// Calculate vulnerability penalty for a position (landing on an enemy's come-out
// spot is risky). Teammates can't bump us, so they don't count as threats.
function getVulnerabilityPenalty(position, pegState, owner, mode) {
  let penalty = 0;
  for (let p = 0; p < NUM_PLAYERS; p++) {
    const ally = mode === GAME_MODES.PARTNERS ? sameTeam(p, owner) : p === owner;
    if (ally) continue;
    const opponentStartPos = getStartPosition(p);
    if (position === opponentStartPos) {
      // Landing on opponent's come-out spot - they have ~30% chance to bump us back
      penalty += 15;
      // Extra penalty if opponent has pegs in start (more likely to use start card)
      const opponentPegsInStart = pegState[p].filter(peg => peg.location === 'start').length;
      penalty += opponentPegsInStart * 3;
    }
  }
  return penalty;
}

// Enumerate and score every legal move for the given hand.
// Move shapes carry `owner` (whose peg moves — the partner once the AI is home):
//   { type: 'simple'|'start', owner, card, pegIndex, amount, newPegs, improvement, bonus }
//   { type: 'split7'|'split9', owner, card, pegIndex, amount, secondPeg, secondOwner, remaining, newPegs, improvement, bonus }
//     (secondOwner is the owner of the completing peg — the partner when a
//      handoff split finishes the AI's last peg home; otherwise === owner)
//   { type: 'joker', owner, card, pegIndex, targetPlayer, targetPeg, newPegs, improvement, bonus }
// Every shape also carries `displacements`: the pegs the move shoves off their
// spaces, straight from the engine (both halves' worth for a split). The UI
// needs it to sound and announce bumps, and it cannot be recovered from
// `newPegs` alone — see resolveDisplacement in engine.js.
export function getPossibleMoves(actor, hand, pegs, options = {}) {
  const { mode = GAME_MODES.CLASSIC } = options;
  const owner = getControlledOwner(actor, mode, pegs);
  const moveOpts = { actor, mode };
  const distBefore = getReferenceDistance(pegs, actor, mode);
  const possibleMoves = [];

  for (const card of hand) {
    const cardInfo = CARD_VALUES[card.rank];

    // Try each peg
    for (let pegIndex = 0; pegIndex < PEGS_PER_PLAYER; pegIndex++) {
      const peg = pegs[owner][pegIndex];

      // Skip pegs in final home position
      if (peg.location === 'home' && peg.homePosition === 4) continue;

      // For non-split cards
      if (!cardInfo.canSplit && !cardInfo.mustSplit && !cardInfo.isJoker) {
        if (isValidMove(owner, pegIndex, card, pegs, null, moveOpts)) {
          const { newPegs, displacements } = applyMove(owner, pegIndex, card, null, pegs, moveOpts);
          const improvement = distBefore - getReferenceDistance(newPegs, actor, mode);

          // Calculate vulnerability penalty for landing position
          const movedPeg = newPegs[owner][pegIndex];
          const vulnPenalty = movedPeg.location === 'track'
            ? getVulnerabilityPenalty(movedPeg.position, newPegs, owner, mode)
            : 0;

          possibleMoves.push({
            type: 'simple',
            owner,
            card,
            pegIndex,
            amount: null,
            newPegs,
            displacements,
            improvement,
            // Bonus for moving pegs already in home deeper, minus vulnerability
            bonus: (peg.location === 'home' ? 10 : 0) - vulnPenalty
          });
        }
      }

      // For 7 card (can split forward)
      if (cardInfo.canSplit) {
        // Try full 7 first
        if (isValidMove(owner, pegIndex, card, pegs, 7, moveOpts)) {
          const { newPegs, displacements } = applyMove(owner, pegIndex, card, 7, pegs, moveOpts);
          const improvement = distBefore - getReferenceDistance(newPegs, actor, mode);
          const movedPeg = newPegs[owner][pegIndex];
          const vulnPenalty = movedPeg.location === 'track'
            ? getVulnerabilityPenalty(movedPeg.position, newPegs, owner, mode)
            : 0;
          possibleMoves.push({
            type: 'simple',
            owner,
            card,
            pegIndex,
            amount: 7,
            newPegs,
            displacements,
            improvement,
            bonus: (peg.location === 'home' ? 10 : 0) - vulnPenalty
          });
        }

        // Try splits
        for (let split = 1; split <= 6; split++) {
          if (isValidMove(owner, pegIndex, card, pegs, split, moveOpts)) {
            const { newPegs: afterFirst, displacements: firstDisp } = applyMove(owner, pegIndex, card, split, pegs, moveOpts);
            const remaining = 7 - split;
            // Normally the same owner finishes the split, but a first half that
            // brings the AI's last peg home hands the remainder to its partner —
            // letting a split both finish the AI and advance its partner.
            const completer = splitCompleter(owner, afterFirst, moveOpts);

            // Find another peg for the remaining
            for (let secondPeg = 0; secondPeg < PEGS_PER_PLAYER; secondPeg++) {
              if (completer === owner && secondPeg === pegIndex) continue;
              if (isValidMove(completer, secondPeg, card, afterFirst, remaining, moveOpts)) {
                const { newPegs: finalPegs, displacements: secondDisp } = applyMove(completer, secondPeg, card, remaining, afterFirst, moveOpts);
                const improvement = distBefore - getReferenceDistance(finalPegs, actor, mode);

                // Calculate vulnerability for both moved pegs
                const peg1 = finalPegs[owner][pegIndex];
                const peg2 = finalPegs[completer][secondPeg];
                const vuln1 = peg1.location === 'track' ? getVulnerabilityPenalty(peg1.position, finalPegs, owner, mode) : 0;
                const vuln2 = peg2.location === 'track' ? getVulnerabilityPenalty(peg2.position, finalPegs, completer, mode) : 0;

                possibleMoves.push({
                  type: 'split7',
                  owner,
                  card,
                  pegIndex,
                  amount: split,
                  secondPeg,
                  secondOwner: completer,
                  remaining,
                  newPegs: finalPegs,
                  // Both halves', in the order they happened.
                  displacements: [...firstDisp, ...secondDisp],
                  improvement,
                  bonus: (pegs[owner][pegIndex].location === 'home' ? 10 : 0) +
                         (afterFirst[completer][secondPeg].location === 'home' ? 10 : 0) -
                         vuln1 - vuln2
                });
              }
            }
          }
        }
      }

      // For 9 card (must split forward/backward)
      if (cardInfo.mustSplit) {
        for (let forward = 1; forward <= 8; forward++) {
          const backward = -(9 - forward);

          // Try this peg forward
          if (isValidMove(owner, pegIndex, card, pegs, forward, moveOpts)) {
            const { newPegs: afterFirst, displacements: firstDisp } = applyMove(owner, pegIndex, card, forward, pegs, moveOpts);
            // A forward half that brings the AI's last peg home hands the
            // backward half to its partner (same handoff boundary as the 7).
            const completer = splitCompleter(owner, afterFirst, moveOpts);

            // Find another peg for backward
            for (let secondPeg = 0; secondPeg < PEGS_PER_PLAYER; secondPeg++) {
              if (completer === owner && secondPeg === pegIndex) continue;
              if (isValidMove(completer, secondPeg, card, afterFirst, backward, moveOpts)) {
                const { newPegs: finalPegs, displacements: secondDisp } = applyMove(completer, secondPeg, card, backward, afterFirst, moveOpts);
                const improvement = distBefore - getReferenceDistance(finalPegs, actor, mode);

                // Calculate vulnerability for both moved pegs
                const peg1 = finalPegs[owner][pegIndex];
                const peg2 = finalPegs[completer][secondPeg];
                const vuln1 = peg1.location === 'track' ? getVulnerabilityPenalty(peg1.position, finalPegs, owner, mode) : 0;
                const vuln2 = peg2.location === 'track' ? getVulnerabilityPenalty(peg2.position, finalPegs, completer, mode) : 0;

                possibleMoves.push({
                  type: 'split9',
                  owner,
                  card,
                  pegIndex,
                  amount: forward,
                  secondPeg,
                  secondOwner: completer,
                  remaining: backward,
                  newPegs: finalPegs,
                  displacements: [...firstDisp, ...secondDisp],
                  improvement,
                  bonus: (pegs[owner][pegIndex].location === 'home' ? 10 : 0) - vuln1 - vuln2
                });
              }
            }
          }
        }
      }

      // For starting cards (A, J, Q, K) - try to get pegs out of start
      if (cardInfo.canStart && peg.location === 'start') {
        if (isValidMove(owner, pegIndex, card, pegs, null, moveOpts)) {
          const { newPegs, displacements } = applyMove(owner, pegIndex, card, null, pegs, moveOpts);
          const improvement = distBefore - getReferenceDistance(newPegs, actor, mode);
          const startPos = getStartPosition(owner);
          const vulnPenalty = getVulnerabilityPenalty(startPos, newPegs, owner, mode);
          possibleMoves.push({
            type: 'start',
            owner,
            card,
            pegIndex,
            amount: null,
            newPegs,
            displacements,
            improvement,
            bonus: -5 - vulnPenalty // Slight penalty vs advancing existing pegs, plus vulnerability
          });
        }
      }

      // For Joker - bump a peg on the track (an opponent, or a partner for a
      // strategic friendly bump to their home entrance)
      if (cardInfo.isJoker && (peg.location === 'start' || peg.location === 'track')) {
        for (let targetPlayer = 0; targetPlayer < NUM_PLAYERS; targetPlayer++) {
          if (targetPlayer === owner) continue;
          for (let targetPeg = 0; targetPeg < PEGS_PER_PLAYER; targetPeg++) {
            const opponentPeg = pegs[targetPlayer][targetPeg];
            if (opponentPeg.location !== 'track') continue;

            const { newPegs, bumped, displacements } = applyJoker(owner, pegIndex, targetPlayer, targetPeg, pegs, moveOpts);
            if (!bumped) continue; // illegal (e.g. friendly bump with a blocked entrance)

            const improvement = distBefore - getReferenceDistance(newPegs, actor, mode);
            const friendly = mode === GAME_MODES.PARTNERS && sameTeam(targetPlayer, actor);

            let jokerBonus;
            if (friendly) {
              // Value comes from the team-distance improvement; no bump bonus.
              jokerBonus = 0;
            } else {
              jokerBonus = 5; // Base bonus for bumping an opponent

              // Bonus for bumping an opponent who was close to home
              const opponentDistToHome = getDistanceToHome(opponentPeg, targetPlayer);
              if (opponentDistToHome < 20) {
                jokerBonus += Math.floor((20 - opponentDistToHome) / 2);
              }

              // Heavy penalty for landing on the bumped player's come-out spot
              const oppStartPos = getStartPosition(targetPlayer);
              if (opponentPeg.position === oppStartPos) {
                jokerBonus -= 30;
              }
              jokerBonus -= getVulnerabilityPenalty(opponentPeg.position, newPegs, owner, mode);
            }

            possibleMoves.push({
              type: 'joker',
              owner,
              card,
              pegIndex,
              targetPlayer,
              targetPeg,
              newPegs,
              displacements,
              improvement,
              bonus: jokerBonus
            });
          }
        }
      }
    }
  }

  return possibleMoves;
}

// Pick the highest-scoring move, or null if no move is possible (caller should discard).
export function findBestAIMove(player, hand, pegs, options = {}) {
  const possibleMoves = getPossibleMoves(player, hand, pegs, options);
  if (possibleMoves.length === 0) return null;
  possibleMoves.sort((a, b) => (b.improvement + b.bonus) - (a.improvement + a.bonus));
  return possibleMoves[0];
}
