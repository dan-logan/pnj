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
  findFriendlyBumps,
  splitCompleter
} from './game/engine.js';
import { findBestAIMove } from './game/ai.js';
import {
  loadStats,
  resetStats,
  recordFinishedGame,
  newGameId,
  didIWin,
  winRate,
  averageTurns,
  bucketWinRate,
  formatStreak,
  getNemesis
} from './game/stats.js';
import { loadGame, saveGame, clearGame, serializeGame } from './game/persistence.js';
import { PHASES, derivePhase, describeStatus, describeOutcome } from './game/status.js';
import {
  SOLO_SEAT_OWNERS,
  HOST_SEAT_OWNERS,
  remoteSeatOwners,
  mySeatsOf,
  primarySeat,
  isMyTurnFor,
  isAISeat,
  nextHumanSeat,
  visualSideFor,
  seatAtVisualSide,
} from './net/seats.js';
import {
  isMultiplayerConfigured,
  signIn,
  createGame,
  joinGame,
  joinGameById,
  fetchGame,
  startGame,
  subscribeGameMeta,
  subscribeGameState,
  subscribeMyGames,
} from './net/session.js';
import { STATUS, HOST_SEAT, GUEST_SEAT } from './net/protocol.js';
import {
  loadLocalGames,
  hasLocalGames,
  upsertLocalGame,
  archiveLocalGame,
  setActiveId,
} from './net/localSession.js';
import {
  buildRemoteRows,
  countWaitingOnMe,
  relativeTime,
  seatForUid,
} from './net/lobby.js';
import InstallPrompt from './InstallPrompt.jsx';
import { sfx, isMuted, setMuted, unlockAudio } from './audio.js';

// Instant-replay pacing. Deliberately slower than the 150ms live step so a
// round of AI moves is easy to follow when it's played back.
const REPLAY_SEG_MS = 280;      // per-step while a peg animates during replay
const REPLAY_LEADIN_MS = 320;   // beat on the "before" board so the start registers
const REPLAY_FRAME_PAUSE_MS = 600; // pause after each move before the next one

export default function PegsAndJokers() {
  const [gameMode, setGameMode] = useState(GAME_MODES.CLASSIC);

  // Who owns each seat from THIS client's point of view. Solo is the layout
  // where seat 0 is the only non-AI seat; remote play swaps one AI seat for
  // 'them' and (for the guest) moves 'me' to seat 2. Nothing below may assume
  // "the local human is player 0" — derive from here instead.
  const [seatOwners, setSeatOwners] = useState(SOLO_SEAT_OWNERS);
  const mySeats = useMemo(() => mySeatsOf(seatOwners), [seatOwners]);
  const mySeat = useMemo(() => primarySeat(seatOwners), [seatOwners]);
  const ownsSeat = useCallback((player) => mySeats.includes(player), [mySeats]);

  // --- Remote play (Packages 2/3) ---------------------------------------------
  // All of this is inert for a solo player: with no Firebase config or no remote
  // games on the device, nothing here signs in or loads the Firestore SDK, and
  // none of the UI renders. `session` is null for the solo game and holds
  // { id, seat, version } for an open remote game — the server row is that game's
  // save, so the local-save effect skips while it is set.
  const multiplayerConfigured = isMultiplayerConfigured();
  const [myUid, setMyUid] = useState(null);
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null); // mirror for use inside async listeners
  const [showLobby, setShowLobby] = useState(false);
  const [remoteMeta, setRemoteMeta] = useState([]); // metadata rows from subscribeMyGames
  const [openMeta, setOpenMeta] = useState(null); // metadata of the open remote game
  const [mpScreen, setMpScreen] = useState(null); // null | 'menu' | 'hosting' | 'join'
  const [hostInfo, setHostInfo] = useState(null); // { id, code, link } while waiting for a guest
  const [joinInput, setJoinInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [mpNotice, setMpNotice] = useState(null);
  const [mpBusy, setMpBusy] = useState(false);
  const myGamesUnsubRef = useRef(null);
  const gameMetaUnsubRef = useRef(null);
  const gameStateUnsubRef = useRef(null);
  const hostDealtRef = useRef(false); // guard the deal-on-guest-join from firing twice
  const bootstrappedRef = useRef(false); // one-time mount routing

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
  const [splitOwner, setSplitOwner] = useState(null); // Owner of the first-half peg (may differ from the completer when your last peg goes home)
  // Snapshot of the board taken right before the first half of a split is played,
  // so the player can undo a mis-tapped split and start their turn over. Held
  // only while a split is half-finished; cleared once the second peg commits it.
  const [splitUndo, setSplitUndo] = useState(null); // { pegs, lastMoves } | null
  const [jokerMode, setJokerMode] = useState(false); // true when waiting for target selection
  const [jokerSourcePeg, setJokerSourcePeg] = useState(null); // which of player's pegs to move
  const [discardMode, setDiscardMode] = useState(false); // true when player is selecting a card to discard
  // Transient feedback only — "Invalid move. Try again." The *status* is
  // derived (see `phase` / `statusLine` below) and is never set imperatively.
  const [notice, setNotice] = useState(null);
  const [winner, setWinner] = useState(null);
  // What the game ended on, for the end-of-game overlay: who made the winning
  // move and what it was. Remotely this can be a move you never saw.
  const [endInfo, setEndInfo] = useState(null);
  // The overlay covers the board, so it can be dismissed to inspect the final
  // position and reopened from the status line.
  const [endOverlayDismissed, setEndOverlayDismissed] = useState(false);
  const [moveHistory, setMoveHistory] = useState([]);
  const [lastMoves, setLastMoves] = useState([null, null, null, null]); // Last move description per player

  // Replaces every `currentPlayer === 0` turn gate in the component.
  const isMyTurn = isMyTurnFor(seatOwners, currentPlayer);

  const aiProcessingRef = useRef(false); // Prevent AI from running twice on same turn
  const aiTimerRef = useRef(null); // the AI's "thinking" timeout, so endGame can cancel it
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
  // Every game has an id (a fresh uuid locally, the server row id remotely).
  // Stats are recorded against it, so a game can only ever be counted once
  // however many times its end is observed.
  const gameIdRef = useRef(null);
  const endedRef = useRef(false); // guard against a second terminal transition

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

  // The one terminal transition. Every win-detection site routes through here —
  // your move, a split that completes the win, an AI move, and later a finished
  // state arriving over the wire — so a finished game looks the same however it
  // was observed, and nothing is left running behind it.
  const endGame = useCallback((winnerIdx, { winningSeat = null, description = null } = {}) => {
    if (winnerIdx === null || winnerIdx === undefined) return;
    if (endedRef.current) return; // already terminal
    endedRef.current = true;

    // 1. Cancel everything pending. A timer that fires after the game ends and
    //    overwrites the result is the bug this whole package exists to remove.
    if (animationRef.current) { clearInterval(animationRef.current); animationRef.current = null; }
    if (bumpFxRef.current) { clearInterval(bumpFxRef.current); bumpFxRef.current = null; }
    if (replaySegTimerRef.current) { clearInterval(replaySegTimerRef.current); replaySegTimerRef.current = null; }
    if (replayFrameTimerRef.current) { clearTimeout(replayFrameTimerRef.current); replayFrameTimerRef.current = null; }
    if (spinIntervalRef.current) { clearInterval(spinIntervalRef.current); spinIntervalRef.current = null; }
    if (aiTimerRef.current) { clearTimeout(aiTimerRef.current); aiTimerRef.current = null; }
    replayCancelRef.current = true;
    aiProcessingRef.current = false;
    setAnimatingPeg(null);
    setBumpFx(null);
    setIsReplaying(false);
    setReplayInfo(null);
    setNotice(null);
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);
    // A replay cut short by the end of the game leaves the board rewound.
    if (replayRestoreRef.current) {
      setPegs(replayRestoreRef.current);
      replayRestoreRef.current = null;
    }

    // 2. The winner. Classic: a player index. Partners: a *team* index.
    setWinner(winnerIdx);

    // 3. Stats, from the terminal state and keyed by the game id, so it does
    //    not matter whether this client was watching when the game ended, nor
    //    whether the winning move was yours, your partner's or an AI's.
    const tallies = {
      turns: turnsRef.current + 1, // include the winning turn
      jokersPlayed: jokersThisGameRef.current,
      bumpsDelivered: bumpsDeliveredThisGameRef.current,
      timesBumped: timesBumpedThisGameRef.current,
    };
    const { stats: updated } = recordFinishedGame(gameIdRef.current, {
      won: didIWin(winnerIdx, gameMode, mySeats),
      winner: winnerIdx,
      mySeats,
      startMode: startModeRef.current,
      mode: gameMode,
      ...tallies,
    });
    setStats(updated);
    setEndInfo({ winner: winnerIdx, winningSeat, description, ...tallies });
    setEndOverlayDismissed(false);
  }, [gameMode, mySeats]);

  // In partner mode, once your own pegs are all home you play your hand on your
  // partner's pegs; otherwise you always control your own seat's pegs. This is
  // the "owner" of the pegs you move this turn.
  const controlledOwnerFor = useCallback((pegState) => (
    gameMode === GAME_MODES.PARTNERS && pegState[mySeat].every(p => p.location === 'home')
      ? getPartner(mySeat)
      : mySeat
  ), [gameMode, mySeat]);

  // Options threaded into the engine so it applies the partner friendly-bump rule
  // (you always act as your own seat).
  const moveOptions = useMemo(() => ({ actor: mySeat, mode: gameMode }), [mySeat, gameMode]);

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
    setSplitOwner(null);
    setSplitUndo(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);
    setNotice(null);
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
    // Reset per-game stat tallies for the new game. Seed the turn tracker to the
    // first player (not null) so the very first hand-off is counted — otherwise a
    // game the first player wins is under-counted by one turn. (applySavedGame
    // seeds it the same way when resuming.)
    turnsRef.current = 0;
    prevTurnPlayerRef.current = firstPlayer;
    jokersThisGameRef.current = 0;
    bumpsDeliveredThisGameRef.current = 0;
    timesBumpedThisGameRef.current = 0;
    gameIdRef.current = newGameId();
    endedRef.current = false;
    setEndInfo(null);
    setEndOverlayDismissed(false);
    setShowFirstPlayerModal(false);
  }, [resetReplay, ownsSeat]);

  const handleGoFirst = useCallback(() => {
    unlockAudio();
    startModeRef.current = 'chosen';
    startGameWithPlayer(mySeat);
  }, [startGameWithPlayer, mySeat]);

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
    setSplitOwner(saved.splitOwner ?? null);
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
    // Keep the saved game's identity so resuming it cannot record it twice.
    gameIdRef.current = saved.gameId ?? newGameId();
    endedRef.current = false;
    setEndInfo(null);
    setEndOverlayDismissed(false);

    // Seed the turn/return trackers to the restored player so resuming doesn't
    // count a spurious turn or fire a "your turn" chime.
    prevTurnPlayerRef.current = saved.currentPlayer;
    prevPlayerRef.current = saved.currentPlayer;
    aiProcessingRef.current = false;

    // No replay is available for a freshly resumed game until a new AI round runs.
    resetReplay();
    replayPrevPlayerRef.current = saved.currentPlayer;

    setNotice(null);

    setPendingResume(null);
    setShowResumeModal(false);
    setShowFirstPlayerModal(false);
  }, [resetReplay, ownsSeat]);

  // --- Remote play: sessions, listeners, create/join, switching ---------------
  //
  // The discipline that used to be "clear the interval" is now "detach the
  // listener" (a leaked listener costs money). Every path that changes the open
  // game — switching, joining, unmount — goes through detachGameListeners first.

  // Keep the ref in step with the state so async listeners always see the game
  // that is actually open, not the one that was open when they were created.
  const setActiveSession = useCallback((next) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const detachGameListeners = useCallback(() => {
    if (gameMetaUnsubRef.current) { gameMetaUnsubRef.current(); gameMetaUnsubRef.current = null; }
    if (gameStateUnsubRef.current) { gameStateUnsubRef.current(); gameStateUnsubRef.current = null; }
  }, []);

  // Adopt a state snapshot arriving over the wire for the open game. In Package 3
  // this is how the guest receives the initial deal; Package 4 layers turn
  // exchange and auto-replay on top of the same seam. Ignore our own echo.
  const handleRemoteState = useCallback((id, payload, info) => {
    const s = sessionRef.current;
    if (!s || s.id !== id) return; // a stale delivery from a game we left
    if (!payload || !payload.state) return; // not dealt yet
    if (info && info.isEcho(s.version)) return; // our own write coming back
    applySavedGame(payload.state);
    setActiveSession({ ...s, version: payload.version });
  }, [applySavedGame, setActiveSession]);

  // Deal the opening board as host and publish it, once a guest has claimed the
  // seat. Host goes first — a simple, deterministic rule for Phase 1; wiring the
  // existing first-player spinner into hosting is a later nicety. This does
  // everything a solo deal does, but also serialises the state onto the wire so
  // the guest can adopt it.
  const dealAndStartAsHost = useCallback(async (id) => {
    const firstPlayer = HOST_SEAT;
    const newDeck = createDeck();
    const hands = [newDeck.splice(0, 6), newDeck.splice(0, 6), newDeck.splice(0, 6), newDeck.splice(0, 6)];
    const saved = serializeGame({
      gameId: id,
      mode: GAME_MODES.PARTNERS,
      pegs: createInitialPegs(),
      hands,
      deck: newDeck,
      discardPiles: [[], [], [], []],
      stuckCounts: [0, 0, 0, 0],
      currentPlayer: firstPlayer,
      splitRemaining: 0, splitCard: null, splitPegIndex: null, splitOwner: null,
      lastMoves: [null, null, null, null],
      moveHistory: [],
      turns: 0, jokersPlayed: 0, bumpsDelivered: 0, timesBumped: 0, startMode: 'chosen',
    });
    setSeatOwners(HOST_SEAT_OWNERS);
    setGameMode(GAME_MODES.PARTNERS);
    applySavedGame(saved);
    setActiveSession({ id, seat: HOST_SEAT, version: 1 });
    setHostInfo(null);
    setMpScreen(null);
    try {
      await startGame(id, {
        state: saved,
        replay: [],
        currentPlayer: firstPlayer,
        waitingOn: nextHumanSeat(firstPlayer, HOST_SEAT_OWNERS),
      });
    } catch {
      setMpNotice('Dealt locally, but could not publish. Check your connection.');
    }
  }, [applySavedGame, setActiveSession]);

  // Metadata listener for the open game: whose turn / status for display, and —
  // for the host waiting on a partner — the trigger to deal once a guest appears.
  const handleOpenMeta = useCallback((id, meta) => {
    const s = sessionRef.current;
    if (!s || s.id !== id) return;
    setOpenMeta(meta);
    if (!meta) return;
    if (s.seat === HOST_SEAT && meta.status === STATUS.LOBBY && meta.guestUid && !hostDealtRef.current) {
      hostDealtRef.current = true;
      dealAndStartAsHost(id);
    }
  }, [dealAndStartAsHost]);

  const attachGameListeners = useCallback((id) => {
    detachGameListeners();
    gameMetaUnsubRef.current = subscribeGameMeta(id, (meta) => handleOpenMeta(id, meta));
    gameStateUnsubRef.current = subscribeGameState(id, (payload, info) => handleRemoteState(id, payload, info));
  }, [detachGameListeners, handleOpenMeta, handleRemoteState]);

  // Open a remote game this device already belongs to: orient the board from the
  // seat, fetch the current state (adopting it if the game is dealt), and attach
  // the live listeners. Used by joining and by switching in from the lobby.
  const openRemoteGame = useCallback(async (id, seat) => {
    hostDealtRef.current = false;
    detachGameListeners();
    setSeatOwners(remoteSeatOwners(seat));
    setGameMode(GAME_MODES.PARTNERS);
    setActiveSession({ id, seat, version: null });
    setActiveId(id);
    setShowLobby(false);
    setMpScreen(null);
    setShowFirstPlayerModal(false);
    setShowResumeModal(false);
    setOpenMeta(null);
    try {
      const snap = await fetchGame(id);
      setOpenMeta(snap.meta);
      if (snap.state) {
        applySavedGame(snap.state);
        setActiveSession({ id, seat, version: snap.version });
      } else if (seat === HOST_SEAT && snap.meta.guestUid && snap.meta.status === STATUS.LOBBY) {
        // Re-entering our own game that a guest joined while we were away.
        hostDealtRef.current = true;
        await dealAndStartAsHost(id);
      }
      attachGameListeners(id);
    } catch {
      setMpNotice('Could not open that game. It may have been removed.');
    }
  }, [applySavedGame, attachGameListeners, detachGameListeners, dealAndStartAsHost, setActiveSession]);

  // Host a new remote game: create it, cache it locally, show the code + share
  // link, and wait. The metadata listener deals automatically when a guest joins.
  const hostNewGame = useCallback(async (label) => {
    setMpBusy(true);
    setMpNotice(null);
    try {
      const uid = await signIn();
      setMyUid(uid);
      const { id, code } = await createGame(GAME_MODES.PARTNERS);
      upsertLocalGame({ id, seat: HOST_SEAT, code, label: (label && label.trim()) || code, createdAt: Date.now() });
      const link = `${window.location.origin}${window.location.pathname}?g=${id}`;
      hostDealtRef.current = false;
      detachGameListeners();
      setSeatOwners(HOST_SEAT_OWNERS);
      setGameMode(GAME_MODES.PARTNERS);
      setActiveSession({ id, seat: HOST_SEAT, version: 0 });
      setActiveId(id);
      setHostInfo({ id, code, link });
      setShowLobby(false);
      setShowFirstPlayerModal(false);
      setShowResumeModal(false);
      setMpScreen('hosting');
      setLabelInput('');
      attachGameListeners(id);
    } catch {
      setMpNotice('Could not create a game. Check your connection.');
    } finally {
      setMpBusy(false);
    }
  }, [attachGameListeners, detachGameListeners, setActiveSession]);

  // Join a game by code or by the id in a ?g= share link.
  const beginJoin = useCallback(async (rawInput, { byId = false, label = '' } = {}) => {
    setMpBusy(true);
    setMpNotice(null);
    try {
      const uid = await signIn();
      setMyUid(uid);
      const { id, seat } = byId ? await joinGameById(rawInput) : await joinGame(rawInput);
      upsertLocalGame({
        id,
        seat,
        code: byId ? null : rawInput,
        label: (label && label.trim()) || (byId ? null : rawInput),
        createdAt: Date.now(),
      });
      setJoinInput('');
      setLabelInput('');
      await openRemoteGame(id, seat);
    } catch {
      setMpNotice(byId ? 'Could not open that invite link — the game may be gone.' : 'No game found for that code.');
      setShowLobby(true);
    } finally {
      setMpBusy(false);
    }
  }, [openRemoteGame]);

  // Switch which game is on screen. Blocked mid-split (a half-played 7 or 9 can't
  // be persisted); everything else — a selected card/peg — is transient and
  // dropped silently. Switching away from a remote game needs no write: state is
  // only ever published at handoff, so an un-committed turn just starts over.
  const switchToGame = useCallback(async (target) => {
    if (splitRemaining !== 0) {
      setMpNotice('Finish or undo your split first, then switch games.');
      setShowLobby(true);
      return;
    }
    detachGameListeners();
    hostDealtRef.current = false;
    setOpenMeta(null);
    setMpNotice(null);
    if (target === 'solo' || target == null) {
      setActiveSession(null);
      setActiveId(null);
      setSeatOwners(SOLO_SEAT_OWNERS);
      setShowLobby(false);
      const saved = loadGame();
      if (saved) applySavedGame(saved);
      else initGame();
      return;
    }
    const seat = target.seat ?? seatForUid(target, myUid) ?? GUEST_SEAT;
    await openRemoteGame(target.id, seat);
  }, [splitRemaining, detachGameListeners, setActiveSession, applySavedGame, initGame, myUid, openRemoteGame]);

  // Hide a finished/abandoned game from the lobby without touching the document.
  const archiveGame = useCallback((id) => {
    archiveLocalGame(id);
    setRemoteMeta((rows) => [...rows]); // nudge the derived lobby to recompute
    if (sessionRef.current?.id === id) switchToGame('solo');
  }, [switchToGame]);

  // The header / end-overlay "New Game" button: leave any remote game cleanly
  // (detach listeners, drop the session) and open the solo first-player modal.
  const startNewSoloGame = useCallback(() => {
    detachGameListeners();
    hostDealtRef.current = false;
    setActiveSession(null);
    setActiveId(null);
    setOpenMeta(null);
    setSeatOwners(SOLO_SEAT_OWNERS);
    initGame();
  }, [detachGameListeners, setActiveSession, initGame]);

  // On mount, route to the right starting screen (§3.4). The lobby subsumes the
  // resume prompt, but ONLY for a device that actually has remote games — a
  // solo-only player, even with the env vars set, gets today's exact flow and is
  // never signed in.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const joinId = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('g')
      : null;
    const saved = loadGame();

    if (multiplayerConfigured && joinId) {
      if (saved) setPendingResume(saved);
      beginJoin(joinId, { byId: true });
      return;
    }
    if (multiplayerConfigured && hasLocalGames()) {
      const active = loadLocalGames().games.filter((g) => !g.archived);
      if (active.length === 1) {
        // Restore the single-game case to where you were.
        openRemoteGame(active[0].id, active[0].seat);
      } else {
        if (saved) setPendingResume(saved);
        setShowLobby(true);
      }
      return;
    }
    if (saved) {
      setPendingResume(saved);
      setShowResumeModal(true);
    } else {
      initGame();
    }
  }, [initGame, multiplayerConfigured, beginJoin, openRemoteGame]);

  // The lobby/badge listener. One subscription covers every game you are in and
  // feeds both the list and the badge. Attach it only once the player has engaged
  // with multiplayer — the lobby is open, a remote game is active, or the device
  // already has games — so a solo-only player never signs in or loads the SDK.
  useEffect(() => {
    if (!multiplayerConfigured) return;
    if (!(showLobby || session != null || hasLocalGames())) return;
    if (myGamesUnsubRef.current) return;
    myGamesUnsubRef.current = subscribeMyGames((rows) => setRemoteMeta(rows));
    signIn().then(setMyUid).catch(() => {});
  }, [multiplayerConfigured, showLobby, session]);

  // Detach every listener on unmount. This is the discipline that replaces
  // "clear the interval" — a leaked Firestore listener bills forever.
  useEffect(() => () => {
    if (myGamesUnsubRef.current) myGamesUnsubRef.current();
    if (gameMetaUnsubRef.current) gameMetaUnsubRef.current();
    if (gameStateUnsubRef.current) gameStateUnsubRef.current();
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
    if (ownsSeat(prev) && !ownsSeat(currentPlayer)) {
      replayLogRef.current = [];
      setReplayReady(0);
    }
    replayPrevPlayerRef.current = currentPlayer;
  }, [currentPlayer, ownsSeat]);

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
      if (ownsSeat(mover) && !ownsSeat(b.player)) bumpsDeliveredThisGameRef.current += 1;
      if (!ownsSeat(mover) && ownsSeat(b.player)) timesBumpedThisGameRef.current += 1;
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
  }, [animationsEnabled, gameMode, runBumpFx, ownsSeat]);

  // `owner` is whose peg moves (your partner once you are all home); you always
  // act as your own seat, so the hand, discards and turn are yours.
  const executeMove = useCallback((owner, pegIndex, card, splitAmount = null) => {
    const actor = mySeat;
    if (!isValidMove(owner, pegIndex, card, pegs, splitAmount, moveOptions)) {
      setNotice('Invalid move. Try again.');
      return false;
    }

    const cardInfo = CARD_VALUES[card.rank];

    // For 9 card splits, validate that a second peg can complete the split BEFORE executing the first move
    if (cardInfo.mustSplit && splitAmount !== null) {
      const remaining = splitAmount > 0 ? -(9 - splitAmount) : (9 - Math.abs(splitAmount));

      // Simulate the first move to get the intermediate state
      const { newPegs: afterFirstMove } = applyMove(owner, pegIndex, card, splitAmount, pegs, moveOptions);

      // The completing peg is normally the same owner, but a first half that
      // brings your last peg home hands the remainder to your partner.
      const completer = splitCompleter(owner, afterFirstMove, moveOptions);
      let hasValidSecondPeg = false;
      for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
        if (completer === owner && secondPeg === pegIndex) continue; // Must use a different peg
        if (isValidMove(completer, secondPeg, card, afterFirstMove, remaining, moveOptions)) {
          hasValidSecondPeg = true;
          break;
        }
      }

      if (!hasValidSecondPeg) {
        setNotice(`Cannot split: no other peg can move ${Math.abs(remaining)} ${remaining > 0 ? 'forward' : 'backward'}.`);
        return false;
      }
    }

    // For 7 card splits, validate that a second peg can complete the split BEFORE executing the first move
    if (cardInfo.canSplit && splitAmount !== null && splitAmount < 7) {
      const remaining = 7 - splitAmount;

      // Simulate the first move to get the intermediate state
      const { newPegs: afterFirstMove } = applyMove(owner, pegIndex, card, splitAmount, pegs, moveOptions);

      // The completing peg is normally the same owner, but a first half that
      // brings your last peg home hands the remainder to your partner.
      const completer = splitCompleter(owner, afterFirstMove, moveOptions);
      let hasValidSecondPeg = false;
      for (let secondPeg = 0; secondPeg < 5; secondPeg++) {
        if (completer === owner && secondPeg === pegIndex) continue; // Must use a different peg
        if (isValidMove(completer, secondPeg, card, afterFirstMove, remaining, moveOptions)) {
          hasValidSecondPeg = true;
          break;
        }
      }

      if (!hasValidSecondPeg) {
        setNotice(`Cannot split: no other peg can move the remaining ${remaining} spaces.`);
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
      setSplitOwner(owner); // and whose peg it was, so the completer collision check is owner-aware
      setSplitUndo({ pegs, lastMoves }); // pre-move board, so a mis-tap can be undone
      setSelectedPeg(null);
      setNotice(null); // the split prompt is part of the derived status line
      return true;
    }

    // Handle 9 card (must split forward/backward)
    if (cardInfo.mustSplit && splitAmount !== null) {
      const remaining = 9 - Math.abs(splitAmount);
      const direction = splitAmount > 0 ? 'backward' : 'forward';
      setSplitRemaining(splitAmount > 0 ? -remaining : remaining);
      setSplitCard(card);
      setSplitPegIndex(pegIndex); // Track which peg was moved first
      setSplitOwner(owner); // and whose peg it was, so the completer collision check is owner-aware
      setSplitUndo({ pegs, lastMoves }); // pre-move board, so a mis-tap can be undone
      setSelectedPeg(null);
      setNotice(null); // the split prompt is part of the derived status line
      return true;
    }

    const w = checkWinner(newPegs, gameMode);
    if (w !== null) {
      endGame(w, { winningSeat: actor, description: moveDescription });
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
    setSplitOwner(null);

    // Switch to next player
    const nextPlayer = (actor + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setNotice(null);

    return true;
  }, [pegs, hands, deck, discardPiles, stuckCounts, lastMoves, triggerMoveEffects, moveOptions, gameMode, mySeat, endGame]);

  const completeSplit = useCallback((pegIndex, amount) => {
    const actor = mySeat;
    const owner = controlledOwnerFor(pegs);
    // For both 7 and 9 cards, ensure different pegs are used — but only when the
    // completing peg is the same owner. A handoff split that finished your last
    // peg home plays the remainder on your partner's pegs, where a matching
    // index is a genuinely different peg.
    const cardInfo = CARD_VALUES[splitCard?.rank];
    if ((cardInfo?.mustSplit || cardInfo?.canSplit) && owner === splitOwner && pegIndex === splitPegIndex) {
      const cardName = cardInfo?.mustSplit ? 'Nine' : 'Seven';
      setNotice(`${cardName} card must use two different pegs. Try again.`);
      return false;
    }

    if (!isValidMove(owner, pegIndex, splitCard, pegs, amount, moveOptions)) {
      setNotice('Invalid move for split. Try again.');
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
      endGame(w, { winningSeat: actor, description: `Split: ${lastMoves[actor]}, ${secondMoveDesc}` });
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
    setSplitOwner(null);
    setSplitUndo(null);
    const nextPlayer = (actor + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setNotice(null);

    return true;
  }, [splitCard, splitPegIndex, splitOwner, pegs, hands, deck, discardPiles, stuckCounts, lastMoves, triggerMoveEffects, controlledOwnerFor, moveOptions, gameMode, mySeat, endGame]);

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
    setSplitOwner(null);
    setSplitUndo(null);
    setSelectedPeg(null); // keep the card selected so pegs re-glow for another try
    setNotice('Split undone. Select a peg to move.');
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

    // Log other seats' discards into the replay buffer too, so a stuck
    // opponent's turn is still accounted for when you watch the replay.
    if (!ownsSeat(player)) {
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

    setNotice(null);

    // Hand off. What just happened is already visible on the board — the
    // last-move label under the seat and its stuck counter — so nothing is
    // announced here. The old code posted three messages on 1200/1500 ms
    // timers, which then fired after a win had landed and overwrote the win
    // text; the status line derives itself now and there are no timers left to
    // outlive their turn.
    const nextPlayer = (player + 1) % 4;
    setCurrentPlayer(nextPlayer);
    if (!ownsSeat(player)) {
      aiProcessingRef.current = false; // Allow the next AI seat to process
    }
  }, [hands, deck, discardPiles, stuckCounts, pegs, triggerMoveEffects, recordReplayFrame, gameMode, ownsSeat]);

  // AI logic - drives the AI seats this client is responsible for
  useEffect(() => {
    if (isMyTurn || winner !== null) return;
    // Never drive a human seat. In solo every non-me seat is 'ai', so this is a
    // no-op there; in a remote game it stops this client from running the *other*
    // human's ('them') turn as if it were AI. (Package 4 narrows this further, to
    // simulate an AI chain only when it terminates at one of your own seats.)
    if (!isAISeat(seatOwners, currentPlayer)) return;
    if (aiProcessingRef.current) return; // Already processing this turn

    aiProcessingRef.current = true;
    const aiPlayer = currentPlayer;
    const nextPlayer = (currentPlayer + 1) % 4;

    const timer = setTimeout(() => {
      aiTimerRef.current = null;
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
          endGame(w, { winningSeat: aiPlayer, description: moveDescription });
          return true;
        }

        setCurrentPlayer(nextPlayer);
        aiProcessingRef.current = false;
        return false;
      };

      // Pick the best scored move for this hand
      const bestMove = findBestAIMove(aiPlayer, aiHand, pegs, { mode: gameMode });

      if (bestMove) {
        // `owner` is whose peg moves — the AI's own, or its partner's once the
        // AI has finished (partner mode).
        const owner = bestMove.owner;
        // The second half of a split may play on the partner (a handoff split
        // that brought the AI's last peg home); default to the same owner.
        const secondOwner = bestMove.secondOwner ?? owner;
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
            const secondOldPeg = afterFirst[secondOwner][bestMove.secondPeg];
            const secondNewPeg = bestMove.newPegs[secondOwner][bestMove.secondPeg];
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
          replaySegments.push({ owner: secondOwner, pegIndex: bestMove.secondPeg, card: bestMove.card, amount: bestMove.remaining, fromPegs: afterFirst, toPegs: bestMove.newPegs });
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
            // After first animation, animate second peg (may be the partner's)
            const afterFirstPegs = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
            animateMove(secondOwner, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, moverPeg);
            });
          });
        } else if (bestMove.type === 'split9') {
          // Two-part animation for 9 split
          animateMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg (may be the partner's)
            const afterFirstPegs = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
            animateMove(secondOwner, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
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
    aiTimerRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (aiTimerRef.current === timer) aiTimerRef.current = null;
      aiProcessingRef.current = false;
    };
  }, [currentPlayer, isMyTurn, winner, hands, pegs, deck, discardPiles, stuckCounts, discardAndDraw, animationsEnabled, animateMove, triggerMoveEffects, recordReplayFrame, gameMode, ownsSeat, endGame, seatOwners]);

  // Chime + gentle buzz when control passes back to a seat you own
  useEffect(() => {
    const prev = prevPlayerRef.current;
    if (isMyTurn && prev !== null && !ownsSeat(prev) && winner === null) {
      sfx.yourTurn();
    }
    prevPlayerRef.current = currentPlayer;
  }, [currentPlayer, isMyTurn, winner, ownsSeat]);

  // Count a completed turn each time control passes to a different player.
  // The winning move doesn't switch players, so it's added on at record time.
  useEffect(() => {
    if (winner !== null) return;
    if (prevTurnPlayerRef.current !== null && prevTurnPlayerRef.current !== currentPlayer) {
      turnsRef.current += 1;
    }
    prevTurnPlayerRef.current = currentPlayer;
  }, [currentPlayer, winner]);

  // Fanfare on win, descending tone on loss. Stats are NOT recorded here — a
  // transition-watching effect only fires for whoever happened to be looking,
  // which is wrong the moment a game can end on another device. endGame records
  // them from the terminal state instead.
  useEffect(() => {
    if (winner === null) return;
    if (didIWin(winner, gameMode, mySeats)) {
      sfx.win();
    } else {
      sfx.lose();
    }
  }, [winner, gameMode, mySeats]);

  // Persist the in-progress game after every committed change so a mobile tab
  // eviction (a phone call mid-game) doesn't lose it. Skip while a modal is up
  // or before cards are dealt, and clear the save once the game is over so we
  // never offer to resume a finished game.
  useEffect(() => {
    // The localStorage save is the source of truth for SOLO only, and there is
    // exactly one solo game. In a remote game the server row is the save, so
    // this effect must not overwrite the solo save with a remote board.
    if (session) return;
    if (showFirstPlayerModal || showResumeModal) return;
    if (isReplaying) return; // don't persist the rewound board during a replay
    if (!(hands[mySeat]?.length > 0)) return; // no game in progress yet
    if (winner !== null) {
      clearGame();
      return;
    }
    saveGame({
      gameId: gameIdRef.current,
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
      splitOwner,
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
    splitRemaining, splitCard, splitPegIndex, splitOwner, lastMoves, moveHistory,
    winner, showFirstPlayerModal, showResumeModal, gameMode, isReplaying, mySeat, session,
  ]);

  // The hand you play from — your own seat's, always (even in partner mode,
  // where your cards may move your partner's pegs).
  const myHand = hands[mySeat] ?? [];

  const selectedCardObj = selectedCard !== null ? myHand[selectedCard] ?? null : null;

  // --- Derived game phase and status ---
  //
  // `phase` is the single answer to "what is happening", and `statusLine` is how
  // it reads. Both are computed from state every render, so neither can go
  // stale and neither can be overwritten by a timer that outlived its turn.
  // Nothing sets them; `notice` carries the only genuinely transient text.
  const dealt = !showFirstPlayerModal && !showResumeModal && myHand.length > 0;

  const phase = useMemo(
    () => derivePhase({ winner, isReplaying, dealt, isMyTurn, currentPlayer, seatOwners }),
    [winner, isReplaying, dealt, isMyTurn, currentPlayer, seatOwners]
  );

  const statusLine = useMemo(
    () => describeStatus({
      phase, currentPlayer, splitRemaining, splitCard, jokerMode, discardMode, mode: gameMode,
    }),
    [phase, currentPlayer, splitRemaining, splitCard, jokerMode, discardMode, gameMode]
  );

  const outcome = useMemo(
    () => describeOutcome(winner, gameMode, mySeats),
    [winner, gameMode, mySeats]
  );

  // --- Lobby derivations ------------------------------------------------------
  // The lobby rows and the waiting-on-you badge come from a single listener's
  // metadata rows plus the device's local labels, so the list and the badge can
  // never disagree. "Your turn" is waitingOn === seat (see lobby.js), never
  // currentPlayer, which is always parked on an AI seat.
  const localGamesList = useMemo(
    () => loadLocalGames().games,
    [remoteMeta, showLobby, session, mpScreen]
  );
  const localById = useMemo(
    () => Object.fromEntries(localGamesList.map((g) => [g.id, g])),
    [localGamesList]
  );
  const lobbyRows = useMemo(
    () => buildRemoteRows(remoteMeta, { myUid, localById }),
    [remoteMeta, myUid, localById]
  );
  const waitingCount = useMemo(() => countWaitingOnMe(lobbyRows), [lobbyRows]);
  const liveRows = useMemo(() => lobbyRows.filter((r) => !r.finished), [lobbyRows]);
  const finishedRows = useMemo(() => lobbyRows.filter((r) => r.finished), [lobbyRows]);
  const soloSaveExists = useMemo(
    () => !session && !!loadGame(),
    [session, showLobby, winner]
  );
  // A guest who has opened a game the host hasn't dealt yet is simply waiting.
  const waitingForHostDeal = Boolean(
    session && session.seat === GUEST_SEAT && openMeta && openMeta.status === STATUS.LOBBY
  );

  // A notice answers the action that produced it, so it dies with the phase.
  const prevPhaseRef = useRef(null);
  useEffect(() => {
    if (prevPhaseRef.current !== null && prevPhaseRef.current !== phase) setNotice(null);
    prevPhaseRef.current = phase;
  }, [phase]);

  // Whose pegs the human is moving this turn (their own, or their partner's once
  // they've finished in partner mode).
  const controlledOwner = controlledOwnerFor(pegs);

  // Pegs the human can legally move right now (null = highlighting inactive).
  // During the second half of a split this is the set of pegs that can finish it.
  const movablePegSet = useMemo(() => {
    if (!isMyTurn || winner !== null || discardMode || jokerMode || isReplaying) return null;
    if (splitRemaining !== 0 && splitCard) {
      const set = new Set();
      for (let i = 0; i < 5; i++) {
        // Only the first peg is off-limits, and only when the completing peg is
        // the same owner (a cross-team handoff split uses the partner's pegs, so
        // a matching index there is a different peg).
        if (controlledOwner === splitOwner && i === splitPegIndex) continue;
        if (isValidMove(controlledOwner, i, splitCard, pegs, splitRemaining, moveOptions)) set.add(i);
      }
      return set;
    }
    if (!selectedCardObj) return null;
    return new Set(getMovablePegs(controlledOwner, selectedCardObj, pegs, moveOptions));
  }, [isMyTurn, winner, discardMode, jokerMode, isReplaying, splitRemaining, splitCard, splitPegIndex, splitOwner, selectedCardObj, pegs, controlledOwner, moveOptions]);

  // Tappable destination spaces for the selected peg with a 7 or 9 (ghost
  // circles on the board — tapping one picks that split amount)
  const ghostDestinations = useMemo(() => {
    if (!isMyTurn || winner !== null || jokerMode || discardMode || isReplaying) return [];
    if (splitRemaining !== 0 || !selectedCardObj || selectedPeg === null) return [];
    const info = CARD_VALUES[selectedCardObj.rank];
    if (!info.canSplit && !info.mustSplit) return [];
    return getValidDestinations(controlledOwner, selectedPeg, selectedCardObj, pegs, moveOptions);
  }, [isMyTurn, winner, jokerMode, discardMode, isReplaying, splitRemaining, selectedCardObj, selectedPeg, pegs, controlledOwner, moveOptions]);

  // Which cards in hand have at least one fully playable move (used to dim
  // dead cards; unlike hasAnyValidMove this requires splits to be completable)
  const playableCards = useMemo(() => {
    if (!isMyTurn || winner !== null) return myHand.map(() => true);
    return myHand.map(c => getMovablePegs(controlledOwner, c, pegs, moveOptions).length > 0);
  }, [isMyTurn, winner, myHand, pegs, controlledOwner, moveOptions]);

  const handleCardClick = (cardIndex) => {
    if (!isMyTurn || winner !== null || isReplaying) return;
    if (splitRemaining !== 0) return;
    unlockAudio();

    // In discard mode, clicking a card discards it
    if (discardMode) {
      discardAndDraw(mySeat, cardIndex);
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
    if (!isMyTurn || winner !== null || isReplaying) return;

    // In joker mode, clicking your own peg cancels the selection
    if (jokerMode && player === controlledOwner) {
      setJokerMode(false);
      setJokerSourcePeg(null);
      setSelectedPeg(null);
      setNotice(null);
      return;
    }

    if (player !== controlledOwner) return;

    if (splitRemaining !== 0) {
      const cardInfo = CARD_VALUES[splitCard?.rank];
      if (controlledOwner === splitOwner && pegIndex === splitPegIndex) {
        const cardName = cardInfo?.mustSplit ? 'Nine' : 'Seven';
        setNotice(`${cardName} card must use two different pegs. Try again.`);
        return;
      }
      if (movablePegSet && !movablePegSet.has(pegIndex)) {
        setNotice('That peg cannot finish the split. Tap a glowing peg.');
        return;
      }
      completeSplit(pegIndex, splitRemaining);
      return;
    }

    if (selectedCard === null) {
      setNotice('Select a card first.');
      return;
    }

    if (movablePegSet && !movablePegSet.has(pegIndex)) {
      setNotice('That peg has no legal move with this card. Glowing pegs can move.');
      return;
    }

    setSelectedPeg(pegIndex);
    const card = myHand[selectedCard];
    const cardInfo = CARD_VALUES[card.rank];

    // Handle Joker - enter selection mode for target
    if (cardInfo.isJoker) {
      setJokerMode(true);
      setJokerSourcePeg(pegIndex);
      setNotice(null); // the joker prompt is part of the derived status line
      return;
    }

    if ((cardInfo.canSplit || cardInfo.mustSplit) &&
        (pegs[controlledOwner][pegIndex].location === 'track' || pegs[controlledOwner][pegIndex].location === 'home')) {
      // 7s and 9s: tap one of the ghost destination spaces to pick the amount
      setNotice('Tap a pulsing space on the board to move this peg there.');
    } else {
      executeMove(controlledOwner, pegIndex, card);
    }
  };

  const handleJokerTarget = (targetPlayer, targetPegIndex) => {
    if (isReplaying) return;
    if (!jokerMode || jokerSourcePeg === null || selectedCard === null) return;
    const actor = mySeat;
    const owner = controlledOwnerFor(pegs);
    if (targetPlayer === owner) return; // Can't target the mover's own pegs

    const targetPeg = pegs[targetPlayer][targetPegIndex];
    if (targetPeg.location !== 'track') return; // Can only bump pegs on track

    const card = hands[actor][selectedCard];

    // Execute the joker via the engine so the partner friendly-bump rule applies.
    const { newPegs, bumped } = applyJoker(owner, jokerSourcePeg, targetPlayer, targetPegIndex, pegs, moveOptions);
    if (!bumped) {
      setNotice('That joker bump is not legal. Pick another target.');
      return;
    }

    // Record last move for Joker
    const friendly = gameMode === GAME_MODES.PARTNERS && sameTeam(targetPlayer, actor);
    const jokerDescription = friendly
      ? `Joker sent ${PLAYER_NAMES[targetPlayer]} to home stretch`
      : `Joker bumped ${PLAYER_NAMES[targetPlayer]}`;
    setLastMoves(prev => {
      const updated = [...prev];
      updated[actor] = jokerDescription;
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
      endGame(w, { winningSeat: actor, description: jokerDescription });
      return;
    }

    // Next player
    const nextPlayer = (actor + 1) % 4;
    setCurrentPlayer(nextPlayer);
    setNotice(null);
  };

  // Tap on a ghost destination circle: play the selected card with the amount
  // that lands the selected peg on that space
  const handleGhostClick = (dest) => {
    if (isReplaying) return;
    if (selectedCard === null || selectedPeg === null) return;
    const card = myHand[selectedCard];
    executeMove(controlledOwnerFor(pegs), selectedPeg, card, dest.amount);
  };

  const BOARD_SIZE = 400;
  const MARGIN = 40;

  const getTrackPosition = (trackIndex) => {
    const side = Math.floor(trackIndex / SPACES_PER_SIDE);
    const pos = trackIndex % SPACES_PER_SIDE;

    // Rotate the visual layout so YOUR seat is at the bottom. With mySeat = 0
    // this is the original (side + 2) % 4, so solo rendering is unchanged.
    const visualSide = visualSideFor(side, mySeat);

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

    // Rotate the visual layout so YOUR seat is at the bottom.
    const visualSide = visualSideFor(player, mySeat);

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

    // Rotate the visual layout so YOUR seat is at the bottom.
    const visualSide = visualSideFor(player, mySeat);

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
    if (ownsSeat(player)) return `You (${PLAYER_NAMES[player]})`;
    if (gameMode === GAME_MODES.PARTNERS) {
      return `${PLAYER_NAMES[player]} (${sameTeam(player, mySeat) ? 'Partner' : 'Opponent'})`;
    }
    return `${PLAYER_NAMES[player]} (${isAISeat(seatOwners, player) ? 'AI' : 'Player'})`;
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

      {/* My Games lobby. A modal overlay in the same style as the stats/resume
          modals — not a route. Populated by one subscribeMyGames listener, so it
          updates itself when a partner moves whether or not it is open. */}
      {showLobby && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-5 pb-3 border-b border-gray-700 sticky top-0 bg-gray-800">
              <h2 className="text-2xl font-bold">🎮 My Games</h2>
              <button
                onClick={() => setShowLobby(false)}
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-lg leading-none"
                aria-label="Close My Games"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3">
              {mpNotice && <div className="text-sm text-amber-300">{mpNotice}</div>}

              {/* Your solo game. */}
              <button
                onClick={() => switchToGame('solo')}
                className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${
                  !session ? 'bg-amber-700/60 ring-1 ring-amber-500' : 'bg-gray-700 hover:bg-gray-600'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="font-semibold">🧩 Solo vs AI</span>
                  <span className="text-xs text-gray-300">
                    {!session ? 'On screen' : soloSaveExists ? 'Resume' : 'New game'}
                  </span>
                </div>
              </button>

              {/* Remote games waiting on you sort first. */}
              {liveRows.map((row) => (
                <div
                  key={row.id}
                  className={`px-4 py-3 rounded-lg ${
                    session?.id === row.id
                      ? 'bg-teal-800/70 ring-1 ring-teal-400'
                      : row.yourTurn
                        ? 'bg-amber-700/50'
                        : 'bg-gray-700'
                  }`}
                >
                  <div className="flex justify-between items-center gap-2">
                    <button className="flex-1 text-left" onClick={() => switchToGame(row)}>
                      <div className="font-semibold truncate">{row.label}</div>
                      <div className="text-xs text-gray-300">
                        {row.lobby
                          ? 'Waiting for your partner to join…'
                          : row.yourTurn
                            ? '⏳ Your turn'
                            : `Waiting on partner · ${relativeTime(row.updatedAtMs)}`}
                      </div>
                    </button>
                    <button
                      onClick={() => archiveGame(row.id)}
                      className="text-xs px-2 py-1 rounded bg-gray-600 hover:bg-gray-500 flex-shrink-0"
                      aria-label={`Archive ${row.label}`}
                    >
                      Archive
                    </button>
                  </div>
                </div>
              ))}

              {/* Finished games, collapsed. */}
              {finishedRows.length > 0 && (
                <details className="bg-gray-700/40 rounded-lg px-4 py-2">
                  <summary className="cursor-pointer text-sm text-gray-300">
                    Finished games ({finishedRows.length})
                  </summary>
                  <div className="mt-2 space-y-2">
                    {finishedRows.map((row) => (
                      <div key={row.id} className="flex justify-between items-center text-sm">
                        <button className="text-left flex-1 truncate" onClick={() => switchToGame(row)}>
                          {row.label} — over
                        </button>
                        <button
                          onClick={() => archiveGame(row.id)}
                          className="text-xs px-2 py-1 rounded bg-gray-600 hover:bg-gray-500"
                        >
                          Archive
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Start a new game. */}
              <div className="border-t border-gray-700 pt-4 space-y-2">
                <div className="text-sm text-gray-400">Start a new game</div>
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  placeholder="Partner's name (optional)"
                  className="w-full px-3 py-2 rounded bg-gray-700 text-white placeholder-gray-500"
                />
                <button
                  disabled={mpBusy}
                  onClick={() => { unlockAudio(); hostNewGame(labelInput); }}
                  className="w-full px-4 py-3 bg-teal-600 hover:bg-teal-700 rounded-lg font-semibold disabled:opacity-50"
                >
                  ➕ Create game & get a code
                </button>
              </div>

              {/* Join by code. */}
              <div className="border-t border-gray-700 pt-4 space-y-2">
                <div className="text-sm text-gray-400">Join with a code</div>
                <input
                  type="text"
                  value={joinInput}
                  onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                  placeholder="6-character code"
                  maxLength={8}
                  className="w-full px-3 py-2 rounded bg-gray-700 text-white placeholder-gray-500 tracking-widest"
                />
                <button
                  disabled={mpBusy || !joinInput.trim()}
                  onClick={() => { unlockAudio(); beginJoin(joinInput, { label: labelInput }); }}
                  className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold disabled:opacity-50"
                >
                  🔑 Join game
                </button>
              </div>

              <p className="text-xs text-gray-500 pt-2">
                Games live on this device. Clearing site data loses access to
                games in progress.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Hosting: the code + share link, waiting for a partner to join. The
          metadata listener deals automatically the moment they do. */}
      {hostInfo && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 text-center">
            <h2 className="text-2xl font-bold mb-2">Waiting for your partner…</h2>
            <p className="text-gray-300 mb-5 text-sm">
              Share the code or the link. The game deals itself the moment they join.
            </p>
            <div className="bg-gray-900 rounded-lg py-4 mb-4">
              <div className="text-xs text-gray-400 mb-1">Game code</div>
              <div className="text-4xl font-bold tracking-[0.3em]">{hostInfo.code}</div>
            </div>
            <button
              onClick={() => {
                if (navigator.clipboard) navigator.clipboard.writeText(hostInfo.link).catch(() => {});
                setMpNotice('Link copied.');
              }}
              className="w-full px-4 py-3 bg-teal-600 hover:bg-teal-700 rounded-lg font-semibold mb-3"
            >
              📋 Copy invite link
            </button>
            <div className="text-xs text-gray-500 break-all mb-5">{hostInfo.link}</div>
            <div className="flex items-center justify-center gap-2 text-gray-300 mb-5">
              <span className="inline-block w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
              Waiting…
            </div>
            <button
              onClick={() => { setHostInfo(null); switchToGame('solo'); }}
              className="text-sm text-gray-400 hover:text-gray-200"
            >
              Cancel and return to solo
            </button>
          </div>
        </div>
      )}

      {/* A guest who opened a game the host hasn't dealt yet. */}
      {waitingForHostDeal && !hostInfo && !showLobby && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-40 p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 text-center">
            <h2 className="text-xl font-bold mb-2">You're in!</h2>
            <p className="text-gray-300 mb-5 text-sm">
              Waiting for the host to deal. The board appears as soon as they do.
            </p>
            <div className="flex items-center justify-center gap-2 text-gray-300 mb-5">
              <span className="inline-block w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
              Waiting…
            </div>
            <button
              onClick={() => setShowLobby(true)}
              className="text-sm text-gray-400 hover:text-gray-200"
            >
              My Games
            </button>
          </div>
        </div>
      )}

      {/* Resume Saved Game Modal */}
      {showResumeModal && pendingResume && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-3 text-center">Resume game?</h2>
            <p className="text-center text-gray-300 mb-6">
              You have a game in progress
              {ownsSeat(pendingResume.currentPlayer) ? (
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
                {multiplayerConfigured && (
                  <button
                    onClick={() => { unlockAudio(); setMpNotice(null); setShowFirstPlayerModal(false); setShowLobby(true); }}
                    className="w-full px-6 py-4 bg-teal-600 hover:bg-teal-700 rounded-lg text-lg font-semibold transition-colors"
                  >
                    🎮 Play with a Friend
                  </button>
                )}
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

      {/* End-of-game overlay. Replaces the old inline green banner, which
          rendered independently of the status line and so could sit above a
          stale "Blue is thinking…". */}
      {winner !== null && outcome && !endOverlayDismissed && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto p-6">
            <h2 className={`text-3xl font-bold mb-1 text-center ${outcome.won ? 'text-green-400' : 'text-gray-200'}`}>
              {outcome.won ? '🎉 ' : ''}{outcome.text}
            </h2>
            <p className="text-center text-sm text-gray-400 mb-5">
              {gameMode === GAME_MODES.PARTNERS ? 'Partner game' : 'Classic game'}
            </p>

            {/* The winning move. Worth spelling out because remotely the game
                can end on a move you never saw happen. */}
            {endInfo?.description && (
              <div className="bg-gray-700/50 rounded-lg px-4 py-3 mb-5">
                <div className="text-xs text-gray-400 mb-1">Winning move</div>
                <div className="text-sm">
                  <span
                    className="font-semibold"
                    style={{ color: PLAYER_COLORS[endInfo.winningSeat ?? 0] }}
                  >
                    {endInfo.winningSeat !== null && ownsSeat(endInfo.winningSeat)
                      ? `You (${PLAYER_NAMES[endInfo.winningSeat]})`
                      : PLAYER_NAMES[endInfo.winningSeat ?? 0]}
                  </span>
                  <span className="text-gray-200"> — {endInfo.description}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-4 gap-2 mb-5 text-center">
              <div className="bg-gray-700 rounded-lg p-2">
                <div className="text-lg font-bold">{endInfo?.turns ?? 0}</div>
                <div className="text-[10px] text-gray-400">Turns</div>
              </div>
              <div className="bg-gray-700 rounded-lg p-2">
                <div className="text-lg font-bold">{endInfo?.jokersPlayed ?? 0}</div>
                <div className="text-[10px] text-gray-400">Jokers</div>
              </div>
              <div className="bg-gray-700 rounded-lg p-2">
                <div className="text-lg font-bold text-green-400">{endInfo?.bumpsDelivered ?? 0}</div>
                <div className="text-[10px] text-gray-400">Bumps</div>
              </div>
              <div className="bg-gray-700 rounded-lg p-2">
                <div className="text-lg font-bold text-red-400">{endInfo?.timesBumped ?? 0}</div>
                <div className="text-[10px] text-gray-400">Bumped</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-6 text-center">
              <div className="bg-gray-700/50 rounded-lg p-2">
                <div className="text-lg font-bold">{stats.gamesPlayed}</div>
                <div className="text-[10px] text-gray-400">Games</div>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-2">
                <div className="text-lg font-bold text-amber-400">{Math.round(winRate(stats) * 100)}%</div>
                <div className="text-[10px] text-gray-400">Win rate</div>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-2">
                <div className={`text-lg font-bold ${stats.currentStreak > 0 ? 'text-green-400' : stats.currentStreak < 0 ? 'text-red-400' : ''}`}>
                  {formatStreak(stats.currentStreak)}
                </div>
                <div className="text-[10px] text-gray-400">Streak</div>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => {
                  unlockAudio();
                  startModeRef.current = 'chosen';
                  startGameWithPlayer(mySeat);
                }}
                className="w-full px-6 py-3 bg-amber-600 hover:bg-amber-700 rounded-lg font-semibold transition-colors"
              >
                Rematch
              </button>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={startNewSoloGame}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-semibold transition-colors"
                >
                  New Game
                </button>
                <button
                  onClick={() => setShowStats(true)}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm font-semibold transition-colors"
                >
                  📊 Stats
                </button>
                <button
                  onClick={() => setEndOverlayDismissed(true)}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg text-sm font-semibold transition-colors"
                >
                  View board
                </button>
              </div>
            </div>
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
            {multiplayerConfigured && (
              <button
                onClick={() => setShowLobby(true)}
                className="relative px-4 py-2 bg-teal-600 rounded hover:bg-teal-700"
              >
                🎮 My Games
                {waitingCount > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 flex items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-gray-900"
                    aria-label={`${waitingCount} games waiting on you`}
                  >
                    {waitingCount}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => setShowStats(true)}
              className="px-4 py-2 bg-indigo-600 rounded hover:bg-indigo-700"
            >
              📊 Stats
            </button>
            <button
              onClick={startNewSoloGame}
              className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
            >
              New Game
            </button>
          </div>
        </div>

        {/* The status line is derived from `phase` — it can never be stale, and
            in particular never reads "Blue is thinking…" after the game ends.
            `notice` sits under it for transient feedback and clears itself on
            the next phase change. */}
        <div className="text-center mb-4 p-2 bg-gray-800 rounded">
          <div>{statusLine}</div>
          {notice && <div className="text-sm text-amber-300 mt-1">{notice}</div>}
          {phase === PHASES.FINISHED && endOverlayDismissed && (
            <button
              onClick={() => setEndOverlayDismissed(false)}
              className="mt-2 px-3 py-1 bg-amber-600 hover:bg-amber-700 rounded text-sm font-semibold"
            >
              🏁 Show result
            </button>
          )}
        </div>

        {/* Undo a mis-tapped split: only available between the two halves of a
            split, before the second peg commits the move */}
        {splitUndo && splitRemaining !== 0 && isMyTurn && winner === null && !isReplaying && (
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
        {!isReplaying && replayReady > 0 && isMyTurn && winner === null && (
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
                    const isClickable = isMyTurn && player === controlledOwner && hasPeg && !jokerMode;
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
                    const isClickable = isMyTurn && player === controlledOwner && hasPeg && i < 4 && !jokerMode;
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
                  const isClickable = isMyTurn && (player === controlledOwner || isJokerTarget);
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
                            setNotice(null);
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
                // Discard piles sit in the corners around the centre draw pile,
                // indexed by *visual side* so they follow the board rotation.
                const positions = [
                  { x: 130, y: 140 },  // top side - top-left of center
                  { x: 220, y: 140 },  // right side - top-right of center
                  { x: 220, y: 240 },  // bottom side (yours) - bottom-right of center
                  { x: 130, y: 240 }   // left side - bottom-left of center
                ];
                const pos = positions[visualSideFor(player, mySeat)];
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

              {/* Labels with last move, placed by visual side so YOUR seat is
                  always the one at the bottom */}
              {(() => {
                const top = seatAtVisualSide(0, mySeat);
                const right = seatAtVisualSide(1, mySeat);
                const bottom = seatAtVisualSide(2, mySeat);
                const left = seatAtVisualSide(3, mySeat);
                return (
                  <>
                    <g>
                      <text x="200" y="20" textAnchor="middle" fill={PLAYER_COLORS[top]} fontSize="11" fontWeight="bold">{roleLabel(top)}</text>
                      {lastMoves[top] && <text x="200" y="31" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[top]}</text>}
                    </g>
                    <g transform="rotate(90 378 205)">
                      <text x="378" y="200" textAnchor="middle" fill={PLAYER_COLORS[right]} fontSize="11" fontWeight="bold">{roleLabel(right)}</text>
                      {lastMoves[right] && <text x="378" y="211" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[right]}</text>}
                    </g>
                    <g>
                      <text x="200" y="383" textAnchor="middle" fill={PLAYER_COLORS[bottom]} fontSize="11" fontWeight="bold">{roleLabel(bottom)}</text>
                      {lastMoves[bottom] && <text x="200" y="394" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[bottom]}</text>}
                    </g>
                    <g transform="rotate(-90 22 205)">
                      <text x="22" y="200" textAnchor="middle" fill={PLAYER_COLORS[left]} fontSize="11" fontWeight="bold">{roleLabel(left)}</text>
                      {lastMoves[left] && <text x="22" y="211" textAnchor="middle" fill="#9CA3AF" fontSize="8">{lastMoves[left]}</text>}
                    </g>
                  </>
                );
              })()}
            </svg>
          </div>

          {/* Hand and Controls */}
          <div className="flex-1 w-full lg:w-auto">
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">Your Hand:</h3>
              <div className="flex gap-2 flex-wrap">
                {myHand.map((card, i) => renderCard(card, i, i === selectedCard, playableCards[i]))}
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
                    setNotice(null);
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
                    setNotice(null);
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
            {isMyTurn && !jokerMode && !splitRemaining && !discardMode && !isReplaying && myHand.length > 0 && !playableCards.some(Boolean) && (
              <div className="mb-4">
                <div>
                  <button
                    onClick={() => {
                      setDiscardMode(true);
                      setSelectedCard(null);
                      setSelectedPeg(null);
                      setNotice(null);
                    }}
                    className="px-4 py-2 bg-red-600 rounded hover:bg-red-700 font-bold"
                  >
                    No Valid Move - Select Card to Discard {stuckCounts[mySeat] > 0 && `(${stuckCounts[mySeat]}/3)`}
                  </button>
                  {stuckCounts[mySeat] === 2 && (
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
