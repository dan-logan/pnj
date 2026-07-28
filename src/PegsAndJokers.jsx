import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  CARD_VALUES,
  TRACK_LENGTH,
  SPACES_PER_SIDE,
  PLAYER_COLORS,
  PLAYER_NAMES,
  GAME_MODES,
  getPartner,
  sameTeam
} from './game/constants.js';
import { createDeck, drawCard } from './game/deck.js';
import {
  createInitialPegs,
  getHomeEntrance,
  describeMoveAction,
  isValidMove,
  applyMove,
  applyComeOut,
  applyJoker,
  checkWinner,
  calculateMovePath,
  getValidDestinations,
  getMovablePegs,
  findBumps,
  findFriendlyBumps
} from './game/engine.js';
import { findBestAIMove } from './game/ai.js';
import {
  loadStats,
  saveStats,
  resetStats,
  recordGame,
  winRate,
  averageTurns,
  bucketWinRate,
  formatStreak,
  getNemesis
} from './game/stats.js';
import { loadGame, saveGame, clearGame } from './game/persistence.js';
import InstallPrompt from './InstallPrompt.jsx';
import { sfx, isMuted, setMuted, unlockAudio } from './audio.js';

// Instant-replay pacing. Deliberately slower than the 150ms live step so a
// round of AI moves is easy to follow when it's played back.
const REPLAY_SEG_MS = 280;      // per-step while a peg animates during replay
const REPLAY_LEADIN_MS = 320;   // beat on the "before" board so the start registers
const REPLAY_FRAME_PAUSE_MS = 600; // pause after each move before the next one

export default function PegsAndJokers() {
  const [gameMode, setGameMode] = useState(GAME_MODES.CLASSIC);
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
  // Snapshot of the board taken right before the first half of a split is played,
  // so the player can undo a mis-tapped split and start their turn over. Held
  // only while a split is half-finished; cleared once the second peg commits it.
  const [splitUndo, setSplitUndo] = useState(null); // { pegs, lastMoves } | null
  const [jokerMode, setJokerMode] = useState(false); // true when waiting for target selection
  const [jokerSourcePeg, setJokerSourcePeg] = useState(null); // which of player's pegs to move
  const [discardMode, setDiscardMode] = useState(false); // true when player is selecting a card to discard
  const [gameMessage, setGameMessage] = useState('Your turn! Select a card and peg to move.');
  const [winner, setWinner] = useState(null);
  const [moveHistory, setMoveHistory] = useState([]);
  const [lastMoves, setLastMoves] = useState([null, null, null, null]); // Last move description per player
  const aiProcessingRef = useRef(false); // Prevent AI from running twice on same turn
  const prevPlayerRef = useRef(null); // Detect the turn passing back to the human

  // Animation state
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [animatingPeg, setAnimatingPeg] = useState(null); // { player, pegIndex, positions: [], currentStep: 0 }
  const animationRef = useRef(null);

  // Sound / haptics
  const [soundOn, setSoundOn] = useState(() => !isMuted());

  // Player statistics (persisted to localStorage)
  const [stats, setStats] = useState(() => loadStats());
  const [showStats, setShowStats] = useState(false);

  // Per-game tallies, folded into stats when the game ends. Refs so updating
  // them mid-turn never triggers a re-render.
  const turnsRef = useRef(0); // completed player turns (transitions)
  const prevTurnPlayerRef = useRef(null);
  const jokersThisGameRef = useRef(0);
  const bumpsDeliveredThisGameRef = useRef(0);
  const timesBumpedThisGameRef = useRef(0);
  const startModeRef = useRef('chosen'); // 'chosen' | 'random'
  const gameRecordedRef = useRef(false); // guard against double-recording a win

  // Bump fly-back animation: { player, pegIndex, from: {x,y}, to: {x,y}, progress: 0-1 }
  const [bumpFx, setBumpFx] = useState(null);
  const bumpFxRef = useRef(null);

  // Instant replay: a buffer of the AI moves made since your last turn, plus the
  // playback state. Frames live in a ref (they hold peg snapshots and don't need
  // to trigger renders); `replayReady` mirrors the count so the button can show.
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayInfo, setReplayInfo] = useState(null); // { player, description, index, total }
  const [replayReady, setReplayReady] = useState(0);
  const replayLogRef = useRef([]);        // recorded frames for the current round
  const replayCancelRef = useRef(false);  // set to abort an in-flight replay
  const replaySegTimerRef = useRef(null); // per-step interval
  const replayFrameTimerRef = useRef(null); // between-frame / lead-in timeout
  const replayRestoreRef = useRef(null);  // true current board, restored when replay ends
  const replayPrevPlayerRef = useRef(0);  // detect the human handing off to start a fresh round

  // Append an AI move to the replay buffer. Peg snapshots are immutable (the
  // engine never mutates), so storing references is safe.
  const recordReplayFrame = useCallback((frame) => {
    replayLogRef.current = [...replayLogRef.current, frame];
    setReplayReady(replayLogRef.current.length);
  }, []);

  // Tear down any in-flight replay and empty the buffer (used on new game / load).
  const resetReplay = useCallback(() => {
    replayCancelRef.current = true;
    if (replaySegTimerRef.current) { clearInterval(replaySegTimerRef.current); replaySegTimerRef.current = null; }
    if (replayFrameTimerRef.current) { clearTimeout(replayFrameTimerRef.current); replayFrameTimerRef.current = null; }
    replayRestoreRef.current = null;
    replayLogRef.current = [];
    setReplayReady(0);
    setReplayInfo(null);
    setIsReplaying(false);
  }, []);

  // First player selection state
  const [showFirstPlayerModal, setShowFirstPlayerModal] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinningPlayer, setSpinningPlayer] = useState(0);
  const spinIntervalRef = useRef(null);

  // Save/resume state. `pendingResume` holds a saved game found on load until
  // the player chooses to resume it or start fresh.
  const [pendingResume, setPendingResume] = useState(null);
  const [showResumeModal, setShowResumeModal] = useState(false);

  // In partner mode, once your own pegs are all home you play your hand on your
  // partner's pegs; otherwise you always control your own (player 0). This is the
  // "owner" of the pegs the human moves this turn.
  const controlledOwnerFor = useCallback((pegState) => (
    gameMode === GAME_MODES.PARTNERS && pegState[0].every(p => p.location === 'home')
      ? getPartner(0)
      : 0
  ), [gameMode]);

  // Options threaded into the engine so it applies the partner friendly-bump rule
  // (the human always acts as player 0).
  const moveOptions = useMemo(() => ({ actor: 0, mode: gameMode }), [gameMode]);

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
    setSplitUndo(null);
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
    setBumpFx(null);
    if (bumpFxRef.current) {
      clearInterval(bumpFxRef.current);
      bumpFxRef.current = null;
    }
    resetReplay();
    replayPrevPlayerRef.current = firstPlayer;
    // Reset per-game stat tallies for the new game
    turnsRef.current = 0;
    prevTurnPlayerRef.current = null;
    jokersThisGameRef.current = 0;
    bumpsDeliveredThisGameRef.current = 0;
    timesBumpedThisGameRef.current = 0;
    gameRecordedRef.current = false;
    setShowFirstPlayerModal(false);
  }, [resetReplay]);

  const handleGoFirst = useCallback(() => {
    unlockAudio();
    startModeRef.current = 'chosen';
    startGameWithPlayer(0);
  }, [startGameWithPlayer]);

  const handleRandomFirst = useCallback(() => {
    unlockAudio();
    startModeRef.current = 'random';
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
    setBumpFx(null);
    if (bumpFxRef.current) {
      clearInterval(bumpFxRef.current);
      bumpFxRef.current = null;
    }
    setIsSpinning(false);
    setSpinningPlayer(0);
    setWinner(null);
    aiProcessingRef.current = false;
    resetReplay();

    // Show the modal to choose first player
    setShowFirstPlayerModal(true);
  }, [resetReplay]);

  // Restore an in-progress game from a saved snapshot. Resets transient UI
  // state (selections, joker/discard modes) since those aren't persisted.
  const applySavedGame = useCallback((saved) => {
    setGameMode(saved.mode === GAME_MODES.PARTNERS ? GAME_MODES.PARTNERS : GAME_MODES.CLASSIC);
    setDeck(saved.deck);
    setDiscardPiles(saved.discardPiles);
    setStuckCounts(saved.stuckCounts);
    setHands(saved.hands);
    setPegs(saved.pegs);
    setCurrentPlayer(saved.currentPlayer);
    setWinner(null);
    setSplitRemaining(saved.splitRemaining ?? 0);
    setSplitCard(saved.splitCard ?? null);
    setSplitPegIndex(saved.splitPegIndex ?? null);
    setSplitUndo(null); // no undo snapshot survives a save/resume
    setLastMoves(saved.lastMoves ?? [null, null, null, null]);
    setMoveHistory(saved.moveHistory ?? []);

    // Clear transient selection/interaction state.
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);
    setAnimatingPeg(null);
    setBumpFx(null);

    // Restore per-game stat tallies so a resumed game still records correctly.
    const t = saved.tallies || {};
    turnsRef.current = t.turns ?? 0;
    jokersThisGameRef.current = t.jokersPlayed ?? 0;
    bumpsDeliveredThisGameRef.current = t.bumpsDelivered ?? 0;
    timesBumpedThisGameRef.current = t.timesBumped ?? 0;
    startModeRef.current = t.startMode ?? 'chosen';
    gameRecordedRef.current = false;

    // Seed the turn/return trackers to the restored player so resuming doesn't
    // count a spurious turn or fire a "your turn" chime.
    prevTurnPlayerRef.current = saved.currentPlayer;
    prevPlayerRef.current = saved.currentPlayer;
    aiProcessingRef.current = false;

    // No replay is available for a freshly resumed game until a new AI round runs.
    resetReplay();
    replayPrevPlayerRef.current = saved.currentPlayer;

    setGameMessage(
      saved.currentPlayer === 0
        ? 'Welcome back! Your turn — select a card and peg to move.'
        : `${PLAYER_NAMES[saved.currentPlayer]} is thinking...`
    );

    setPendingResume(null);
    setShowResumeModal(false);
    setShowFirstPlayerModal(false);
  }, [resetReplay]);

  // On mount, offer to resume a saved game if one exists; otherwise start fresh.
  useEffect(() => {
    const saved = loadGame();
    if (saved) {
      setPendingResume(saved);
      setShowResumeModal(true);
    } else {
      initGame();
    }
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

  // Compare peg states around a move: if someone got bumped, play the bump
  // sound/haptic and fly the bumped peg back to its start slot.
  const runBumpFx = useCallback((player, pegIndex, from, to, kind) => {
    if (bumpFxRef.current) clearInterval(bumpFxRef.current);
    const steps = 14;
    let step = 0;
    setBumpFx({ player, pegIndex, from, to, kind, progress: 0 });
    bumpFxRef.current = setInterval(() => {
      step++;
      if (step >= steps) {
        clearInterval(bumpFxRef.current);
        bumpFxRef.current = null;
        setBumpFx(null);
      } else {
        setBumpFx(prev => (prev ? { ...prev, progress: step / steps } : null));
      }
    }, 40);
  }, []);

  // When you finish your turn and control passes to the AI, start recording a
  // fresh round so the replay buffer only ever holds the moves made since your
  // last turn.
  useEffect(() => {
    const prev = replayPrevPlayerRef.current;
    if (prev === 0 && currentPlayer !== 0) {
      replayLogRef.current = [];
      setReplayReady(0);
    }
    replayPrevPlayerRef.current = currentPlayer;
  }, [currentPlayer]);

  // Play back the buffered AI moves, slowed down, as an "instant replay". The
  // board is driven from the recorded snapshots and restored to the live state
  // when the replay finishes or is stopped, so nothing else in the game changes.
  const startReplay = useCallback(() => {
    const frames = replayLogRef.current;
    if (!frames.length || isReplaying) return;
    unlockAudio();

    replayCancelRef.current = false;
    replayRestoreRef.current = pegs; // true current board (== last frame's pegsAfter)
    setIsReplaying(true);
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);

    const total = frames.length;

    const finish = () => {
      if (replaySegTimerRef.current) { clearInterval(replaySegTimerRef.current); replaySegTimerRef.current = null; }
      if (replayFrameTimerRef.current) { clearTimeout(replayFrameTimerRef.current); replayFrameTimerRef.current = null; }
      setAnimatingPeg(null);
      setReplayInfo(null);
      setIsReplaying(false);
      if (replayRestoreRef.current) {
        setPegs(replayRestoreRef.current);
        replayRestoreRef.current = null;
      }
    };

    // Animate one segment (a single peg gliding), then advance to the next.
    const animateSegments = (segments, idx, done) => {
      if (replayCancelRef.current) return;
      if (idx >= segments.length) { done(); return; }
      const seg = segments[idx];
      setPegs(seg.fromPegs);
      const path = calculateMovePath(seg.owner, seg.pegIndex, seg.card, seg.amount, seg.fromPegs);
      if (!path.length) {
        setPegs(seg.toPegs);
        animateSegments(segments, idx + 1, done);
        return;
      }
      setAnimatingPeg({ player: seg.owner, pegIndex: seg.pegIndex, path, currentStep: 0 });
      let step = 0;
      replaySegTimerRef.current = setInterval(() => {
        if (replayCancelRef.current) {
          clearInterval(replaySegTimerRef.current);
          replaySegTimerRef.current = null;
          return;
        }
        step++;
        if (step >= path.length) {
          clearInterval(replaySegTimerRef.current);
          replaySegTimerRef.current = null;
          setAnimatingPeg(null);
          setPegs(seg.toPegs);
          animateSegments(segments, idx + 1, done);
        } else {
          setAnimatingPeg(prev => prev ? { ...prev, currentStep: step } : null);
        }
      }, REPLAY_SEG_MS);
    };

    const playFrame = (i) => {
      if (replayCancelRef.current) return;
      if (i >= total) { finish(); return; }
      const frame = frames[i];
      setReplayInfo({ player: frame.player, description: frame.description, index: i + 1, total });
      setPegs(frame.pegsBefore);
      // Hold on the starting position, then animate (or snap, for jokers/discards).
      replayFrameTimerRef.current = setTimeout(() => {
        if (replayCancelRef.current) return;
        const advance = () => {
          setPegs(frame.pegsAfter);
          replayFrameTimerRef.current = setTimeout(() => {
            if (replayCancelRef.current) return;
            playFrame(i + 1);
          }, REPLAY_FRAME_PAUSE_MS);
        };
        if (frame.segments && frame.segments.length) {
          animateSegments(frame.segments, 0, advance);
        } else {
          advance();
        }
      }, REPLAY_LEADIN_MS);
    };

    playFrame(0);
  }, [isReplaying, pegs]);

  // Abort an in-flight replay and snap the board back to the live state.
  const stopReplay = useCallback(() => {
    replayCancelRef.current = true;
    if (replaySegTimerRef.current) { clearInterval(replaySegTimerRef.current); replaySegTimerRef.current = null; }
    if (replayFrameTimerRef.current) { clearTimeout(replayFrameTimerRef.current); replayFrameTimerRef.current = null; }
    setAnimatingPeg(null);
    setReplayInfo(null);
    setIsReplaying(false);
    if (replayRestoreRef.current) {
      setPegs(replayRestoreRef.current);
      replayRestoreRef.current = null;
    }
  }, []);

  // Clean up replay timers if the component unmounts mid-playback.
  useEffect(() => () => {
    if (replaySegTimerRef.current) clearInterval(replaySegTimerRef.current);
    if (replayFrameTimerRef.current) clearTimeout(replayFrameTimerRef.current);
  }, []);

  // `mover` is the acting player (for stats); `moverPeg` is the peg that moved
  // (so a friendly partner bump doesn't flag the mover itself).
  const triggerMoveEffects = useCallback((oldPegs, updatedPegs, mover, moverPeg = null) => {
    const bumps = findBumps(oldPegs, updatedPegs);
    const friendly = gameMode === GAME_MODES.PARTNERS
      ? findFriendlyBumps(oldPegs, updatedPegs, moverPeg)
      : [];
    if (bumps.length === 0 && friendly.length === 0) return;

    // Tally bumps for stats: pegs you sent home vs. your pegs sent home. Friendly
    // partner bumps are cooperative and don't count.
    for (const b of bumps) {
      if (mover === 0 && b.player !== 0) bumpsDeliveredThisGameRef.current += 1;
      if (mover !== 0 && b.player === 0) timesBumpedThisGameRef.current += 1;
    }

    sfx.bump();
    if (!animationsEnabled) return;

    // Prefer animating a knock-back-to-start; otherwise fly a friendly bump forward.
    if (bumps.length > 0) {
      const bump = bumps[0];
      runBumpFx(bump.player, bump.pegIndex, getTrackPosition(bump.fromPosition),
        getStartAreaPosition(bump.player, bump.pegIndex), 'start');
    } else {
      const fb = friendly[0];
      runBumpFx(fb.player, fb.pegIndex, getTrackPosition(fb.fromPosition),
        getTrackPosition(fb.toPosition), 'friendly');
    }
  }, [animationsEnabled, gameMode, runBumpFx]);

  // `owner` is whose peg moves (the human's partner once the human is all home);
  // the human always acts as player 0, so the hand, discards and turn are theirs.
  const executeMove = useCallback((owner, pegIndex, card, splitAmount = null) => {
    const actor = 0;
    if (!isValidMove(owner, pegIndex, card, pegs, splitAmount, moveOptions)) {
      setGameMessage('Invalid move. Try again.');
      return false;
    }

    const cardInfo = CARD_VALUES[card.rank];

    // For 9 card splits, validate that a second peg can complete the split BEFORE executing the first move
    if (cardInfo.mustSplit && splitAmount !== null) {
      const remaining = splitAmount > 0 ? -(9 - splitAmount) : (9 - Math.abs(splitAmount));

      // Simulate the first move to get the intermediate state
      const { newPegs: afterFirstMove } = applyMove(owner, pegIndex, card, splitAmount, pegs, moveOptions);

      // Check if there's at least one other peg that can make the second move
      let hasValidSecondPeg = false;
      for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
        if (secondPeg === pegIndex) continue; // Must use a different peg
        if (isValidMove(owner, secondPeg, card, afterFirstMove, remaining, moveOptions)) {
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
      const { newPegs: afterFirstMove } = applyMove(owner, pegIndex, card, splitAmount, pegs, moveOptions);

      // Check if there's at least one OTHER peg that can make the second move
      let hasValidSecondPeg = false;
      for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
        if (secondPeg === pegIndex) continue; // Must use a different peg
        if (isValidMove(owner, secondPeg, card, afterFirstMove, remaining, moveOptions)) {
          hasValidSecondPeg = true;
          break;
        }
      }

      if (!hasValidSecondPeg) {
        setGameMessage(`Cannot split: no other peg can move the remaining ${remaining} spaces.`);
        return false;
      }
    }

    const oldPeg = pegs[owner][pegIndex];
    const { newPegs } = applyMove(owner, pegIndex, card, splitAmount, pegs, moveOptions);
    const newPeg = newPegs[owner][pegIndex];

    triggerMoveEffects(pegs, newPegs, actor, { player: owner, pegIndex });
    if (newPeg.location === 'home') {
      sfx.home();
    } else {
      sfx.cardPlay();
    }

    // Record last move description (under the acting human)
    const moveDescription = describeMoveAction(oldPeg, newPeg, card, splitAmount);
    setLastMoves(prev => {
      const updated = [...prev];
      updated[actor] = moveDescription;
      return updated;
    });

    setPegs(newPegs);

    // Handle 7 card splitting
    if (cardInfo.canSplit && splitAmount !== null && splitAmount < 7) {
      const remaining = 7 - splitAmount;
      setSplitRemaining(remaining);
      setSplitCard(card);
      setSplitPegIndex(pegIndex); // Track which peg was moved first
      setSplitUndo({ pegs, lastMoves }); // pre-move board, so a mis-tap can be undone
      setSelectedPeg(null);
      setGameMessage(`Tap a glowing peg to move the remaining ${remaining} spaces (or Undo).`);
      return true;
    }

    // Handle 9 card (must split forward/backward)
    if (cardInfo.mustSplit && splitAmount !== null) {
      const remaining = 9 - Math.abs(splitAmount);
      const direction = splitAmount > 0 ? 'backward' : 'forward';
      setSplitRemaining(splitAmount > 0 ? -remaining : remaining);
      setSplitCard(card);
      setSplitPegIndex(pegIndex); // Track which peg was moved first
      setSplitUndo({ pegs, lastMoves }); // pre-move board, so a mis-tap can be undone
      setSelectedPeg(null);
      setGameMessage(`Tap a glowing peg to move ${remaining} spaces ${direction} (or Undo).`);
      return true;
    }

    const w = checkWinner(newPegs, gameMode);
    if (w !== null) {
      setWinner(w);
      return true;
    }

    // Remove card from the human's hand and draw new one
    const newHands = hands.map(h => [...h]);
    const cardIndex = newHands[actor].findIndex(c => c.id === card.id);
    const discarded = newHands[actor].splice(cardIndex, 1)[0];

    // Add to the human's discard pile
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === actor ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[actor].push(newCard);

    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);

    // Reset stuck count on successful move
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[actor] = 0;
    setStuckCounts(newStuckCounts);

    setSelectedCard(null);
    setSelectedPeg(null);
    setSplitRemaining(0);
    setSplitCard(null);
    setSplitPegIndex(null);

    // Switch to next player
    const nextPlayer = (actor + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);

    return true;
  }, [pegs, hands, deck, discardPiles, stuckCounts, lastMoves, triggerMoveEffects, moveOptions, gameMode]);

  const completeSplit = useCallback((pegIndex, amount) => {
    const actor = 0;
    const owner = controlledOwnerFor(pegs);
    // For both 7 and 9 cards, ensure different pegs are used
    const cardInfo = CARD_VALUES[splitCard?.rank];
    if ((cardInfo?.mustSplit || cardInfo?.canSplit) && pegIndex === splitPegIndex) {
      const cardName = cardInfo?.mustSplit ? 'Nine' : 'Seven';
      setGameMessage(`${cardName} card must use two different pegs. Try again.`);
      return false;
    }

    if (!isValidMove(owner, pegIndex, splitCard, pegs, amount, moveOptions)) {
      setGameMessage('Invalid move for split. Try again.');
      return false;
    }

    const oldPeg = pegs[owner][pegIndex];
    const { newPegs } = applyMove(owner, pegIndex, splitCard, amount, pegs, moveOptions);
    const newPeg = newPegs[owner][pegIndex];

    triggerMoveEffects(pegs, newPegs, actor, { player: owner, pegIndex });
    if (newPeg.location === 'home') {
      sfx.home();
    } else {
      sfx.cardPlay();
    }

    // Update last move description to show split completion
    const secondMoveDesc = describeMoveAction(oldPeg, newPeg, splitCard, amount);
    setLastMoves(prev => {
      const updated = [...prev];
      updated[actor] = `Split: ${prev[actor]}, ${secondMoveDesc}`;
      return updated;
    });

    setPegs(newPegs);

    const w = checkWinner(newPegs, gameMode);
    if (w !== null) {
      setWinner(w);
      return true;
    }

    const newHands = hands.map(h => [...h]);
    const cardIndex = newHands[actor].findIndex(c => c.id === splitCard.id);
    const discarded = newHands[actor].splice(cardIndex, 1)[0];

    // Add to the human's discard pile
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === actor ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[actor].push(newCard);

    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);

    // Reset stuck count on successful move
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[actor] = 0;
    setStuckCounts(newStuckCounts);

    setSelectedCard(null);
    setSelectedPeg(null);
    setSplitRemaining(0);
    setSplitCard(null);
    setSplitPegIndex(null);
    setSplitUndo(null);
    const nextPlayer = (actor + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);

    return true;
  }, [splitCard, splitPegIndex, pegs, hands, deck, discardPiles, stuckCounts, triggerMoveEffects, controlledOwnerFor, moveOptions, gameMode]);

  // Undo a half-finished split: restore the board (and anything the first half
  // bumped) to the snapshot taken before it, and return the turn to the point
  // where the card is selected and pegs are glowing, ready to try again. This is
  // only available between the two halves of a split — once the second peg is
  // played the move is committed and there's nothing to undo.
  const undoSplit = useCallback(() => {
    if (!splitUndo) return;
    // Cancel any in-flight bump fly-back from the first half before restoring.
    if (bumpFxRef.current) {
      clearInterval(bumpFxRef.current);
      bumpFxRef.current = null;
    }
    setBumpFx(null);
    setPegs(splitUndo.pegs);
    setLastMoves(splitUndo.lastMoves);
    setSplitRemaining(0);
    setSplitCard(null);
    setSplitPegIndex(null);
    setSplitUndo(null);
    setSelectedPeg(null); // keep the card selected so pegs re-glow for another try
    setGameMessage('Split undone. Select a peg to move.');
  }, [splitUndo]);

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
      // Find a peg in start and move it to come-out position. applyComeOut keeps
      // partner-mode rules intact: a teammate on the come-out space is
      // friendly-bumped to its home entrance (not knocked to start) exactly like
      // any other move, so this mercy start doesn't quietly fall back to solo
      // rules for the rest of the game.
      const pegInStart = pegs[player].findIndex(p => p.location === 'start');
      if (pegInStart !== -1) {
        const { newPegs: afterStart, ok } = applyComeOut(player, pegInStart, pegs, { actor: player, mode: gameMode });
        if (ok) {
          newPegs = afterStart;
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

    // Log AI discards into the replay buffer too, so a stuck opponent's turn is
    // still accounted for when you watch the replay.
    if (player !== 0) {
      recordReplayFrame({
        player,
        description: autoStarted ? 'Stuck 3x — started a peg' : 'No move — discarded',
        pegsBefore: pegs,
        pegsAfter: newPegs,
        segments: [],
      });
    }

    if (autoStarted) triggerMoveEffects(pegs, newPegs, player);

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
  }, [hands, deck, discardPiles, stuckCounts, pegs, triggerMoveEffects, recordReplayFrame, gameMode]);

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
      const completeAIMove = (newPegs, card, moveDescription, moverPeg = null) => {
        // Record last move description for AI
        setLastMoves(prev => {
          const updated = [...prev];
          updated[aiPlayer] = moveDescription;
          return updated;
        });

        triggerMoveEffects(pegs, newPegs, aiPlayer, moverPeg);
        sfx.peg();

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

        const w = checkWinner(newPegs, gameMode);
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
      const bestMove = findBestAIMove(aiPlayer, aiHand, pegs, { mode: gameMode });

      if (bestMove) {
        // `owner` is whose peg moves — the AI's own, or its partner's once the
        // AI has finished (partner mode).
        const owner = bestMove.owner;
        const moverPeg = { player: owner, pegIndex: bestMove.pegIndex };
        // Generate move description based on move type
        const getMoveDescription = () => {
          const oldPeg = pegs[owner][bestMove.pegIndex];
          const newPeg = bestMove.newPegs[owner][bestMove.pegIndex];

          if (bestMove.type === 'simple' || bestMove.type === 'start') {
            return describeMoveAction(oldPeg, newPeg, bestMove.card, bestMove.amount);
          } else if (bestMove.type === 'split7' || bestMove.type === 'split9') {
            const afterFirst = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
            const firstDesc = describeMoveAction(oldPeg, afterFirst[owner][bestMove.pegIndex], bestMove.card, bestMove.amount);
            const secondOldPeg = afterFirst[owner][bestMove.secondPeg];
            const secondNewPeg = bestMove.newPegs[owner][bestMove.secondPeg];
            const secondDesc = describeMoveAction(secondOldPeg, secondNewPeg, bestMove.card, bestMove.remaining);
            return `Split: ${firstDesc}, ${secondDesc}`;
          } else if (bestMove.type === 'joker') {
            return `Joker bumped ${PLAYER_NAMES[bestMove.targetPlayer]}`;
          }
          return 'Moved';
        };

        const moveDescription = getMoveDescription();

        // Record this move for the instant-replay buffer. Segments capture the
        // per-peg animation (two for a split); jokers/starts-from-nowhere snap
        // straight to the result via pegsBefore/pegsAfter.
        const replaySegments = [];
        if (bestMove.type === 'split7' || bestMove.type === 'split9') {
          const afterFirst = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
          replaySegments.push({ owner, pegIndex: bestMove.pegIndex, card: bestMove.card, amount: bestMove.amount, fromPegs: pegs, toPegs: afterFirst });
          replaySegments.push({ owner, pegIndex: bestMove.secondPeg, card: bestMove.card, amount: bestMove.remaining, fromPegs: afterFirst, toPegs: bestMove.newPegs });
        } else if (bestMove.type === 'simple' || bestMove.type === 'start') {
          replaySegments.push({ owner, pegIndex: bestMove.pegIndex, card: bestMove.card, amount: bestMove.amount, fromPegs: pegs, toPegs: bestMove.newPegs });
        }
        recordReplayFrame({
          player: aiPlayer,
          description: moveDescription,
          pegsBefore: pegs,
          pegsAfter: bestMove.newPegs,
          segments: replaySegments,
        });

        // If animations disabled, just complete immediately
        if (!animationsEnabled) {
          if (completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, moverPeg)) return;
          return;
        }

        // Animate the move before completing
        if (bestMove.type === 'simple' || bestMove.type === 'start') {
          // Single move animation
          animateMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, moverPeg);
          });
        } else if (bestMove.type === 'split7') {
          // Two-part animation for 7 split
          animateMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg
            const afterFirstPegs = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
            animateMove(owner, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, moverPeg);
            });
          });
        } else if (bestMove.type === 'split9') {
          // Two-part animation for 9 split
          animateMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg
            const afterFirstPegs = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
            animateMove(owner, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, moverPeg);
            });
          });
        } else if (bestMove.type === 'joker') {
          // Joker - just complete (animation path is empty for jokers)
          completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, moverPeg);
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
  }, [currentPlayer, winner, hands, pegs, deck, discardPiles, stuckCounts, discardAndDraw, animationsEnabled, animateMove, triggerMoveEffects, recordReplayFrame, gameMode]);

  // Chime + gentle buzz when control passes back to the human player
  useEffect(() => {
    if (currentPlayer === 0 && prevPlayerRef.current !== null && prevPlayerRef.current !== 0 && winner === null) {
      sfx.yourTurn();
    }
    prevPlayerRef.current = currentPlayer;
  }, [currentPlayer, winner]);

  // Count a completed turn each time control passes to a different player.
  // The winning move doesn't switch players, so it's added on at record time.
  useEffect(() => {
    if (winner !== null) return;
    if (prevTurnPlayerRef.current !== null && prevTurnPlayerRef.current !== currentPlayer) {
      turnsRef.current += 1;
    }
    prevTurnPlayerRef.current = currentPlayer;
  }, [currentPlayer, winner]);

  // Fanfare on win, descending tone on loss
  useEffect(() => {
    if (winner === null) return;
    if (winner === 0) {
      sfx.win();
    } else {
      sfx.lose();
    }
  }, [winner]);

  // Fold the finished game into the persisted player stats exactly once.
  useEffect(() => {
    if (winner === null || gameRecordedRef.current) return;
    gameRecordedRef.current = true;
    const result = {
      won: winner === 0,
      winner,
      turns: turnsRef.current + 1, // include the winning turn
      startMode: startModeRef.current,
      mode: gameMode,
      jokersPlayed: jokersThisGameRef.current,
      bumpsDelivered: bumpsDeliveredThisGameRef.current,
      timesBumped: timesBumpedThisGameRef.current
    };
    setStats(prev => {
      const updated = recordGame(prev, result);
      saveStats(updated);
      return updated;
    });
  }, [winner]);

  // Persist the in-progress game after every committed change so a mobile tab
  // eviction (a phone call mid-game) doesn't lose it. Skip while a modal is up
  // or before cards are dealt, and clear the save once the game is over so we
  // never offer to resume a finished game.
  useEffect(() => {
    if (showFirstPlayerModal || showResumeModal) return;
    if (isReplaying) return; // don't persist the rewound board during a replay
    if (!(hands[0]?.length > 0)) return; // no game in progress yet
    if (winner !== null) {
      clearGame();
      return;
    }
    saveGame({
      mode: gameMode,
      pegs,
      hands,
      deck,
      discardPiles,
      stuckCounts,
      currentPlayer,
      splitRemaining,
      splitCard,
      splitPegIndex,
      lastMoves,
      moveHistory,
      turns: turnsRef.current,
      jokersPlayed: jokersThisGameRef.current,
      bumpsDelivered: bumpsDeliveredThisGameRef.current,
      timesBumped: timesBumpedThisGameRef.current,
      startMode: startModeRef.current,
    });
  }, [
    pegs, hands, deck, discardPiles, stuckCounts, currentPlayer,
    splitRemaining, splitCard, splitPegIndex, lastMoves, moveHistory,
    winner, showFirstPlayerModal, showResumeModal, gameMode, isReplaying,
  ]);

  const selectedCardObj = selectedCard !== null ? hands[0]?.[selectedCard] ?? null : null;

  // Whose pegs the human is moving this turn (their own, or their partner's once
  // they've finished in partner mode).
  const controlledOwner = controlledOwnerFor(pegs);

  // Pegs the human can legally move right now (null = highlighting inactive).
  // During the second half of a split this is the set of pegs that can finish it.
  const movablePegSet = useMemo(() => {
    if (currentPlayer !== 0 || winner !== null || discardMode || jokerMode || isReplaying) return null;
    if (splitRemaining !== 0 && splitCard) {
      const set = new Set();
      for (let i = 0; i < 5; i++) {
        if (i === splitPegIndex) continue;
        if (isValidMove(controlledOwner, i, splitCard, pegs, splitRemaining, moveOptions)) set.add(i);
      }
      return set;
    }
    if (!selectedCardObj) return null;
    return new Set(getMovablePegs(controlledOwner, selectedCardObj, pegs, moveOptions));
  }, [currentPlayer, winner, discardMode, jokerMode, isReplaying, splitRemaining, splitCard, splitPegIndex, selectedCardObj, pegs, controlledOwner, moveOptions]);

  // Tappable destination spaces for the selected peg with a 7 or 9 (ghost
  // circles on the board — tapping one picks that split amount)
  const ghostDestinations = useMemo(() => {
    if (currentPlayer !== 0 || winner !== null || jokerMode || discardMode || isReplaying) return [];
    if (splitRemaining !== 0 || !selectedCardObj || selectedPeg === null) return [];
    const info = CARD_VALUES[selectedCardObj.rank];
    if (!info.canSplit && !info.mustSplit) return [];
    return getValidDestinations(controlledOwner, selectedPeg, selectedCardObj, pegs, moveOptions);
  }, [currentPlayer, winner, jokerMode, discardMode, isReplaying, splitRemaining, selectedCardObj, selectedPeg, pegs, controlledOwner, moveOptions]);

  // Which cards in hand have at least one fully playable move (used to dim
  // dead cards; unlike hasAnyValidMove this requires splits to be completable)
  const playableCards = useMemo(() => {
    if (currentPlayer !== 0 || winner !== null) return hands[0].map(() => true);
    return hands[0].map(c => getMovablePegs(controlledOwner, c, pegs, moveOptions).length > 0);
  }, [currentPlayer, winner, hands, pegs, controlledOwner, moveOptions]);

  const handleCardClick = (cardIndex) => {
    if (currentPlayer !== 0 || winner !== null || isReplaying) return;
    if (splitRemaining !== 0) return;
    unlockAudio();

    // In discard mode, clicking a card discards it
    if (discardMode) {
      discardAndDraw(0, cardIndex);
      return;
    }

    // Reset joker mode if selecting a different card
    if (jokerMode) {
      setJokerMode(false);
      setJokerSourcePeg(null);
    }
    setSelectedCard(cardIndex);
    setSelectedPeg(null);
  };

  const handlePegClick = (player, pegIndex) => {
    if (currentPlayer !== 0 || winner !== null || isReplaying) return;

    // In joker mode, clicking your own peg cancels the selection
    if (jokerMode && player === controlledOwner) {
      setJokerMode(false);
      setJokerSourcePeg(null);
      setSelectedPeg(null);
      setGameMessage('Joker cancelled. Select a card and peg to move.');
      return;
    }

    if (player !== controlledOwner) return;

    if (splitRemaining !== 0) {
      const cardInfo = CARD_VALUES[splitCard?.rank];
      if (pegIndex === splitPegIndex) {
        const cardName = cardInfo?.mustSplit ? 'Nine' : 'Seven';
        setGameMessage(`${cardName} card must use two different pegs. Try again.`);
        return;
      }
      if (movablePegSet && !movablePegSet.has(pegIndex)) {
        setGameMessage('That peg cannot finish the split. Tap a glowing peg.');
        return;
      }
      completeSplit(pegIndex, splitRemaining);
      return;
    }

    if (selectedCard === null) {
      setGameMessage('Select a card first.');
      return;
    }

    if (movablePegSet && !movablePegSet.has(pegIndex)) {
      setGameMessage('That peg has no legal move with this card. Glowing pegs can move.');
      return;
    }

    setSelectedPeg(pegIndex);
    const card = hands[0][selectedCard];
    const cardInfo = CARD_VALUES[card.rank];

    // Handle Joker - enter selection mode for target
    if (cardInfo.isJoker) {
      setJokerMode(true);
      setJokerSourcePeg(pegIndex);
      setGameMessage(
        gameMode === GAME_MODES.PARTNERS
          ? "Click a peg on the track to bump — hit your partner to send them to their home stretch."
          : "Now click an opponent's peg on the track to bump it."
      );
      return;
    }

    if ((cardInfo.canSplit || cardInfo.mustSplit) &&
        (pegs[controlledOwner][pegIndex].location === 'track' || pegs[controlledOwner][pegIndex].location === 'home')) {
      // 7s and 9s: tap one of the ghost destination spaces to pick the amount
      setGameMessage('Tap a pulsing space on the board to move this peg there.');
    } else {
      executeMove(controlledOwner, pegIndex, card);
    }
  };

  const handleJokerTarget = (targetPlayer, targetPegIndex) => {
    if (isReplaying) return;
    if (!jokerMode || jokerSourcePeg === null || selectedCard === null) return;
    const actor = 0;
    const owner = controlledOwnerFor(pegs);
    if (targetPlayer === owner) return; // Can't target the mover's own pegs

    const targetPeg = pegs[targetPlayer][targetPegIndex];
    if (targetPeg.location !== 'track') return; // Can only bump pegs on track

    const card = hands[actor][selectedCard];

    // Execute the joker via the engine so the partner friendly-bump rule applies.
    const { newPegs, bumped } = applyJoker(owner, jokerSourcePeg, targetPlayer, targetPegIndex, pegs, moveOptions);
    if (!bumped) {
      setGameMessage('That joker bump is not legal. Pick another target.');
      return;
    }

    // Record last move for Joker
    const friendly = gameMode === GAME_MODES.PARTNERS && sameTeam(targetPlayer, actor);
    setLastMoves(prev => {
      const updated = [...prev];
      updated[actor] = friendly
        ? `Joker sent ${PLAYER_NAMES[targetPlayer]} to home stretch`
        : `Joker bumped ${PLAYER_NAMES[targetPlayer]}`;
      return updated;
    });

    jokersThisGameRef.current += 1;
    triggerMoveEffects(pegs, newPegs, actor, { player: owner, pegIndex: jokerSourcePeg });

    setPegs(newPegs);

    // Remove card from the human's hand and draw new one
    const newHands = hands.map(h => [...h]);
    const cardIndex = newHands[actor].findIndex(c => c.id === card.id);
    const discarded = newHands[actor].splice(cardIndex, 1)[0];

    // Add to the human's discard pile
    const newDiscardPiles = discardPiles.map((pile, i) =>
      i === actor ? [...pile, discarded] : [...pile]
    );

    const { card: newCard, newDeck, newDiscardPiles: updatedDiscardPiles } = drawCard(deck, newDiscardPiles);
    if (newCard) newHands[actor].push(newCard);

    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);

    // Reset stuck count on successful move
    const newStuckCounts = [...stuckCounts];
    newStuckCounts[actor] = 0;
    setStuckCounts(newStuckCounts);

    // Reset state
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);

    const w = checkWinner(newPegs, gameMode);
    if (w !== null) {
      setWinner(w);
      return;
    }

    // Next player
    const nextPlayer = 1; // After player 0, always goes to player 1
    setCurrentPlayer(nextPlayer);
    setGameMessage(`${PLAYER_NAMES[nextPlayer]} is thinking...`);
  };

  // Tap on a ghost destination circle: play the selected card with the amount
  // that lands the selected peg on that space
  const handleGhostClick = (dest) => {
    if (isReplaying) return;
    if (selectedCard === null || selectedPeg === null) return;
    const card = hands[0][selectedCard];
    executeMove(controlledOwnerFor(pegs), selectedPeg, card, dest.amount);
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

  // Board label for a seat: "You", partner or opponent in partner mode, else AI.
  const roleLabel = (player) => {
    if (player === 0) return 'You (Yellow)';
    if (gameMode === GAME_MODES.PARTNERS) {
      return `${PLAYER_NAMES[player]} (${sameTeam(player, 0) ? 'Partner' : 'Opponent'})`;
    }
    return `${PLAYER_NAMES[player]} (AI)`;
  };

  const renderCard = (card, index, isSelected, isPlayable = true) => {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const discardHighlight = discardMode ? 'ring-2 ring-red-400 hover:ring-red-300' : '';
    const deadCard = !isPlayable && !discardMode ? 'opacity-50' : '';
    return (
      <div
        key={card.id}
        onClick={() => handleCardClick(index)}
        className={`cursor-pointer transition-transform ${isSelected ? 'ring-2 ring-yellow-400 -translate-y-2' : 'hover:-translate-y-1'} ${discardHighlight} ${deadCard}`}
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
      <InstallPrompt />

      {/* Resume Saved Game Modal */}
      {showResumeModal && pendingResume && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-3 text-center">Resume game?</h2>
            <p className="text-center text-gray-300 mb-6">
              You have a game in progress
              {pendingResume.currentPlayer === 0 ? (
                <> — it's <span className="font-semibold text-amber-400">your turn</span>.</>
              ) : (
                <>
                  {' — '}
                  <span
                    className="font-semibold"
                    style={{ color: PLAYER_COLORS[pendingResume.currentPlayer] }}
                  >
                    {PLAYER_NAMES[pendingResume.currentPlayer]}
                  </span>{' '}
                  is up next.
                </>
              )}
            </p>
            <div className="space-y-4">
              <button
                onClick={() => {
                  unlockAudio();
                  applySavedGame(pendingResume);
                }}
                className="w-full px-6 py-4 bg-amber-600 hover:bg-amber-700 rounded-lg text-lg font-semibold transition-colors"
              >
                Resume Game
              </button>
              <button
                onClick={() => {
                  clearGame();
                  setPendingResume(null);
                  setShowResumeModal(false);
                  initGame();
                }}
                className="w-full px-6 py-4 bg-gray-600 hover:bg-gray-700 rounded-lg text-lg font-semibold transition-colors"
              >
                Start New Game
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First Player Selection Modal */}
      {showFirstPlayerModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-6 text-center">Choose First Player</h2>

            {!isSpinning && stats.gamesPlayed > 0 && (
              <div className="grid grid-cols-3 gap-2 mb-6">
                <div className="bg-gray-700 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold">{stats.gamesPlayed}</div>
                  <div className="text-xs text-gray-400">Games</div>
                </div>
                <div className="bg-gray-700 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold">{Math.round(winRate(stats) * 100)}%</div>
                  <div className="text-xs text-gray-400">Win rate</div>
                </div>
                <div className="bg-gray-700 rounded-lg p-3 text-center">
                  <div className={`text-xl font-bold ${stats.currentStreak > 0 ? 'text-green-400' : stats.currentStreak < 0 ? 'text-red-400' : ''}`}>
                    {formatStreak(stats.currentStreak)}
                  </div>
                  <div className="text-xs text-gray-400">Streak</div>
                </div>
              </div>
            )}

            {!isSpinning && (
              <div className="mb-6">
                <div className="text-sm text-gray-400 mb-2 text-center">Game mode</div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setGameMode(GAME_MODES.CLASSIC)}
                    className={`px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${
                      gameMode === GAME_MODES.CLASSIC ? 'bg-amber-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    Classic
                    <span className="block text-xs font-normal opacity-80">Every player for themselves</span>
                  </button>
                  <button
                    onClick={() => setGameMode(GAME_MODES.PARTNERS)}
                    className={`px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${
                      gameMode === GAME_MODES.PARTNERS ? 'bg-amber-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    Partners
                    <span className="block text-xs font-normal opacity-80">You + Pink vs Blue + Green</span>
                  </button>
                </div>
              </div>
            )}

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

      {/* Player Stats Modal */}
      {showStats && (
        <div
          className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4"
          onClick={() => setShowStats(false)}
        >
          <div
            className="bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-6 pb-4 border-b border-gray-700 sticky top-0 bg-gray-800">
              <h2 className="text-2xl font-bold">📊 Your Stats</h2>
              <button
                onClick={() => setShowStats(false)}
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-lg leading-none"
                aria-label="Close stats"
              >
                ✕
              </button>
            </div>

            {stats.gamesPlayed === 0 ? (
              <div className="p-8 text-center text-gray-400">
                <p className="text-lg mb-2">No games played yet.</p>
                <p className="text-sm">Finish a game and your stats will show up here.</p>
              </div>
            ) : (
              <div className="p-6 space-y-6">
                {/* Headline tiles */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold">{stats.gamesPlayed}</div>
                    <div className="text-xs text-gray-400 mt-1">Games</div>
                  </div>
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-amber-400">{Math.round(winRate(stats) * 100)}%</div>
                    <div className="text-xs text-gray-400 mt-1">Win rate</div>
                  </div>
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className={`text-2xl font-bold ${stats.currentStreak > 0 ? 'text-green-400' : stats.currentStreak < 0 ? 'text-red-400' : ''}`}>
                      {formatStreak(stats.currentStreak)}
                    </div>
                    <div className="text-xs text-gray-400 mt-1">Streak</div>
                  </div>
                </div>

                {/* Record + form */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                    <span className="text-gray-400">Record (W–L)</span>
                    <span className="font-semibold">{stats.wins}–{stats.losses}</span>
                  </div>
                  <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                    <span className="text-gray-400">Longest win streak</span>
                    <span className="font-semibold">{stats.longestWinStreak}</span>
                  </div>
                  <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                    <span className="text-gray-400">Fastest win</span>
                    <span className="font-semibold">
                      {stats.fastestWinTurns !== null ? `${stats.fastestWinTurns} turns` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                    <span className="text-gray-400">Avg. game length</span>
                    <span className="font-semibold">{Math.round(averageTurns(stats))} turns</span>
                  </div>
                </div>

                {/* Aggression */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-300 mb-2">Aggression</h3>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="bg-gray-700 rounded-lg p-3">
                      <div className="text-xl font-bold">{stats.jokersPlayed}</div>
                      <div className="text-xs text-gray-400 mt-1">Jokers played</div>
                    </div>
                    <div className="bg-gray-700 rounded-lg p-3">
                      <div className="text-xl font-bold text-green-400">{stats.bumpsDelivered}</div>
                      <div className="text-xs text-gray-400 mt-1">Pegs you bumped</div>
                    </div>
                    <div className="bg-gray-700 rounded-lg p-3">
                      <div className="text-xl font-bold text-red-400">{stats.timesBumped}</div>
                      <div className="text-xs text-gray-400 mt-1">Times bumped</div>
                    </div>
                  </div>
                </div>

                {/* First-player edge */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-300 mb-2">Does going first help?</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                      <span className="text-gray-400">You first</span>
                      <span className="font-semibold">
                        {stats.chosenFirst.games > 0
                          ? `${Math.round(bucketWinRate(stats.chosenFirst) * 100)}% (${stats.chosenFirst.games})`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                      <span className="text-gray-400">Random first</span>
                      <span className="font-semibold">
                        {stats.randomFirst.games > 0
                          ? `${Math.round(bucketWinRate(stats.randomFirst) * 100)}% (${stats.randomFirst.games})`
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Win rate by game mode */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-300 mb-2">Solo vs partner</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                      <span className="text-gray-400">Solo</span>
                      <span className="font-semibold">
                        {stats.soloGames.games > 0
                          ? `${Math.round(bucketWinRate(stats.soloGames) * 100)}% (${stats.soloGames.games})`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between bg-gray-700/50 rounded px-3 py-2">
                      <span className="text-gray-400">Partner</span>
                      <span className="font-semibold">
                        {stats.partnerGames.games > 0
                          ? `${Math.round(bucketWinRate(stats.partnerGames) * 100)}% (${stats.partnerGames.games})`
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Nemesis */}
                {(() => {
                  const nemesis = getNemesis(stats);
                  if (!nemesis) return null;
                  return (
                    <div className="flex items-center justify-between bg-gray-700/50 rounded-lg px-4 py-3">
                      <div>
                        <div className="text-sm font-semibold text-gray-300">Nemesis</div>
                        <div className="text-xs text-gray-400">Beats you most often</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block w-3 h-3 rounded-full"
                          style={{ backgroundColor: PLAYER_COLORS[nemesis.player] }}
                        />
                        <span className="font-bold" style={{ color: PLAYER_COLORS[nemesis.player] }}>
                          {PLAYER_NAMES[nemesis.player]}
                        </span>
                        <span className="text-gray-400 text-sm">({nemesis.losses})</span>
                      </div>
                    </div>
                  );
                })()}

                {/* Reset */}
                <div className="pt-2 border-t border-gray-700 text-right">
                  <button
                    onClick={() => {
                      if (window.confirm('Reset all your stats? This cannot be undone.')) {
                        setStats(resetStats());
                      }
                    }}
                    className="text-sm text-gray-400 hover:text-red-400 underline"
                  >
                    Reset stats
                  </button>
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
              onClick={() => {
                unlockAudio();
                const next = !soundOn;
                setSoundOn(next);
                setMuted(!next);
              }}
              className="px-3 py-2 rounded text-sm bg-gray-700 hover:bg-gray-600"
              aria-label={soundOn ? 'Mute sound and vibration' : 'Unmute sound and vibration'}
            >
              {soundOn ? '🔊' : '🔇'}
            </button>
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
              onClick={() => setShowStats(true)}
              className="px-4 py-2 bg-indigo-600 rounded hover:bg-indigo-700"
            >
              📊 Stats
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
            {gameMode === GAME_MODES.PARTNERS
              ? (winner === 0 ? 'Your team wins! 🎉' : 'Opponents win!')
              : (winner === 0 ? 'You Win!' : 'Opponent Wins!')}
          </div>
        )}

        <div className="text-center mb-4 p-2 bg-gray-800 rounded">
          {gameMessage}
        </div>

        {/* Undo a mis-tapped split: only available between the two halves of a
            split, before the second peg commits the move */}
        {splitUndo && splitRemaining !== 0 && currentPlayer === 0 && winner === null && !isReplaying && (
          <div className="text-center mb-4">
            <button
              onClick={undoSplit}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded font-semibold"
            >
              ↩️ Undo Split
            </button>
          </div>
        )}

        {/* Instant replay: offer a rewind when it's your turn and the AI just moved */}
        {!isReplaying && replayReady > 0 && currentPlayer === 0 && winner === null && (
          <div className="text-center mb-4">
            <button
              onClick={startReplay}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded font-semibold"
            >
              📺 Instant Replay ({replayReady} {replayReady === 1 ? 'move' : 'moves'})
            </button>
          </div>
        )}

        {/* Playback banner while the replay runs */}
        {isReplaying && replayInfo && (
          <div className="mb-4 p-3 rounded flex items-center justify-between gap-3 bg-purple-900">
            <div className="text-sm min-w-0">
              <span className="font-bold">📺 Instant Replay</span>{' '}
              <span className="text-gray-300">({replayInfo.index}/{replayInfo.total})</span>
              <div className="truncate">
                <span className="font-semibold" style={{ color: PLAYER_COLORS[replayInfo.player] }}>
                  {PLAYER_NAMES[replayInfo.player]}
                </span>
                <span className="text-gray-200"> — {replayInfo.description}</span>
              </div>
            </div>
            <button
              onClick={stopReplay}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm flex-shrink-0"
            >
              Stop
            </button>
          </div>
        )}

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
                    // While a bumped peg is flying back, its start slot renders empty
                    const isFlyingBack = bumpFx && bumpFx.player === player && bumpFx.pegIndex === i;
                    const hasPeg = pegs[player][i]?.location === 'start' && !isFlyingBack;
                    const isClickable = currentPlayer === 0 && player === controlledOwner && hasPeg && !jokerMode;
                    const isSelected = player === controlledOwner && (i === selectedPeg || i === jokerSourcePeg) && pegs[player][i]?.location === 'start';
                    const isMovable = player === controlledOwner && hasPeg && movablePegSet != null && movablePegSet.has(i);
                    const isDimmed = player === controlledOwner && hasPeg && movablePegSet != null && !movablePegSet.has(i);
                    return (
                      <g
                        key={`start-${player}-${i}`}
                        style={{ cursor: isClickable ? 'pointer' : 'default' }}
                        onClick={() => isClickable && handlePegClick(player, i)}
                      >
                        <circle
                          cx={x}
                          cy={y}
                          r={5}
                          fill={hasPeg ? PLAYER_COLORS[player] : '#374151'}
                          stroke={isSelected || isMovable ? 'white' : PLAYER_COLORS[player]}
                          strokeWidth={isSelected || isMovable ? 2 : 1.5}
                          opacity={isDimmed ? 0.4 : 1}
                          className={isMovable ? 'peg-glow' : undefined}
                        />
                        {isClickable && <circle cx={x} cy={y} r={12} fill="transparent" />}
                      </g>
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
                    const isClickable = currentPlayer === 0 && player === controlledOwner && hasPeg && i < 4 && !jokerMode;
                    const isSelected = player === controlledOwner && pegIndex === selectedPeg && hasPeg;
                    const isMovable = player === controlledOwner && hasPeg && movablePegSet != null && movablePegSet.has(pegIndex);
                    const isDimmed = player === controlledOwner && hasPeg && movablePegSet != null && !movablePegSet.has(pegIndex);
                    return (
                      <g
                        key={`home-${player}-${i}`}
                        style={{ cursor: isClickable ? 'pointer' : 'default' }}
                        onClick={() => isClickable && handlePegClick(player, pegIndex)}
                      >
                        <circle
                          cx={x}
                          cy={y}
                          r={5}
                          fill={hasPeg ? PLAYER_COLORS[player] : '#374151'}
                          stroke={isSelected || isMovable ? 'white' : PLAYER_COLORS[player]}
                          strokeWidth={isSelected || isMovable ? 2 : 1.5}
                          opacity={isDimmed ? 0.4 : 1}
                          className={isMovable ? 'peg-glow' : undefined}
                        />
                        {isClickable && <circle cx={x} cy={y} r={11} fill="transparent" />}
                      </g>
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

                  // In joker mode, any track peg the mover doesn't own is a target
                  // (an opponent to bump, or a partner for a friendly bump).
                  const isJokerTarget = jokerMode && player !== controlledOwner && peg.location === 'track';
                  const isJokerSource = jokerMode && player === controlledOwner && pegIndex === jokerSourcePeg;
                  // The human can click the pegs they control when not in joker mode,
                  // target pegs in joker mode, or their controlled pegs to cancel.
                  const isClickable = currentPlayer === 0 && (player === controlledOwner || isJokerTarget);
                  const isSelected = player === controlledOwner && (pegIndex === selectedPeg || isJokerSource);
                  const isMovable = player === controlledOwner && !jokerMode && movablePegSet != null && movablePegSet.has(pegIndex);
                  const isDimmed = player === controlledOwner && !jokerMode && movablePegSet != null && !movablePegSet.has(pegIndex);

                  return (
                    <g
                      key={`peg-${player}-${pegIndex}`}
                      style={{ cursor: isClickable ? 'pointer' : 'default' }}
                      onClick={() => {
                        if (!isClickable) return;
                        if (isJokerTarget && player !== controlledOwner) {
                          handleJokerTarget(player, pegIndex);
                        } else if (player === controlledOwner) {
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
                    >
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r={7}
                        fill={PLAYER_COLORS[player]}
                        stroke={isSelected || isMovable ? 'white' : (isJokerTarget ? '#EF4444' : '#1F2937')}
                        strokeWidth={isSelected ? 2 : (isJokerTarget ? 3 : (isMovable ? 2 : 1))}
                        opacity={isDimmed ? 0.4 : 1}
                        className={isMovable || isJokerTarget ? 'peg-glow' : undefined}
                      />
                      {isClickable && <circle cx={pos.x} cy={pos.y} r={13} fill="transparent" />}
                    </g>
                  );
                })
              )}

              {/* Ghost destinations - tappable landing spots for the selected 7/9 */}
              {ghostDestinations.map((dest) => {
                const pos = dest.location === 'home'
                  ? getHomePosition(controlledOwner, dest.homePosition)
                  : getTrackPosition(dest.position);
                const key = dest.location === 'home' ? `ghost-h${dest.homePosition}` : `ghost-t${dest.position}`;
                return (
                  <g key={key} style={{ cursor: 'pointer' }} onClick={() => handleGhostClick(dest)}>
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={8}
                      fill={PLAYER_COLORS[controlledOwner]}
                      fillOpacity={0.3}
                      stroke={PLAYER_COLORS[controlledOwner]}
                      strokeWidth={2}
                      strokeDasharray="4 2"
                      className="ghost-dest"
                    />
                    <circle cx={pos.x} cy={pos.y} r={13} fill="transparent" />
                  </g>
                );
              })}

              {/* Bumped peg flying back to its start slot */}
              {bumpFx && (() => {
                const t = 1 - Math.pow(1 - bumpFx.progress, 3); // ease-out
                const x = bumpFx.from.x + (bumpFx.to.x - bumpFx.from.x) * t;
                const y = bumpFx.from.y + (bumpFx.to.y - bumpFx.from.y) * t;
                // Friendly partner bumps fly forward (green); knock-backs fly to start (red).
                const glow = bumpFx.kind === 'friendly' ? '#22C55E' : '#EF4444';
                const shadow = bumpFx.kind === 'friendly'
                  ? 'drop-shadow(0 0 4px rgba(34, 197, 94, 0.9))'
                  : 'drop-shadow(0 0 4px rgba(239, 68, 68, 0.9))';
                return (
                  <circle
                    cx={x}
                    cy={y}
                    r={7}
                    fill={PLAYER_COLORS[bumpFx.player]}
                    stroke={glow}
                    strokeWidth={2}
                    style={{ filter: shadow }}
                  />
                );
              })()}

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
                <text x="200" y="20" textAnchor="middle" fill={PLAYER_COLORS[2]} fontSize="11" fontWeight="bold">{roleLabel(2)}</text>
                {lastMoves[2] && <text x="200" y="31" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[2]}</text>}
              </g>
              <g transform="rotate(90 378 205)">
                <text x="378" y="200" textAnchor="middle" fill={PLAYER_COLORS[3]} fontSize="11" fontWeight="bold">{roleLabel(3)}</text>
                {lastMoves[3] && <text x="378" y="211" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[3]}</text>}
              </g>
              <g>
                <text x="200" y="383" textAnchor="middle" fill={PLAYER_COLORS[0]} fontSize="11" fontWeight="bold">{roleLabel(0)}</text>
                {lastMoves[0] && <text x="200" y="394" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[0]}</text>}
              </g>
              <g transform="rotate(-90 22 205)">
                <text x="22" y="200" textAnchor="middle" fill={PLAYER_COLORS[1]} fontSize="11" fontWeight="bold">{roleLabel(1)}</text>
                {lastMoves[1] && <text x="22" y="211" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[1]}</text>}
              </g>
            </svg>
          </div>

          {/* Hand and Controls */}
          <div className="flex-1 w-full lg:w-auto">
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">Your Hand:</h3>
              <div className="flex gap-2 flex-wrap">
                {hands[0].map((card, i) => renderCard(card, i, i === selectedCard, playableCards[i]))}
              </div>
            </div>

            {ghostDestinations.length > 0 && (
              <div className="mb-4 p-3 bg-gray-800 rounded text-sm">
                {selectedCardObj?.rank === '7' ? (
                  <p>
                    Tap a pulsing space on the board. Landing 7 ahead uses the whole card;
                    landing short splits the 7 and another peg moves the rest.
                  </p>
                ) : (
                  <p>
                    Tap a pulsing space on the board. Another peg will move the rest of
                    the 9 in the opposite direction.
                  </p>
                )}
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

            {/* Discarding is only allowed when the player is genuinely stuck (no
                legal move). If any card can be played, no discard option is shown
                so the player can't skip a turn they're required to play. */}
            {currentPlayer === 0 && !jokerMode && !splitRemaining && !discardMode && !isReplaying && hands[0]?.length > 0 && !playableCards.some(Boolean) && (
              <div className="mb-4">
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
                {gameMode === GAME_MODES.PARTNERS && (
                  <>
                    <li>• <span className="text-pink-400">Partners:</span> you and Pink are a team — win when both of you are all home</li>
                    <li>• Bumping your partner sends them to their home stretch (a boost, not a setback)</li>
                    <li>• Once your pegs are all home, your cards move your partner's pegs</li>
                  </>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
