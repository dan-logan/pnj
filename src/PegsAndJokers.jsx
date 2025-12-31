import React, { useState, useEffect, useCallback, useRef } from 'react';

const CARD_VALUES = {
  'A': { value: 1, canStart: true },
  '2': { value: 2, canStart: false },
  '3': { value: 3, canStart: false },
  '4': { value: 4, canStart: false },
  '5': { value: 5, canStart: false },
  '6': { value: 6, canStart: false },
  '7': { value: 7, canStart: false, canSplit: true },
  '8': { value: -8, canStart: false, backward: true },
  '9': { value: 9, canStart: false, mustSplit: true },
  '10': { value: 10, canStart: false },
  'J': { value: 11, canStart: true },
  'Q': { value: 12, canStart: true },
  'K': { value: 13, canStart: true },
  'JOKER': { value: 0, canStart: false, isJoker: true }
};

const SUITS = ['♠', '♥', '♦', '♣'];
const TRACK_LENGTH = 72; // 18 spaces per side * 4 sides
const PLAYER_COLORS = ['#F59E0B', '#3B82F6', '#EC4899', '#10B981'];
const PLAYER_NAMES = ['Yellow', 'Blue', 'Pink', 'Green'];

function createDeck() {
  const deck = [];
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (const rank of Object.keys(CARD_VALUES)) {
        if (rank !== 'JOKER') {
          deck.push({ rank, suit, id: `${rank}${suit}${d}` });
        }
      }
    }
    deck.push({ rank: 'JOKER', suit: '🃏', id: `JOKER1_${d}` });
    deck.push({ rank: 'JOKER', suit: '🃏', id: `JOKER2_${d}` });
  }
  return shuffle(deck);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getStartPosition(player) {
  return player * 18 + 8;  // Position 8 on each player's side, adjacent to start area
}

function getHomeEntrance(player) {
  return player * 18 + 3;  // Position 3 on each player's side, where home area connects
}

// Calculate how far a peg is from being fully home (lower = closer to winning)
function getDistanceToHome(peg, player) {
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
function describeMoveAction(peg, newPeg, card, amount, bumpedPlayer = null) {
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

export default function PegsAndJokers() {
  const [deck, setDeck] = useState([]);
  const [discardPiles, setDiscardPiles] = useState([[], [], [], []]); // Per-player discard piles
  const [stuckCounts, setStuckCounts] = useState([0, 0, 0, 0]); // Track stuck discards per player
  const [hands, setHands] = useState([[], [], [], []]);
  const [pegs, setPegs] = useState([
    Array(5).fill(null).map((_, i) => ({ location: 'start', index: i })),
    Array(5).fill(null).map((_, i) => ({ location: 'start', index: i })),
    Array(5).fill(null).map((_, i) => ({ location: 'start', index: i })),
    Array(5).fill(null).map((_, i) => ({ location: 'start', index: i }))
  ]);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [selectedCard, setSelectedCard] = useState(null);
  const [selectedPeg, setSelectedPeg] = useState(null);
  const [splitRemaining, setSplitRemaining] = useState(0);
  const [splitCard, setSplitCard] = useState(null);
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

  const initGame = useCallback(() => {
    const newDeck = createDeck();
    const hand1 = newDeck.splice(0, 6);
    const hand2 = newDeck.splice(0, 6);
    const hand3 = newDeck.splice(0, 6);
    const hand4 = newDeck.splice(0, 6);
    setDeck(newDeck);
    setDiscardPiles([[], [], [], []]);
    setStuckCounts([0, 0, 0, 0]);
    setHands([hand1, hand2, hand3, hand4]);
    setPegs([
      Array(5).fill(null).map((_, i) => ({ location: 'start', index: i })),
      Array(5).fill(null).map((_, i) => ({ location: 'start', index: i })),
      Array(5).fill(null).map((_, i) => ({ location: 'start', index: i })),
      Array(5).fill(null).map((_, i) => ({ location: 'start', index: i }))
    ]);
    setCurrentPlayer(0);
    setSelectedCard(null);
    setSelectedPeg(null);
    setSplitRemaining(0);
    setSplitCard(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);
    setGameMessage('Your turn! Select a card and peg to move.');
    setWinner(null);
    setMoveHistory([]);
    setLastMoves([null, null, null, null]);
    aiProcessingRef.current = false;
    setAnimatingPeg(null);
    if (animationRef.current) {
      clearInterval(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  useEffect(() => {
    initGame();
  }, [initGame]);

  const drawCard = useCallback((currentDeck, allDiscardPiles) => {
    if (currentDeck.length === 0) {
      // Combine all discard piles for reshuffling
      const allDiscards = allDiscardPiles.flat();
      if (allDiscards.length === 0) {
        return { card: null, newDeck: [], newDiscardPiles: [[], [], [], []] };
      }
      const reshuffled = shuffle([...allDiscards]);
      return { card: reshuffled.pop(), newDeck: reshuffled, newDiscardPiles: [[], [], [], []] };
    }
    const newDeck = [...currentDeck];
    return { card: newDeck.pop(), newDeck, newDiscardPiles: allDiscardPiles };
  }, []);

  const findPegAtPosition = useCallback((position, playerPegs) => {
    for (let p = 0; p < 4; p++) {
      for (let i = 0; i < 5; i++) {
        const peg = playerPegs[p][i];
        if (peg.location === 'track' && peg.position === position) {
          return { player: p, pegIndex: i };
        }
      }
    }
    return null;
  }, []);

  const isValidMove = useCallback((player, pegIndex, card, currentPegs, moveAmount = null) => {
    const peg = currentPegs[player][pegIndex];
    const cardInfo = CARD_VALUES[card.rank];
    
    // Handle pegs already in home - can only move forward within home
    if (peg.location === 'home') {
      // Can't use Joker or backward cards in home
      if (cardInfo.isJoker || cardInfo.backward) return false;

      // Can't use 9 card (mustSplit) in home - needs both forward AND backward, but home only allows forward
      if (cardInfo.mustSplit) {
        return false;
      }

      const amount = moveAmount !== null ? moveAmount : cardInfo.value;
      if (amount <= 0) return false; // Can only move forward in home
      
      const newHomePos = peg.homePosition + amount;
      // Must land exactly on a valid home position (0-4)
      if (newHomePos > 4) return false;
      
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
        for (let p = 0; p < 4; p++) {
          if (p === player) continue;
          for (let i = 0; i < 5; i++) {
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
      for (let p = 0; p < 4; p++) {
        if (p === player) continue; // Can't bump own pegs
        for (let i = 0; i < 5; i++) {
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
        if (homeSteps >= 0 && homeSteps < 5) {
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
  }, [findPegAtPosition]);

  const hasAnyValidMove = useCallback((player, hand, currentPegs) => {
    for (const card of hand) {
      const cardInfo = CARD_VALUES[card.rank];
      
      for (let pegIndex = 0; pegIndex < 5; pegIndex++) {
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
  }, [isValidMove]);

  const executeMoveInternal = useCallback((player, pegIndex, card, amount, currentPegs) => {
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
      for (let p = 0; p < 4; p++) {
        if (p === player) continue;
        for (let i = 0; i < 5; i++) {
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
        
        if (homeSteps >= 0 && homeSteps < 5) {
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
  }, [findPegAtPosition]);

  const checkWinner = useCallback((currentPegs) => {
    for (let p = 0; p < 4; p++) {
      if (currentPegs[p].every(peg => peg.location === 'home')) {
        return p;
      }
    }
    return null;
  }, []);

  // Calculate the path of positions a peg travels during a move
  const calculateMovePath = useCallback((player, pegIndex, card, amount, currentPegs) => {
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
        if (homeSteps >= 0 && homeSteps < 5) {
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
  }, []);

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
  }, [calculateMovePath]);

  const executeMove = useCallback((player, pegIndex, card, splitAmount = null) => {
    if (!isValidMove(player, pegIndex, card, pegs, splitAmount)) {
      setGameMessage('Invalid move. Try again.');
      return false;
    }

    const oldPeg = pegs[player][pegIndex];
    const { newPegs } = executeMoveInternal(player, pegIndex, card, splitAmount, pegs);
    const newPeg = newPegs[player][pegIndex];

    // Record last move description
    const moveDescription = describeMoveAction(oldPeg, newPeg, card, splitAmount);
    setLastMoves(prev => {
      const updated = [...prev];
      updated[player] = moveDescription;
      return updated;
    });

    setPegs(newPegs);
    
    const cardInfo = CARD_VALUES[card.rank];
    
    // Handle 7 card splitting
    if (cardInfo.canSplit && splitAmount !== null && splitAmount < 7) {
      const remaining = 7 - splitAmount;
      setSplitRemaining(remaining);
      setSplitCard(card);
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
    
    // Switch to next player
    const nextPlayer = (player + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);
    
    return true;
  }, [isValidMove, pegs, executeMoveInternal, checkWinner, hands, deck, discardPiles, stuckCounts, drawCard]);

  const completeSplit = useCallback((pegIndex, amount) => {
    if (!isValidMove(currentPlayer, pegIndex, splitCard, pegs, amount)) {
      setGameMessage('Invalid move for split. Try again.');
      return false;
    }

    const oldPeg = pegs[currentPlayer][pegIndex];
    const { newPegs } = executeMoveInternal(currentPlayer, pegIndex, splitCard, amount, pegs);
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
    const nextPlayer = (currentPlayer + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);
    
    return true;
  }, [currentPlayer, splitCard, pegs, isValidMove, executeMoveInternal, checkWinner, hands, deck, discardPiles, stuckCounts, drawCard]);

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
          newPegs = pegs.map((playerPegs, i) => playerPegs.map(peg => ({ ...peg })));

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
  }, [hands, deck, discardPiles, stuckCounts, pegs, drawCard, findPegAtPosition]);

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
      
      // Calculate total distance for all pegs (lower is better)
      const getTotalDistance = (pegState) => {
        return pegState[aiPlayer].reduce((sum, peg) => sum + getDistanceToHome(peg, aiPlayer), 0);
      };
      
      // Calculate vulnerability penalty for a position (landing on opponent's come-out spot is risky)
      const getVulnerabilityPenalty = (position, pegState) => {
        let penalty = 0;
        for (let p = 0; p < 4; p++) {
          if (p === aiPlayer) continue;
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
      };
      
      // Find all possible moves and score them
      const possibleMoves = [];
      
      for (const card of aiHand) {
        const cardInfo = CARD_VALUES[card.rank];
        
        // Try each peg
        for (let pegIndex = 0; pegIndex < 5; pegIndex++) {
          const peg = pegs[aiPlayer][pegIndex];
          
          // Skip pegs in final home position
          if (peg.location === 'home' && peg.homePosition === 4) continue;
          
          // For non-split cards
          if (!cardInfo.canSplit && !cardInfo.mustSplit && !cardInfo.isJoker) {
            if (isValidMove(aiPlayer, pegIndex, card, pegs)) {
              const { newPegs } = executeMoveInternal(aiPlayer, pegIndex, card, null, pegs);
              const currentDist = getTotalDistance(pegs);
              const newDist = getTotalDistance(newPegs);
              const improvement = currentDist - newDist;
              
              // Calculate vulnerability penalty for landing position
              const movedPeg = newPegs[aiPlayer][pegIndex];
              const vulnPenalty = movedPeg.location === 'track' 
                ? getVulnerabilityPenalty(movedPeg.position, newPegs) 
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
            if (isValidMove(aiPlayer, pegIndex, card, pegs, 7)) {
              const { newPegs } = executeMoveInternal(aiPlayer, pegIndex, card, 7, pegs);
              const improvement = getTotalDistance(pegs) - getTotalDistance(newPegs);
              const movedPeg = newPegs[aiPlayer][pegIndex];
              const vulnPenalty = movedPeg.location === 'track' 
                ? getVulnerabilityPenalty(movedPeg.position, newPegs) 
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
              if (isValidMove(aiPlayer, pegIndex, card, pegs, split)) {
                const { newPegs: afterFirst } = executeMoveInternal(aiPlayer, pegIndex, card, split, pegs);
                const remaining = 7 - split;
                
                // Find another peg for the remaining
                for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
                  if (secondPeg === pegIndex) continue;
                  if (isValidMove(aiPlayer, secondPeg, card, afterFirst, remaining)) {
                    const { newPegs: finalPegs } = executeMoveInternal(aiPlayer, secondPeg, card, remaining, afterFirst);
                    const improvement = getTotalDistance(pegs) - getTotalDistance(finalPegs);
                    
                    // Calculate vulnerability for both moved pegs
                    const peg1 = finalPegs[aiPlayer][pegIndex];
                    const peg2 = finalPegs[aiPlayer][secondPeg];
                    const vuln1 = peg1.location === 'track' ? getVulnerabilityPenalty(peg1.position, finalPegs) : 0;
                    const vuln2 = peg2.location === 'track' ? getVulnerabilityPenalty(peg2.position, finalPegs) : 0;
                    
                    possibleMoves.push({
                      type: 'split7',
                      card,
                      pegIndex,
                      amount: split,
                      secondPeg,
                      remaining,
                      newPegs: finalPegs,
                      improvement,
                      bonus: (pegs[aiPlayer][pegIndex].location === 'home' ? 10 : 0) + 
                             (afterFirst[aiPlayer][secondPeg].location === 'home' ? 10 : 0) -
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
              if (isValidMove(aiPlayer, pegIndex, card, pegs, forward)) {
                const { newPegs: afterFirst } = executeMoveInternal(aiPlayer, pegIndex, card, forward, pegs);
                
                // Find another peg for backward
                for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
                  if (secondPeg === pegIndex) continue;
                  if (isValidMove(aiPlayer, secondPeg, card, afterFirst, backward)) {
                    const { newPegs: finalPegs } = executeMoveInternal(aiPlayer, secondPeg, card, backward, afterFirst);
                    const improvement = getTotalDistance(pegs) - getTotalDistance(finalPegs);
                    
                    // Calculate vulnerability for both moved pegs
                    const peg1 = finalPegs[aiPlayer][pegIndex];
                    const peg2 = finalPegs[aiPlayer][secondPeg];
                    const vuln1 = peg1.location === 'track' ? getVulnerabilityPenalty(peg1.position, finalPegs) : 0;
                    const vuln2 = peg2.location === 'track' ? getVulnerabilityPenalty(peg2.position, finalPegs) : 0;
                    
                    possibleMoves.push({
                      type: 'split9',
                      card,
                      pegIndex,
                      amount: forward,
                      secondPeg,
                      remaining: backward,
                      newPegs: finalPegs,
                      improvement,
                      bonus: (pegs[aiPlayer][pegIndex].location === 'home' ? 10 : 0) - vuln1 - vuln2
                    });
                  }
                }
              }
            }
          }
          
          // For starting cards (A, J, Q, K) - try to get pegs out of start
          if (cardInfo.canStart && peg.location === 'start') {
            if (isValidMove(aiPlayer, pegIndex, card, pegs)) {
              const { newPegs } = executeMoveInternal(aiPlayer, pegIndex, card, null, pegs);
              const improvement = getTotalDistance(pegs) - getTotalDistance(newPegs);
              const startPos = getStartPosition(aiPlayer);
              const vulnPenalty = getVulnerabilityPenalty(startPos, newPegs);
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
            for (let oppPlayer = 0; oppPlayer < 4; oppPlayer++) {
              if (oppPlayer === aiPlayer) continue;
              for (let oppPeg = 0; oppPeg < 5; oppPeg++) {
                const opponentPeg = pegs[oppPlayer][oppPeg];
                if (opponentPeg.location === 'track') {
                  const targetPosition = opponentPeg.position;
                  const newPegs = pegs.map(p => p.map(pg => ({ ...pg })));
                  // Bump opponent
                  newPegs[oppPlayer][oppPeg] = { location: 'start', index: oppPeg };
                  // Move our peg there
                  newPegs[aiPlayer][pegIndex].location = 'track';
                  newPegs[aiPlayer][pegIndex].position = targetPosition;
                  
                  const improvement = getTotalDistance(pegs) - getTotalDistance(newPegs);
                  
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
                  const vulnPenalty = getVulnerabilityPenalty(targetPosition, newPegs);
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
      
      // Sort moves by improvement + bonus (higher is better)
      possibleMoves.sort((a, b) => (b.improvement + b.bonus) - (a.improvement + a.bonus));

      // Execute the best move
      if (possibleMoves.length > 0) {
        const bestMove = possibleMoves[0];

        // Generate move description based on move type
        const getMoveDescription = () => {
          const oldPeg = pegs[aiPlayer][bestMove.pegIndex];
          const newPeg = bestMove.newPegs[aiPlayer][bestMove.pegIndex];

          if (bestMove.type === 'simple' || bestMove.type === 'start') {
            return describeMoveAction(oldPeg, newPeg, bestMove.card, bestMove.amount);
          } else if (bestMove.type === 'split7' || bestMove.type === 'split9') {
            const afterFirst = executeMoveInternal(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs).newPegs;
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
            const afterFirstPegs = executeMoveInternal(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs).newPegs;
            animateMove(aiPlayer, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription);
            });
          });
        } else if (bestMove.type === 'split9') {
          // Two-part animation for 9 split
          animateMove(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg
            const afterFirstPegs = executeMoveInternal(aiPlayer, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs).newPegs;
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
  }, [currentPlayer, winner, hands, pegs, deck, discardPiles, stuckCounts, isValidMove, executeMoveInternal, drawCard, checkWinner, discardAndDraw, animationsEnabled, animateMove]);

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
    } else if (cardInfo.mustSplit && pegs[0][pegIndex].location === 'track') {
      // For 9, show split options (only for pegs on track, not in home)
      setGameMessage('Select split: forward amount for this peg, backward for another peg.');
    } else if (cardInfo.mustSplit && pegs[0][pegIndex].location === 'home') {
      // Can't use 9 card with pegs in home
      setGameMessage('Cannot use 9 card with pegs in home (need forward AND backward moves).');
      setSelectedPeg(null);
      return;
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
  const SPACES_PER_SIDE = 18;

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
                  {/* Only show 9 split options for pegs on track, not in home */}
                  {hands[0][selectedCard]?.rank === '9' && pegs[0][selectedPeg]?.location === 'track' && (
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
                <li>• 7: Split between two pegs (forward only)</li>
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
