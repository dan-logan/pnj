// AI move selection — pure functions over the peg/hand state.
import { CARD_VALUES, NUM_PLAYERS, PEGS_PER_PLAYER } from './constants.js';
import {
  getStartPosition,
  getDistanceToHome,
  isValidMove,
  applyMove
} from './engine.js';

// Calculate total distance for all of a player's pegs (lower is better)
function getTotalDistance(pegState, player) {
  return pegState[player].reduce((sum, peg) => sum + getDistanceToHome(peg, player), 0);
}

// Calculate vulnerability penalty for a position (landing on opponent's come-out spot is risky)
function getVulnerabilityPenalty(position, pegState, player) {
  let penalty = 0;
  for (let p = 0; p < NUM_PLAYERS; p++) {
    if (p === player) continue;
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
// Move shapes:
//   { type: 'simple'|'start', card, pegIndex, amount, newPegs, improvement, bonus }
//   { type: 'split7'|'split9', card, pegIndex, amount, secondPeg, remaining, newPegs, improvement, bonus }
//   { type: 'joker', card, pegIndex, targetPlayer, targetPeg, newPegs, improvement, bonus }
export function getPossibleMoves(player, hand, pegs) {
  const possibleMoves = [];

  for (const card of hand) {
    const cardInfo = CARD_VALUES[card.rank];

    // Try each peg
    for (let pegIndex = 0; pegIndex < PEGS_PER_PLAYER; pegIndex++) {
      const peg = pegs[player][pegIndex];

      // Skip pegs in final home position
      if (peg.location === 'home' && peg.homePosition === 4) continue;

      // For non-split cards
      if (!cardInfo.canSplit && !cardInfo.mustSplit && !cardInfo.isJoker) {
        if (isValidMove(player, pegIndex, card, pegs)) {
          const { newPegs } = applyMove(player, pegIndex, card, null, pegs);
          const currentDist = getTotalDistance(pegs, player);
          const newDist = getTotalDistance(newPegs, player);
          const improvement = currentDist - newDist;

          // Calculate vulnerability penalty for landing position
          const movedPeg = newPegs[player][pegIndex];
          const vulnPenalty = movedPeg.location === 'track'
            ? getVulnerabilityPenalty(movedPeg.position, newPegs, player)
            : 0;

          possibleMoves.push({
            type: 'simple',
            card,
            pegIndex,
            amount: null,
            newPegs,
            improvement,
            // Bonus for moving pegs already in home deeper, minus vulnerability
            bonus: (peg.location === 'home' ? 10 : 0) - vulnPenalty
          });
        }
      }

      // For 7 card (can split forward)
      if (cardInfo.canSplit) {
        // Try full 7 first
        if (isValidMove(player, pegIndex, card, pegs, 7)) {
          const { newPegs } = applyMove(player, pegIndex, card, 7, pegs);
          const improvement = getTotalDistance(pegs, player) - getTotalDistance(newPegs, player);
          const movedPeg = newPegs[player][pegIndex];
          const vulnPenalty = movedPeg.location === 'track'
            ? getVulnerabilityPenalty(movedPeg.position, newPegs, player)
            : 0;
          possibleMoves.push({
            type: 'simple',
            card,
            pegIndex,
            amount: 7,
            newPegs,
            improvement,
            bonus: (peg.location === 'home' ? 10 : 0) - vulnPenalty
          });
        }

        // Try splits
        for (let split = 1; split <= 6; split++) {
          if (isValidMove(player, pegIndex, card, pegs, split)) {
            const { newPegs: afterFirst } = applyMove(player, pegIndex, card, split, pegs);
            const remaining = 7 - split;

            // Find another peg for the remaining
            for (let secondPeg = 0; secondPeg < PEGS_PER_PLAYER; secondPeg++) {
              if (secondPeg === pegIndex) continue;
              if (isValidMove(player, secondPeg, card, afterFirst, remaining)) {
                const { newPegs: finalPegs } = applyMove(player, secondPeg, card, remaining, afterFirst);
                const improvement = getTotalDistance(pegs, player) - getTotalDistance(finalPegs, player);

                // Calculate vulnerability for both moved pegs
                const peg1 = finalPegs[player][pegIndex];
                const peg2 = finalPegs[player][secondPeg];
                const vuln1 = peg1.location === 'track' ? getVulnerabilityPenalty(peg1.position, finalPegs, player) : 0;
                const vuln2 = peg2.location === 'track' ? getVulnerabilityPenalty(peg2.position, finalPegs, player) : 0;

                possibleMoves.push({
                  type: 'split7',
                  card,
                  pegIndex,
                  amount: split,
                  secondPeg,
                  remaining,
                  newPegs: finalPegs,
                  improvement,
                  bonus: (pegs[player][pegIndex].location === 'home' ? 10 : 0) +
                         (afterFirst[player][secondPeg].location === 'home' ? 10 : 0) -
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
          if (isValidMove(player, pegIndex, card, pegs, forward)) {
            const { newPegs: afterFirst } = applyMove(player, pegIndex, card, forward, pegs);

            // Find another peg for backward
            for (let secondPeg = 0; secondPeg < PEGS_PER_PLAYER; secondPeg++) {
              if (secondPeg === pegIndex) continue;
              if (isValidMove(player, secondPeg, card, afterFirst, backward)) {
                const { newPegs: finalPegs } = applyMove(player, secondPeg, card, backward, afterFirst);
                const improvement = getTotalDistance(pegs, player) - getTotalDistance(finalPegs, player);

                // Calculate vulnerability for both moved pegs
                const peg1 = finalPegs[player][pegIndex];
                const peg2 = finalPegs[player][secondPeg];
                const vuln1 = peg1.location === 'track' ? getVulnerabilityPenalty(peg1.position, finalPegs, player) : 0;
                const vuln2 = peg2.location === 'track' ? getVulnerabilityPenalty(peg2.position, finalPegs, player) : 0;

                possibleMoves.push({
                  type: 'split9',
                  card,
                  pegIndex,
                  amount: forward,
                  secondPeg,
                  remaining: backward,
                  newPegs: finalPegs,
                  improvement,
                  bonus: (pegs[player][pegIndex].location === 'home' ? 10 : 0) - vuln1 - vuln2
                });
              }
            }
          }
        }
      }

      // For starting cards (A, J, Q, K) - try to get pegs out of start
      if (cardInfo.canStart && peg.location === 'start') {
        if (isValidMove(player, pegIndex, card, pegs)) {
          const { newPegs } = applyMove(player, pegIndex, card, null, pegs);
          const improvement = getTotalDistance(pegs, player) - getTotalDistance(newPegs, player);
          const startPos = getStartPosition(player);
          const vulnPenalty = getVulnerabilityPenalty(startPos, newPegs, player);
          possibleMoves.push({
            type: 'start',
            card,
            pegIndex,
            amount: null,
            newPegs,
            improvement,
            bonus: -5 - vulnPenalty // Slight penalty vs advancing existing pegs, plus vulnerability
          });
        }
      }

      // For Joker - bump opponent pegs
      if (cardInfo.isJoker && (peg.location === 'start' || peg.location === 'track')) {
        // Find opponent pegs to bump
        for (let oppPlayer = 0; oppPlayer < NUM_PLAYERS; oppPlayer++) {
          if (oppPlayer === player) continue;
          for (let oppPeg = 0; oppPeg < PEGS_PER_PLAYER; oppPeg++) {
            const opponentPeg = pegs[oppPlayer][oppPeg];
            if (opponentPeg.location === 'track') {
              const targetPosition = opponentPeg.position;
              const newPegs = pegs.map(p => p.map(pg => ({ ...pg })));
              // Bump opponent
              newPegs[oppPlayer][oppPeg] = { location: 'start', index: oppPeg };
              // Move our peg there
              newPegs[player][pegIndex].location = 'track';
              newPegs[player][pegIndex].position = targetPosition;

              const improvement = getTotalDistance(pegs, player) - getTotalDistance(newPegs, player);

              // Calculate bonuses and penalties for Joker usage
              let jokerBonus = 5; // Base bonus for bumping

              // Bonus for bumping opponent who was close to home (more valuable disruption)
              const opponentDistToHome = getDistanceToHome(opponentPeg, oppPlayer);
              if (opponentDistToHome < 20) {
                jokerBonus += Math.floor((20 - opponentDistToHome) / 2);
              }

              // Heavy penalty for landing on the bumped player's come-out spot
              // They're very likely to have a start card since we just sent them back
              const oppStartPos = getStartPosition(oppPlayer);
              if (targetPosition === oppStartPos) {
                jokerBonus -= 30; // Major penalty - likely wastes the Joker
              }

              // General vulnerability penalty for other come-out spots
              const vulnPenalty = getVulnerabilityPenalty(targetPosition, newPegs, player);
              jokerBonus -= vulnPenalty;

              possibleMoves.push({
                type: 'joker',
                card,
                pegIndex,
                targetPlayer: oppPlayer,
                targetPeg: oppPeg,
                newPegs,
                improvement,
                bonus: jokerBonus
              });
            }
          }
        }
      }
    }
  }

  return possibleMoves;
}

// Pick the highest-scoring move, or null if no move is possible (caller should discard).
export function findBestAIMove(player, hand, pegs) {
  const possibleMoves = getPossibleMoves(player, hand, pegs);
  if (possibleMoves.length === 0) return null;
  possibleMoves.sort((a, b) => (b.improvement + b.bonus) - (a.improvement + a.bonus));
  return possibleMoves[0];
}
