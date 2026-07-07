import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  CARD_VALUES,
  TRACK_LENGTH,
  SPACES_PER_SIDE,
  PLAYER_COLORS,
  PLAYER_NAMES
} from './game/constants.js';
import { createDeck, drawCard } from './game/deck.js';
import {
  createInitialPegs,
  getStartPosition,
  describeMoveAction,
  findPegAtPosition,
  isValidMove,
  hasAnyValidMove,
  applyMove,
  checkWinner,
  calculateMovePath
} from './game/engine.js';
import { findBestAIMove } from './game/ai.js';

export default function PegsAndJokers() {
  const [deck, setDeck] = useState([]);
  const [discardPiles, setDiscardPiles] = useState([[], [], [], []]); // Per-player discard piles
  const [stuckCounts, setStuckCounts] = useState([0, 0, 0, 0]); // Track stuck discards per player
  const [hands, setHands] = useState([[], [], [], []]);
  const [pegs, setPegs] = useState(createInitialPegs);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [selectedCard, setSelectedCard] = useState(null);
  const [selectedPeg, setSelectedPeg] = useState(null);
  const [splitRemaining, setSplitRemaining] = useState(0);
  const [splitCard, setSplitCard] = useState(null);
  const [splitPegIndex, setSplitPegIndex] = useState(null); // Track which peg was moved in first part of split
  const [jokerMode, setJokerMode] = useState(false); // true when waiting for target selection
  const [jokerSourcePeg, setJokerSourcePeg] = useState(null); // which of player's pegs to move
  const [discardMode, setDiscardMode] = useState(false); // true when player is selecting a card to discard
  const [gameMessage, setGameMessage] = useState('Your turn! Select a card and peg to move.');
  const [winner, setWinner] = useState(null);
  const [moveHistory, setMoveHistory] = useState([]);
  const [lastMoves, setLastMoves] = useState([null, null, null, null]); // Last move description per player
  const aiProcessingRef = useRef(false); // Prevent AI from running twice on same turn

  // Animation state
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [animatingPeg, setAnimatingPeg] = useState(null); // { player, pegIndex, positions: [], currentStep: 0 }
  const animationRef = useRef(null);

  // First player selection state
  const [showFirstPlayerModal, setShowFirstPlayerModal] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinningPlayer, setSpinningPlayer] = useState(0);
  const spinIntervalRef = useRef(null);

  const startGameWithPlayer = useCallback((firstPlayer) => {
    const newDeck = createDeck();
    const hand1 = newDeck.splice(0, 6);
    const hand2 = newDeck.splice(0, 6);
    const hand3 = newDeck.splice(0, 6);
    const hand4 = newDeck.splice(0, 6);
    setDeck(newDeck);
    setDiscardPiles([[], [], [], []]);
    setStuckCounts([0, 0, 0, 0]);
    setHands([hand1, hand2, hand3, hand4]);
    setPegs(createInitialPegs());
    setCurrentPlayer(firstPlayer);
    setSelectedCard(null);
    setSelectedPeg(null);
    setSplitRemaining(0);
    setSplitCard(null);
    setSplitPegIndex(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);
    setGameMessage(firstPlayer === 0 ? 'Your turn! Select a card and peg to move.' : `${PLAYER_NAMES[firstPlayer]} is thinking...`);
    setWinner(null);
    setMoveHistory([]);
    setLastMoves([null, null, null, null]);
    aiProcessingRef.current = false;
    setAnimatingPeg(null);
    if (animationRef.current) {
      clearInterval(animationRef.current);
      animationRef.current = null;
    }
    setShowFirstPlayerModal(false);
  }, []);

  const handleGoFirst = useCallback(() => {
    startGameWithPlayer(0);
  }, [startGameWithPlayer]);

  const handleRandomFirst = useCallback(() => {
    setIsSpinning(true);

    // Pre-select random player so spinner lands on them
    const randomPlayer = Math.floor(Math.random() * 4);
    const baseSpins = 12; // At least 3 full cycles
    const extraSpins = Math.floor(Math.random() * 8); // 0-7 extra spins
    const totalSpins = baseSpins + extraSpins + randomPlayer; // Ends on randomPlayer

    let currentIndex = 0;
    let spinCount = 0;
    const spinDuration = 100; // milliseconds per spin

    spinIntervalRef.current = setInterval(() => {
      spinCount++;
      currentIndex = (currentIndex + 1) % 4;
      setSpinningPlayer(currentIndex);

      if (spinCount >= totalSpins) {
        clearInterval(spinIntervalRef.current);
        spinIntervalRef.current = null;

        // Wait a moment to show the final selection, then start game
        setTimeout(() => {
          setIsSpinning(false);
          startGameWithPlayer(currentIndex);
        }, 800);
      }
    }, spinDuration);
  }, [startGameWithPlayer]);

  const initGame = useCallback(() => {
    // Clear any ongoing animations
    if (animationRef.current) {
      clearInterval(animationRef.current);
      animationRef.current = null;
    }
    if (spinIntervalRef.current) {
      clearInterval(spinIntervalRef.current);
      spinIntervalRef.current = null;
    }

    setAnimatingPeg(null);
    setIsSpinning(false);
    setSpinningPlayer(0);
    setWinner(null);
    aiProcessingRef.current = false;

    // Show the modal to choose first player
    setShowFirstPlayerModal(true);
  }, []);

  useEffect(() => {
    initGame();
  }, [initGame]);

  // Run animation for a move, then call onComplete when done
  const animateMove = useCallback((player, pegIndex, card, amount, currentPegs, onComplete) => {
    const path = calculateMovePath(player, pegIndex, card, amount, currentPegs);

    if (path.length === 0) {
      // No animation needed (e.g., Joker), complete immediately
      onComplete();
      return;
    }

    // Start animation
    setAnimatingPeg({
      player,
      pegIndex,
      path,
      currentStep: 0
    });

    let step = 0;
    animationRef.current = setInterval(() => {
      step++;
      if (step >= path.length) {
        // Animation complete
        clearInterval(animationRef.current);
        animationRef.current = null;
        setAnimatingPeg(null);
        onComplete();
      } else {
        setAnimatingPeg(prev => prev ? { ...prev, currentStep: step } : null);
      }
    }, 150); // 150ms per step
  }, []);

  const executeMove = useCallback((player, pegIndex, card, splitAmount = null) => {
    if (!isValidMove(player, pegIndex, card, pegs, splitAmount)) {
      setGameMessage('Invalid move. Try again.');
      return false;
    }

    const cardInfo = CARD_VALUES[card.rank];

    // For 9 card splits, validate that a second peg can complete the split BEFORE executing the first move
    if (cardInfo.mustSplit && splitAmount !== null) {
      const remaining = splitAmount > 0 ? -(9 - splitAmount) : (9 - Math.abs(splitAmount));

      // Simulate the first move to get the intermediate state
      const { newPegs: afterFirstMove } = applyMove(player, pegIndex, card, splitAmount, pegs);

      // Check if there's at least one other peg that can make the second move
      let hasValidSecondPeg = false;
      for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
        if (secondPeg === pegIndex) continue; // Must use a different peg
        if (isValidMove(player, secondPeg, card, afterFirstMove, remaining)) {
          hasValidSecondPeg = true;
          break;
        }
      }

      if (!hasValidSecondPeg) {
        setGameMessage(`Cannot split: no other peg can move ${Math.abs(remaining)} ${remaining > 0 ? 'forward' : 'backward'}.`);
        return false;
      }
    }

    // For 7 card splits, validate that a second peg can complete the split BEFORE executing the first move
    if (cardInfo.canSplit && splitAmount !== null && splitAmount < 7) {
      const remaining = 7 - splitAmount;

      // Simulate the first move to get the intermediate state
      const { newPegs: afterFirstMove } = applyMove(player, pegIndex, card, splitAmount, pegs);

      // Check if there's at least one OTHER peg that can make the second move
      let hasValidSecondPeg = false;
      for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
        if (secondPeg === pegIndex) continue; // Must use a different peg
        if (isValidMove(player, secondPeg, card, afterFirstMove, remaining)) {
          hasValidSecondPeg = true;
          break;
        }
      }

      if (!hasValidSecondPeg) {
        setGameMessage(`Cannot split: no other peg can move the remaining ${remaining} spaces.`);
        return false;
      }
    }

    const oldPeg = pegs[player][pegIndex];
    const { newPegs } = applyMove(player, pegIndex, card, splitAmount, pegs);
    const newPeg = newPegs[player][pegIndex];

    // Record last move description
    const moveDescription = describeMoveAction(oldPeg, newPeg, card, splitAmount);
    setLastMoves(prev => {
      const updated = [...prev];
      updated[player] = moveDescription;
      return updated;
    });

    setPegs(newPegs);

    // Handle 7 card splitting
    if (cardInfo.canSplit && splitAmount !== null && splitAmount < 7) {
      const remaining = 7 - splitAmount;
      setSplitRemaining(remaining);
      setSplitCard(card);
      setSplitPegIndex(pegIndex); // Track which peg was moved first
      setSelectedPeg(null);
      setGameMessage(`Move remaining ${remaining} spaces with another peg.`);
      return true;
    }

    // Handle 9 card (must split forward/backward)
    if (cardInfo.mustSplit && splitAmount !== null) {
      const remaining = 9 - Math.abs(splitAmount);
      const direction = splitAmount > 0 ? 'backward' : 'forward';
      setSplitRemaining(splitAmount > 0 ? -remaining : remaining);
      setSplitCard(card);
      setSplitPegIndex(pegIndex); // Track which peg was moved first
      setSelectedPeg(null);
      setGameMessage(`Move ${remaining} spaces ${direction} with another peg.`);
      return true;
    }

    const w = checkWinner(newPegs);
    if (w !== null) {
      setWinner(w);
      return true;
    }

    // Remove card from hand and draw new one
    const newHands = hands.map(h => [...h]);
    const cardIndex = newHands[player].findIndex(c => c.id === card.id);
    const discarded = newHands[player].splice(cardIndex, 1)[0];

    // Add to player's discard pile
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === player ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[player].push(newCard);

    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);

    // Reset stuck count on successful move
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[player] = 0;
    setStuckCounts(newStuckCounts);

    setSelectedCard(null);
    setSelectedPeg(null);
    setSplitRemaining(0);
    setSplitCard(null);
    setSplitPegIndex(null);

    // Switch to next player
    const nextPlayer = (player + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);

    return true;
  }, [pegs, hands, deck, discardPiles, stuckCounts]);

  const completeSplit = useCallback((pegIndex, amount) => {
    // For both 7 and 9 cards, ensure different pegs are used
    const cardInfo = CARD_VALUES[splitCard?.rank];
    if ((cardInfo?.mustSplit || cardInfo?.canSplit) && pegIndex === splitPegIndex) {
      const cardName = cardInfo?.mustSplit ? 'Nine' : 'Seven';
      setGameMessage(`${cardName} card must use two different pegs. Try again.`);
      return false;
    }

    if (!isValidMove(currentPlayer, pegIndex, splitCard, pegs, amount)) {
      setGameMessage('Invalid move for split. Try again.');
      return false;
    }

    const oldPeg = pegs[currentPlayer][pegIndex];
    const { newPegs } = applyMove(currentPlayer, pegIndex, splitCard, amount, pegs);
    const newPeg = newPegs[currentPlayer][pegIndex];

    // Update last move description to show split completion
    const secondMoveDesc = describeMoveAction(oldPeg, newPeg, splitCard, amount);
    setLastMoves(prev => {
      const updated = [...prev];
      updated[currentPlayer] = `Split: ${prev[currentPlayer]}, ${secondMoveDesc}`;
      return updated;
    });

    setPegs(newPegs);

    const w = checkWinner(newPegs);
    if (w !== null) {
      setWinner(w);
      return true;
    }

    const newHands = hands.map(h => [...h]);
    const cardIndex = newHands[currentPlayer].findIndex(c => c.id === splitCard.id);
    const discarded = newHands[currentPlayer].splice(cardIndex, 1)[0];

    // Add to player's discard pile
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === currentPlayer ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[currentPlayer].push(newCard);

    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);

    // Reset stuck count on successful move
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[currentPlayer] = 0;
    setStuckCounts(newStuckCounts);

    setSelectedCard(null);
    setSelectedPeg(null);
    setSplitRemaining(0);
    setSplitCard(null);
    setSplitPegIndex(null);
    const nextPlayer = (currentPlayer + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);

    return true;
  }, [currentPlayer, splitCard, splitPegIndex, pegs, hands, deck, discardPiles, stuckCounts]);

  const discardAndDraw = useCallback((player, cardIndex = 0) => {
    if (hands[player].length === 0) return;

    const newHands = hands.map(h => [...h]);
    // Use provided cardIndex for player selection, otherwise first card (for AI)
    const discarded = newHands[player].splice(cardIndex, 1)[0];

    // Add to player's discard pile (face down for stuck discards - we track separately)
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === player ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[player].push(newCard);

    // Update stuck count
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[player] = stuckCounts[player] + 1;

    // After 3 stuck discards, allow player to start a peg (auto-start next peg)
    let newPegs = pegs;
    let autoStarted = false;
    if (newStuckCounts[player] >= 3) {
      // Find a peg in start and move it to come-out position
      const pegInStart = pegs[player].findIndex(p => p.location === 'start');
      if (pegInStart !== -1) {
        const startPos = getStartPosition(player);
        const pegAtStart = findPegAtPosition(startPos, pegs);

        // Only auto-start if come-out spot is free of own peg
        const ownPegAtStart = pegs[player].some(p => p.location === 'track' && p.position === startPos);

        if (!ownPegAtStart) {
          newPegs = pegs.map((playerPegs) => playerPegs.map(peg => ({ ...peg })));

          // Bump opponent if present
          if (pegAtStart && pegAtStart.player !== player) {
            newPegs[pegAtStart.player][pegAtStart.pegIndex] = { location: 'start', index: pegAtStart.pegIndex };
          }

          // Move our peg out
          newPegs[player][pegInStart].location = 'track';
          newPegs[player][pegInStart].position = startPos;

          newStuckCounts[player] = 0;
          autoStarted = true;

          if (player === 0) {
            setGameMessage('After 3 stuck turns, you start a peg!');
          }
        }
      }
      newStuckCounts[player] = 0; // Reset even if no peg to start
    }

    // Record last move description for discard
    setLastMoves(prev => {
      const updated = [...prev];
      updated[player] = autoStarted ? 'Stuck 3x - Started a peg' : 'Discarded (stuck)';
      return updated;
    });

    setPegs(newPegs);
    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);
    setStuckCounts(newStuckCounts);
    setSelectedCard(null);
    setSelectedPeg(null);
    setDiscardMode(false);

    if (player === 0) {
      const nextPlayer = 1;
      setCurrentPlayer(nextPlayer);
      if (newStuckCounts[0] === 0 && newPegs !== pegs) {
        // Delay message change so player sees the "start a peg" message
        setTimeout(() => setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`), 1500);
      } else {
        setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);
      }
    } else {
      // AI player discarded - show message with stuck count, then advance player
      const nextPlayer = (player + 1) % 4;

      if (newStuckCounts[player] === 0 && newPegs !== pegs) {
        setGameMessage(`${PLAYER_NAMES[player]} was stuck 3 turns and started a peg!`);
      } else {
        setGameMessage(`${PLAYER_NAMES[player]} discarded (stuck: ${newStuckCounts[player]}/3)`);
      }

      // Set next player immediately to prevent useEffect from re-triggering
      setCurrentPlayer(nextPlayer);
      aiProcessingRef.current = false; // Allow next AI to process

      // Delay the "thinking" message so discard message is visible
      setTimeout(() => {
        if (nextPlayer === 0) {
          setGameMessage('Your turn! Select a card and peg to move.');
        }
        // If next is AI, the useEffect will set the message
      }, 1200);
    }
  }, [hands, deck, discardPiles, stuckCounts, pegs]);

  // AI logic - handles players 1, 2, 3
  useEffect(() => {
    if (currentPlayer === 0 || winner !== null) return;
    if (aiProcessingRef.current) return; // Already processing this turn

    aiProcessingRef.current = true;
    const aiPlayer = currentPlayer;
    const nextPlayer = (currentPlayer + 1) % 4;

    const timer = setTimeout(() => {
      const aiHand = hands[aiPlayer];

      // Helper function to complete AI move
      const completeAIMove = (newPegs, card, moveDescription) => {
        // Record last move description for AI
        setLastMoves(prev => {
          const updated = [...prev];
          updated[aiPlayer] = moveDescription;
          return updated;
        });

        setPegs(newPegs);

        const newHands = hands.map(h => [...h]);
        const cardIndex = newHands[aiPlayer].findIndex(c => c.id === card.id);
        const discarded = newHands[aiPlayer].splice(cardIndex, 1)[0];

        // Add to AI player's discard pile
        const newDiscardPiles = discardPiles.map((pile, i) =>
          i === aiPlayer ? [...pile, discarded] : [...pile]
        );

        const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
        if (newCard) newHands[aiPlayer].push(newCard);

        setHands(newHands);
        setDeck(newDeck);
        setDiscardPiles(updatedDiscardPiles);

        // Reset stuck count on successful move
        const newStuckCounts = [...stuckCounts];
        newStuckCounts[aiPlayer] = 0;
        setStuckCounts(newStuckCounts);

        const w = checkWinner(newPegs);
        if (w !== null) {
          setWinner(w);
          aiProcessingRef.current = false;
          return true;
        }

        setCurrentPlayer(nextPlayer);
        aiProcessingRef.current = false;
        if (nextPlayer === 0) {
          setGameMessage('Your turn! Select a card and peg to move.');
        } else {
          setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);
        }
        return false;
      };

      // Pick the best scored move for this hand
      const bestMove = findBestAIMove(aiPlayer, aiHand, pegs);

      if (bestMove) {
        // Generate move description based on move type
        const getMoveDescription = () => {
          const oldPeg = pegs[aiPlayer][bestMove.pegIndex];
          const newPeg = bestMove.newPegs[aiPlayer][bestMove.pegIndex];

          if (bestMove.type === 'simple' || bestMove.type === 'start') {
            return describeMoveAction(oldPeg, newPeg, bestMove.card, bestMove.amount);
          } else if (bestMove.type === 'split7' || bestMove.type === 'split9') {
            const afterFirst = applyMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs).newPegs;
            const firstDesc = describeMoveAction(oldPeg, afterFirst[aiPlayer][bestMove.pegIndex], bestMove.card, bestMove.amount);
            const secondOldPeg = afterFirst[aiPlayer][bestMove.secondPeg];
            const secondNewPeg = bestMove.newPegs[aiPlayer][bestMove.secondPeg];
            const secondDesc = describeMoveAction(secondOldPeg, secondNewPeg, bestMove.card, bestMove.remaining);
            return `Split: ${firstDesc}, ${secondDesc}`;
          } else if (bestMove.type === 'joker') {
            return `Joker bumped ${PLAYER_NAMES[bestMove.targetPlayer]}`;
          }
          return 'Moved';
        };

        const moveDescription = getMoveDescription();

        // If animations disabled, just complete immediately
        if (!animationsEnabled) {
          if (completeAIMove(bestMove.newPegs, bestMove.card, moveDescription)) return;
          return;
        }

        // Animate the move before completing
        if (bestMove.type === 'simple' || bestMove.type === 'start') {
          // Single move animation
          animateMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            completeAIMove(bestMove.newPegs, bestMove.card, moveDescription);
          });
        } else if (bestMove.type === 'split7') {
          // Two-part animation for 7 split
          animateMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg
            const afterFirstPegs = applyMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs).newPegs;
            animateMove(aiPlayer, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription);
            });
          });
        } else if (bestMove.type === 'split9') {
          // Two-part animation for 9 split
          animateMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg
            const afterFirstPegs = applyMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs).newPegs;
            animateMove(aiPlayer, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription);
            });
          });
        } else if (bestMove.type === 'joker') {
          // Joker - just complete (animation path is empty for jokers)
          completeAIMove(bestMove.newPegs, bestMove.card, moveDescription);
        }
        return;
      }

      // No valid move, discard (discardAndDraw handles player transition for AI)
      discardAndDraw(aiPlayer);
    }, 800);

    return () => {
      clearTimeout(timer);
      aiProcessingRef.current = false;
    };
  }, [currentPlayer, winner, hands, pegs, deck, discardPiles, stuckCounts, discardAndDraw, animationsEnabled, animateMove]);

  const handleCardClick = (cardIndex) => {
    if (currentPlayer !== 0 || winner !== null) return;
    if (splitRemaining !== 0) return;

    // In discard mode, clicking a card discards it
    if (discardMode) {
      discardAndDraw(0, cardIndex);
      return;
    }

    // Reset joker mode if selecting a different card
    if (jokerMode) {
      setJokerMode(false);
      setJokerSourcePeg(null);
      setSelectedPeg(null);
    }
    setSelectedCard(cardIndex);
  };

  const handlePegClick = (player, pegIndex) => {
    if (currentPlayer !== 0 || winner !== null) return;

    // In joker mode, clicking your own peg cancels the selection
    if (jokerMode && player === 0) {
      setJokerMode(false);
      setJokerSourcePeg(null);
      setSelectedPeg(null);
      setGameMessage('Joker cancelled. Select a card and peg to move.');
      return;
    }

    if (player !== 0) return;

    if (splitRemaining !== 0) {
      // For 9 cards only, check if trying to use the same peg
      const cardInfo = CARD_VALUES[splitCard?.rank];
      if (cardInfo?.mustSplit && pegIndex === splitPegIndex) {
        setGameMessage('Nine card must use two different pegs. Try again.');
        return;
      }
      completeSplit(pegIndex, splitRemaining);
      return;
    }

    if (selectedCard === null) {
      setGameMessage('Select a card first.');
      return;
    }

    setSelectedPeg(pegIndex);
    const card = hands[0][selectedCard];
    const cardInfo = CARD_VALUES[card.rank];

    // Handle Joker - enter selection mode for target
    if (cardInfo.isJoker) {
      setJokerMode(true);
      setJokerSourcePeg(pegIndex);
      setGameMessage('Now click an opponent\'s peg on the track to bump it.');
      return;
    }

    if (cardInfo.canSplit && (pegs[0][pegIndex].location === 'track' || pegs[0][pegIndex].location === 'home')) {
      // For 7, show split options
      setGameMessage('Click Move button to use full 7, or select split amount.');
    } else if (cardInfo.mustSplit && (pegs[0][pegIndex].location === 'track' || pegs[0][pegIndex].location === 'home')) {
      // For 9, show split options (home pegs can only use positive/forward splits)
      setGameMessage('Select split: forward amount for this peg, backward for another peg.');
    } else {
      executeMove(0, pegIndex, card);
    }
  };

  const handleJokerTarget = (targetPlayer, targetPegIndex) => {
    if (!jokerMode || jokerSourcePeg === null || selectedCard === null) return;
    if (targetPlayer === 0) return; // Can't target own pegs

    const targetPeg = pegs[targetPlayer][targetPegIndex];
    if (targetPeg.location !== 'track') return; // Can only bump pegs on track

    const card = hands[0][selectedCard];

    // Execute the joker move
    const newPegs = pegs.map(p => p.map(peg => ({ ...peg })));
    const sourcePeg = newPegs[0][jokerSourcePeg];
    const targetPos = targetPeg.position;

    // Bump opponent's peg back to start
    newPegs[targetPlayer][targetPegIndex] = { location: 'start', index: targetPegIndex };

    // Move our peg to that position
    sourcePeg.location = 'track';
    sourcePeg.position = targetPos;

    // Record last move for Joker
    setLastMoves(prev => {
      const updated = [...prev];
      updated[0] = `Joker bumped ${PLAYER_NAMES[targetPlayer]}`;
      return updated;
    });

    setPegs(newPegs);

    // Remove card from hand and draw new one
    const newHands = hands.map(h => [...h]);
    const cardIndex = newHands[0].findIndex(c => c.id === card.id);
    const discarded = newHands[0].splice(cardIndex, 1)[0];

    // Add to player 0's discard pile
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === 0 ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[0].push(newCard);

    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);

    // Reset stuck count on successful move
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[0] = 0;
    setStuckCounts(newStuckCounts);

    // Reset state
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);

    const w = checkWinner(newPegs);
    if (w !== null) {
      setWinner(w);
      return;
    }

    // Next player
    const nextPlayer = 1; // After player 0, always goes to player 1
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);
  };

  const handleMoveClick = (amount = null) => {
    if (selectedCard === null || selectedPeg === null) return;
    const card = hands[0][selectedCard];
    executeMove(0, selectedPeg, card, amount);
  };

  const BOARD_SIZE = 400;
  const MARGIN = 40;

  const getTrackPosition = (trackIndex) => {
    const side = Math.floor(trackIndex / SPACES_PER_SIDE);
    const pos = trackIndex % SPACES_PER_SIDE;

    // Rotate visual layout so player 0 (Yellow) is at the bottom
    const visualSide = (side + 2) % 4;

    const topY = MARGIN;
    const bottomY = BOARD_SIZE - MARGIN;
    const leftX = MARGIN;
    const rightX = BOARD_SIZE - MARGIN;

    // Each side has 18 spaces, corners don't overlap
    // Space 0 is at the corner, space 17 is one step before next corner
    const sideLength = rightX - leftX;
    const spacing = sideLength / SPACES_PER_SIDE;

    let x, y;
    if (visualSide === 0) { // Top side - left to right
      x = leftX + pos * spacing;
      y = topY;
    } else if (visualSide === 1) { // Right side - top to bottom
      x = rightX;
      y = topY + pos * spacing;
    } else if (visualSide === 2) { // Bottom side - right to left
      x = rightX - pos * spacing;
      y = bottomY;
    } else { // Left side - bottom to top
      x = leftX;
      y = bottomY - pos * spacing;
    }
    return { x, y };
  };

  // Start areas align with position 8 on each side (cross/plus shape)
  const getStartAreaPosition = (player, pegIndex) => {
    const trackPos8 = getTrackPosition(player * SPACES_PER_SIDE + 8);

    // Rotate visual layout so player 0 (Yellow) is at the bottom
    const visualSide = (player + 2) % 4;

    // Offset inward from track, close to the come-out space
    const inwardOffset = 22;
    let baseX, baseY;

    if (visualSide === 0) { // Top side - start goes down
      baseX = trackPos8.x;
      baseY = trackPos8.y + inwardOffset;
    } else if (visualSide === 1) { // Right side - start goes left
      baseX = trackPos8.x - inwardOffset;
      baseY = trackPos8.y;
    } else if (visualSide === 2) { // Bottom side - start goes up
      baseX = trackPos8.x;
      baseY = trackPos8.y - inwardOffset;
    } else { // Left side - start goes right
      baseX = trackPos8.x + inwardOffset;
      baseY = trackPos8.y;
    }

    // Cross pattern: center, up, down, left, right
    const crossOffsets = [
      { x: 0, y: 0 },
      { x: 0, y: -10 },
      { x: 0, y: 10 },
      { x: -10, y: 0 },
      { x: 10, y: 0 }
    ];

    return { x: baseX + crossOffsets[pegIndex].x, y: baseY + crossOffsets[pegIndex].y };
  };

  // Home areas align with position 3 on each side (line of 5 going toward center)
  const getHomePosition = (player, homePos) => {
    const trackPos3 = getTrackPosition(player * SPACES_PER_SIDE + 3);

    // Rotate visual layout so player 0 (Yellow) is at the bottom
    const visualSide = (player + 2) % 4;

    const spacing = 14;

    let x, y;
    if (visualSide === 0) { // Top side - home goes down
      x = trackPos3.x;
      y = trackPos3.y + spacing * (homePos + 1);
    } else if (visualSide === 1) { // Right side - home goes left
      x = trackPos3.x - spacing * (homePos + 1);
      y = trackPos3.y;
    } else if (visualSide === 2) { // Bottom side - home goes up
      x = trackPos3.x;
      y = trackPos3.y - spacing * (homePos + 1);
    } else { // Left side - home goes right
      x = trackPos3.x + spacing * (homePos + 1);
      y = trackPos3.y;
    }

    return { x, y };
  };

  const renderCard = (card, index, isSelected) => {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const discardHighlight = discardMode ? 'ring-2 ring-red-400 hover:ring-red-300' : '';
    return (
      <div
        key={card.id}
        onClick={() => handleCardClick(index)}
        className={`cursor-pointer transition-transform ${isSelected ? 'ring-2 ring-yellow-400 -translate-y-2' : 'hover:-translate-y-1'} ${discardHighlight}`}
        style={{
          width: 50,
          height: 70,
          backgroundColor: discardMode ? '#FEE2E2' : 'white',
          border: '1px solid #ccc',
          borderRadius: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: isRed ? '#DC2626' : '#1F2937',
          fontWeight: 'bold',
          fontSize: card.rank === '10' ? 12 : 14
        }}
      >
        <span>{card.rank}</span>
        <span>{card.suit}</span>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-2 sm:p-4">
      {/* First Player Selection Modal */}
      {showFirstPlayerModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-6 text-center">Choose First Player</h2>

            {!isSpinning ? (
              <div className="space-y-4">
                <button
                  onClick={handleGoFirst}
                  className="w-full px-6 py-4 bg-amber-600 hover:bg-amber-700 rounded-lg text-lg font-semibold transition-colors"
                >
                  I'll Go First
                </button>
                <button
                  onClick={handleRandomFirst}
                  className="w-full px-6 py-4 bg-purple-600 hover:bg-purple-700 rounded-lg text-lg font-semibold transition-colors"
                >
                  Random First Player
                </button>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-xl mb-6">Selecting random player...</p>
                <div className="space-y-3">
                  {PLAYER_NAMES.map((name, idx) => (
                    <div
                      key={idx}
                      className={`px-6 py-3 rounded-lg font-semibold transition-all ${
                        spinningPlayer === idx
                          ? 'bg-white text-gray-900 scale-105 shadow-lg'
                          : 'bg-gray-700 text-gray-400'
                      }`}
                      style={{
                        borderLeft: `4px solid ${PLAYER_COLORS[idx]}`
                      }}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Pegs and Jokers</h1>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setAnimationsEnabled(!animationsEnabled)}
              className={`px-3 py-2 rounded text-sm ${
                animationsEnabled
                  ? 'bg-green-600 hover:bg-green-700'
                  : 'bg-gray-600 hover:bg-gray-700'
              }`}
            >
              {animationsEnabled ? 'Animations On' : 'Animations Off'}
            </button>
            <button
              onClick={initGame}
              className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
            >
              New Game
            </button>
          </div>
        </div>

        {winner !== null && (
          <div className="text-center text-2xl font-bold mb-4 p-4 bg-green-600 rounded">
            {winner === 0 ? 'You Win!' : 'Opponent Wins!'}
          </div>
        )}

        <div className="text-center mb-4 p-2 bg-gray-800 rounded">
          {gameMessage}
        </div>

        <div className="flex flex-col lg:flex-row gap-4 items-center lg:items-start">
          {/* Game Board */}
          <div className="flex-shrink-0 w-full max-w-[400px]">
            <svg viewBox="0 0 400 400" className="w-full h-auto bg-gray-800 rounded">
              {/* Track spaces - all same grey color */}
              {Array.from({ length: TRACK_LENGTH }).map((_, i) => {
                const { x, y } = getTrackPosition(i);
                const isHomeEntrance = i % SPACES_PER_SIDE === 3;
                const playerSection = Math.floor(i / SPACES_PER_SIDE);
                return (
                  <circle
                    key={`track-${i}`}
                    cx={x}
                    cy={y}
                    r={6}
                    fill="#4B5563"
                    stroke={isHomeEntrance ? PLAYER_COLORS[playerSection] : '#374151'}
                    strokeWidth={isHomeEntrance ? 2 : 1}
                  />
                );
              })}

              {/* Start areas - all 4 players, filled with peg color if occupied */}
              {[0, 1, 2, 3].map(player => (
                <g key={`start-${player}`}>
                  {Array.from({ length: 5 }).map((_, i) => {
                    const { x, y } = getStartAreaPosition(player, i);
                    const hasPeg = pegs[player][i]?.location === 'start';
                    const isClickable = currentPlayer === 0 && player === 0 && hasPeg && !jokerMode;
                    const isSelected = player === 0 && (i === selectedPeg || i === jokerSourcePeg) && pegs[player][i]?.location === 'start';
                    return (
                      <circle
                        key={`start-${player}-${i}`}
                        cx={x}
                        cy={y}
                        r={5}
                        fill={hasPeg ? PLAYER_COLORS[player] : '#374151'}
                        stroke={isSelected ? 'white' : PLAYER_COLORS[player]}
                        strokeWidth={isSelected ? 2 : 1.5}
                        style={{ cursor: isClickable ? 'pointer' : 'default' }}
                        onClick={() => isClickable && handlePegClick(player, i)}
                      />
                    );
                  })}
                </g>
              ))}

              {/* Home areas - all 4 players, filled with peg color if occupied */}
              {[0, 1, 2, 3].map(player => (
                <g key={`home-${player}`}>
                  {Array.from({ length: 5 }).map((_, i) => {
                    const { x, y } = getHomePosition(player, i);
                    const hasPeg = pegs[player].some(p => p.location === 'home' && p.homePosition === i);
                    const pegIndex = pegs[player].findIndex(p => p.location === 'home' && p.homePosition === i);
                    const isClickable = currentPlayer === 0 && player === 0 && hasPeg && i < 4 && !jokerMode;
                    const isSelected = player === 0 && pegIndex === selectedPeg && hasPeg;
                    return (
                      <circle
                        key={`home-${player}-${i}`}
                        cx={x}
                        cy={y}
                        r={5}
                        fill={hasPeg ? PLAYER_COLORS[player] : '#374151'}
                        stroke={isSelected ? 'white' : PLAYER_COLORS[player]}
                        strokeWidth={isSelected ? 2 : 1.5}
                        style={{ cursor: isClickable ? 'pointer' : 'default' }}
                        onClick={() => isClickable && handlePegClick(player, pegIndex)}
                      />
                    );
                  })}
                </g>
              ))}

              {/* Pegs on track only (start and home pegs are shown by filling their circles) */}
              {pegs.map((playerPegs, player) =>
                playerPegs.map((peg, pegIndex) => {
                  // Skip pegs in start or home - they're rendered as filled circles
                  if (peg.location === 'start' || peg.location === 'home') return null;

                  let pos;
                  if (peg.location === 'track') {
                    pos = getTrackPosition(peg.position);
                  }

                  if (!pos) return null;

                  // In joker mode, only OPPONENT pegs on track are valid targets (not player 0)
                  const isJokerTarget = jokerMode && player !== 0 && peg.location === 'track';
                  const isJokerSource = jokerMode && player === 0 && pegIndex === jokerSourcePeg;
                  // Player can click their own pegs when not in joker mode, opponent pegs in joker mode,
                  // or their own pegs in joker mode (to cancel)
                  const isClickable = currentPlayer === 0 && (player === 0 || isJokerTarget);
                  const isSelected = player === 0 && (pegIndex === selectedPeg || isJokerSource);

                  return (
                    <circle
                      key={`peg-${player}-${pegIndex}`}
                      cx={pos.x}
                      cy={pos.y}
                      r={7}
                      fill={PLAYER_COLORS[player]}
                      stroke={isSelected ? 'white' : (isJokerTarget ? '#EF4444' : '#1F2937')}
                      strokeWidth={isSelected ? 2 : (isJokerTarget ? 3 : 1)}
                      style={{ cursor: isClickable ? 'pointer' : 'default' }}
                      onClick={() => {
                        if (!isClickable) return;
                        if (isJokerTarget && player !== 0) {
                          handleJokerTarget(player, pegIndex);
                        } else if (player === 0) {
                          if (jokerMode) {
                            // Clicking own peg in joker mode cancels it
                            setJokerMode(false);
                            setJokerSourcePeg(null);
                            setSelectedPeg(null);
                            setGameMessage('Joker cancelled. Select a card and peg to move.');
                          } else {
                            handlePegClick(player, pegIndex);
                          }
                        }
                      }}
                    />
                  );
                })
              )}

              {/* Animating peg - shows peg moving step by step */}
              {animatingPeg && (() => {
                const currentPos = animatingPeg.path[animatingPeg.currentStep];
                if (!currentPos) return null;

                let pos;
                if (currentPos.type === 'track') {
                  pos = getTrackPosition(currentPos.position);
                } else if (currentPos.type === 'home') {
                  pos = getHomePosition(animatingPeg.player, currentPos.position);
                }

                if (!pos) return null;

                return (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={8}
                    fill={PLAYER_COLORS[animatingPeg.player]}
                    stroke="white"
                    strokeWidth={3}
                    style={{ filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.8))' }}
                  />
                );
              })()}

              {/* Draw pile in center */}
              <g>
                <rect x="175" y="185" width="25" height="35" rx="2" fill="#1E3A5F" stroke="#3B82F6" strokeWidth="2" />
                <rect x="177" y="187" width="25" height="35" rx="2" fill="#1E3A5F" stroke="#3B82F6" strokeWidth="1" />
                <rect x="179" y="189" width="25" height="35" rx="2" fill="#1E3A5F" stroke="#3B82F6" strokeWidth="1" />
                <text x="191" y="212" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">{deck.length}</text>
              </g>

              {/* Per-player discard piles with stuck counters */}
              {[0, 1, 2, 3].map(player => {
                // Position discard piles in corners around center draw pile (rotated so Yellow is at bottom)
                const positions = [
                  { x: 220, y: 240 },  // Yellow - bottom-right of center
                  { x: 130, y: 240 },  // Blue - bottom-left of center
                  { x: 130, y: 140 },  // Pink - top-left of center
                  { x: 220, y: 140 }   // Green - top-right of center
                ];
                const pos = positions[player];
                const lastCard = discardPiles[player]?.[discardPiles[player].length - 1];
                const stuckCount = stuckCounts[player];

                return (
                  <g key={`discard-${player}`}>
                    {/* Player's last played card (face up) */}
                    {lastCard ? (
                      <g>
                        <rect x={pos.x} y={pos.y} width="22" height="30" rx="2" fill="white" stroke={PLAYER_COLORS[player]} strokeWidth="1.5" />
                        <text
                          x={pos.x + 11}
                          y={pos.y + 14}
                          textAnchor="middle"
                          fill={lastCard.suit === '♥' || lastCard.suit === '♦' ? '#DC2626' : '#1F2937'}
                          fontSize="8"
                          fontWeight="bold"
                        >
                          {lastCard.rank}
                        </text>
                        <text
                          x={pos.x + 11}
                          y={pos.y + 25}
                          textAnchor="middle"
                          fill={lastCard.suit === '♥' || lastCard.suit === '♦' ? '#DC2626' : '#1F2937'}
                          fontSize="9"
                        >
                          {lastCard.suit}
                        </text>
                      </g>
                    ) : (
                      <rect x={pos.x} y={pos.y} width="22" height="30" rx="2" fill="none" stroke={PLAYER_COLORS[player]} strokeWidth="1" strokeDasharray="3" opacity="0.5" />
                    )}

                    {/* Stuck counter (face down cards) - shows when player has discarded while stuck */}
                    {stuckCount > 0 && (
                      <g>
                        <rect x={pos.x + 26} y={pos.y} width="22" height="30" rx="2" fill="#7C3AED" stroke="#A78BFA" strokeWidth="2" />
                        <text
                          x={pos.x + 37}
                          y={pos.y + 20}
                          textAnchor="middle"
                          fill="white"
                          fontSize="14"
                          fontWeight="bold"
                        >
                          {stuckCount}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Labels with last move - rotated so Yellow (player 0) is at bottom */}
              <g>
                <text x="200" y="20" textAnchor="middle" fill={PLAYER_COLORS[2]} fontSize="11" fontWeight="bold">Pink (AI)</text>
                {lastMoves[2] && <text x="200" y="31" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[2]}</text>}
              </g>
              <g transform="rotate(90 378 205)">
                <text x="378" y="200" textAnchor="middle" fill={PLAYER_COLORS[3]} fontSize="11" fontWeight="bold">Green (AI)</text>
                {lastMoves[3] && <text x="378" y="211" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[3]}</text>}
              </g>
              <g>
                <text x="200" y="383" textAnchor="middle" fill={PLAYER_COLORS[0]} fontSize="11" fontWeight="bold">You (Yellow)</text>
                {lastMoves[0] && <text x="200" y="394" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[0]}</text>}
              </g>
              <g transform="rotate(-90 22 205)">
                <text x="22" y="200" textAnchor="middle" fill={PLAYER_COLORS[1]} fontSize="11" fontWeight="bold">Blue (AI)</text>
                {lastMoves[1] && <text x="22" y="211" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[1]}</text>}
              </g>
            </svg>
          </div>

          {/* Hand and Controls */}
          <div className="flex-1 w-full lg:w-auto">
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">Your Hand:</h3>
              <div className="flex gap-2 flex-wrap">
                {hands[0].map((card, i) => renderCard(card, i, i === selectedCard))}
              </div>
            </div>

            {selectedCard !== null && selectedPeg !== null && !jokerMode && (
              <div className="mb-4">
                <h3 className="text-lg font-semibold mb-2">Actions:</h3>
                <div className="flex gap-2 flex-wrap">
                  {/* Don't show Move button for 9 cards - they MUST split */}
                  {hands[0][selectedCard]?.rank !== '9' && (
                    <button
                      onClick={() => handleMoveClick()}
                      className="px-3 py-1 bg-green-600 rounded hover:bg-green-700"
                    >
                      Move
                    </button>
                  )}
                  {hands[0][selectedCard]?.rank === '7' && (pegs[0][selectedPeg]?.location === 'track' || pegs[0][selectedPeg]?.location === 'home') && (
                    <>
                      {[1, 2, 3, 4, 5, 6].map(n => (
                        <button
                          key={n}
                          onClick={() => handleMoveClick(n)}
                          className="px-3 py-1 bg-purple-600 rounded hover:bg-purple-700"
                        >
                          Split {n}/{7-n}
                        </button>
                      ))}
                    </>
                  )}
                  {/* Show 9 split options (only valid splits will be accepted) */}
                  {hands[0][selectedCard]?.rank === '9' && (pegs[0][selectedPeg]?.location === 'track' || pegs[0][selectedPeg]?.location === 'home') && (
                    <>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                        <button
                          key={n}
                          onClick={() => handleMoveClick(n)}
                          className="px-3 py-1 bg-purple-600 rounded hover:bg-purple-700"
                        >
                          +{n}/-{9-n}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}

            {jokerMode && (
              <div className="mb-4 p-3 bg-red-900 rounded">
                <p className="mb-2">Joker Mode: Click an opponent's peg on the track to bump it.</p>
                <button
                  onClick={() => {
                    setJokerMode(false);
                    setJokerSourcePeg(null);
                    setSelectedPeg(null);
                    setGameMessage('Joker cancelled. Select a card and peg to move.');
                  }}
                  className="px-3 py-1 bg-gray-600 rounded hover:bg-gray-700"
                >
                  Cancel Joker
                </button>
              </div>
            )}

            {discardMode && (
              <div className="mb-4 p-3 bg-yellow-900 rounded">
                <p className="mb-2 font-bold">Select a card to discard:</p>
                <p className="text-sm mb-2">Click on any card in your hand to discard it and draw a new card.</p>
                <button
                  onClick={() => {
                    setDiscardMode(false);
                    setGameMessage('Your turn! Select a card and peg to move.');
                  }}
                  className="px-3 py-1 bg-gray-600 rounded hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            )}

            {currentPlayer === 0 && !jokerMode && !splitRemaining && !discardMode && hands[0]?.length > 0 && (
              <div className="mb-4">
                {!hasAnyValidMove(0, hands[0], pegs) ? (
                  <div>
                    <button
                      onClick={() => {
                        setDiscardMode(true);
                        setSelectedCard(null);
                        setSelectedPeg(null);
                        setGameMessage('Select a card to discard.');
                      }}
                      className="px-4 py-2 bg-red-600 rounded hover:bg-red-700 font-bold"
                    >
                      No Valid Move - Select Card to Discard {stuckCounts[0] > 0 && `(${stuckCounts[0]}/3)`}
                    </button>
                    {stuckCounts[0] === 2 && (
                      <p className="text-yellow-400 text-sm mt-1">Next stuck discard will let you start a peg!</p>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setDiscardMode(true);
                      setSelectedCard(null);
                      setSelectedPeg(null);
                      setGameMessage('Select a card to discard.');
                    }}
                    className="px-4 py-2 bg-gray-600 rounded hover:bg-gray-700 text-sm"
                  >
                    Discard & Pass (if stuck)
                  </button>
                )}
              </div>
            )}

            <div className="mt-4 p-3 bg-gray-800 rounded text-sm">
              <h4 className="font-semibold mb-2">Quick Rules:</h4>
              <ul className="space-y-1 text-gray-300">
                <li>• A, J, Q, K: Move from START or move that many spaces</li>
                <li>• 2-6, 10: Move face value</li>
                <li>• 7: Move one peg 7 spaces OR split between two pegs (both forward)</li>
                <li>• 8: Move backward 8 spaces</li>
                <li>• 9: Split between two pegs (one forward, one backward)</li>
                <li>• Joker: Bump any opponent peg</li>
                <li>• Cannot jump or land on your own pegs</li>
                <li>• <span className="text-yellow-400">Stuck 3 turns in a row = auto-start a peg!</span></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
