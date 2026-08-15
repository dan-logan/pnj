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
import { PHASES, derivePhase, describeStatusParts, describeOutcome, attributeFrameDescription } from './game/status.js';
import {
  SOLO_SEAT_OWNERS,
  HOST_SEAT_OWNERS,
  remoteSeatOwners,
  mySeatsOf,
  primarySeat,
  isMyTurnFor,
  isAISeat,
  nextHumanSeat,
  shouldSimulateAI,
  visualSideFor,
  seatAtVisualSide,
} from './net/seats.js';
import { seedReplay, appendReplayFrame } from './net/replay.js';
import {
  isMultiplayerConfigured,
  signIn,
  createGame,
  joinGame,
  joinGameById,
  fetchGame,
  startGame,
  publishState,
  VersionConflict,
  subscribeGameMeta,
  subscribeGameState,
  subscribeMyGames,
} from './net/session.js';
import { STATUS, HOST_SEAT, GUEST_SEAT } from './net/protocol.js';
import {
  loadLocalGames,
  emptyLocalGames,
  hasLocalGames,
  upsertLocalGame,
  archiveLocalGame,
  getLocalGame,
  setActiveId,
} from './net/localSession.js';
import {
  bootTargetFor,
  buildRemoteRows,
  countWaitingOnMe,
  openActionFor,
  relativeTime,
  seatForUid,
} from './net/lobby.js';
import InstallPrompt from './InstallPrompt.jsx';
import { sfx, isMuted, setMuted, unlockAudio } from './audio.js';
import { syncAppBadge } from './badge.js';
import { diffPegEvents } from './game/events.js';
import {
  announcementsFor,
  isSpecialPlay,
  ANNOUNCEMENTS,
  ANNOUNCE_MS,
  TAUNT_MS,
  TAUNT_TEXT,
  THANKS_TEXT,
  WELCOME_TEXT,
  GLOAT_TEXT,
  REPLY_MS,
} from './game/announce.js';
import {
  DEFAULT_SPEED,
  settingsFor,
  animationsOn,
  nextSpeed,
  loadSpeed,
  saveSpeed,
  stageBumpFlights,
  specialPlayHoldMs,
  BUMP_FLY_STEPS,
  BUMP_FLY_TICK_MS,
  JOKER_CARD_MS,
  JOKER_CARD_HOLD_MS,
} from './anim.js';

// Instant-replay pacing. Deliberately slower than the live step so a round of
// AI moves is easy to follow when it's played back. The per-step figure is the
// live one from the speed setting, floored so a replay is never *faster* than
// a slow live move (see `replayStepMs`).
const REPLAY_MIN_STEP_MS = 280; // per-step floor while a peg animates during replay
const REPLAY_LEADIN_MS = 320;   // beat on the "before" board so the start registers
const REPLAY_FRAME_PAUSE_MS = 600; // pause after each move before the next one

// Discard piles sit in the corners around the centre draw pile, indexed by
// *visual side* so they follow the board rotation. Module-level because the
// played-card overlay flies its card to the same slot the pile is drawn in —
// two copies of these numbers would drift.
const DISCARD_SLOTS = [
  { x: 130, y: 140 },  // top side - top-left of center
  { x: 220, y: 140 },  // right side - top-right of center
  { x: 220, y: 240 },  // bottom side (yours) - bottom-right of center
  { x: 130, y: 240 },  // left side - bottom-left of center
];
const DISCARD_CARD_W = 22;
const DISCARD_CARD_H = 30;

// The played-card overlay: a big card centred over the middle of the board,
// with its caption in the clear space above it. The card does cross the discard
// piles, which is the point — that is where it is going. `cy` is duplicated as
// the `transform-origin` of `.pnj-card-play` in index.css (CSS can't read it
// from here), so the two move together.
const PLAYED_CARD = { w: 44, h: 60, cx: 200, cy: 140 };
// How long the card takes to pop up, hold and drop onto the pile. Scaled to the
// move it belongs to (see `lifeMs`), between these two.
const PLAYED_CARD_MIN_MS = 550;
const PLAYED_CARD_MAX_MS = 1500;

// The ?g= invite link for a game. Needed both when a game is created and when
// its host reopens it while still waiting for a partner to join.
function inviteLinkFor(id) {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}?g=${id}`;
}

export default function PegsAndJokers() {
  const [gameMode, setGameModeState] = useState(GAME_MODES.CLASSIC);

  // Who owns each seat from THIS client's point of view. Solo is the layout
  // where seat 0 is the only non-AI seat; remote play swaps one AI seat for
  // 'them' and (for the guest) moves 'me' to seat 2. Nothing below may assume
  // "the local human is player 0" — derive from here instead.
  const [seatOwners, setSeatOwnersState] = useState(SOLO_SEAT_OWNERS);

  // Refs mirroring the two values above, for the same reason sessionRef mirrors
  // session: which mode is being played and which seats are mine are *identity*
  // facts that async code must read as of now, not as of the render that
  // created it. Opening a remote game sets both and then awaits a fetch, so a
  // callback holding last render's `gameMode`/`mySeats` sees "classic, seat 0" —
  // which is how a partner win adopted on open got filed under Solo. Always
  // write through the wrappers so state and ref move together.
  const gameModeRef = useRef(GAME_MODES.CLASSIC);
  const seatOwnersRef = useRef(SOLO_SEAT_OWNERS);
  const mySeatsRef = useRef(mySeatsOf(SOLO_SEAT_OWNERS));
  const setGameMode = useCallback((mode) => {
    gameModeRef.current = mode;
    setGameModeState(mode);
  }, []);
  const setSeatOwners = useCallback((owners) => {
    seatOwnersRef.current = owners;
    mySeatsRef.current = mySeatsOf(owners);
    setSeatOwnersState(owners);
  }, []);

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
  const [lastMoves, setLastMoves] = useState([null, null, null, null]); // Last move description per player

  // Replaces every `currentPlayer === 0` turn gate in the component.
  const isMyTurn = isMyTurnFor(seatOwners, currentPlayer);

  const aiProcessingRef = useRef(false); // Prevent AI from running twice on same turn
  const aiTimerRef = useRef(null); // the AI's "thinking" timeout, so endGame can cancel it
  const prevPlayerRef = useRef(null); // Detect the turn passing back to the human

  // Animation state. The pace is a four-way setting (`src/anim.js`), not a
  // boolean: `slow` is the default because a peg that crosses the board faster
  // than you can follow it is the single biggest reason the game is hard to
  // read. `animationsEnabled` is derived from it so every existing "are
  // animations on?" question still has one answer.
  const [animationSpeed, setAnimationSpeedState] = useState(DEFAULT_SPEED);
  const animationsEnabled = animationsOn(animationSpeed);
  const pacing = settingsFor(animationSpeed);
  // { player, pegIndex, path: [], currentStep, from, count } — `from` is the
  // space the peg left, so the board can leave a ghost behind it, and the
  // traversed prefix of `path` is drawn as a fading trail.
  const [animatingPeg, setAnimatingPeg] = useState(null);
  const animationRef = useRef(null);
  // A purely cosmetic playback of a move whose state has *already* committed
  // (see `playMoveVisual`). The AI effect waits on it so an opponent doesn't
  // start moving while your own peg is still counting itself along the board.
  const [visualBusy, setVisualBusy] = useState(false);
  const settleTimerRef = useRef(null);
  // Arrival chimes deferred to the end of a cosmetic playback (see
  // triggerMoveEffects). Held so a win, a new game or a game switch can cancel
  // them — a "peg is home" chime that fires after the result banner is exactly
  // the class of stale-timer bug the status rewrite got rid of.
  const arrivalTimersRef = useRef([]);

  // The mover, the card they played and what it did, drawn *over the board*
  // while the move animates (see the played-card overlay in the render). It
  // used to be a bordered box in the page flow above the board, which on a
  // phone pushed the whole screen down every time an opponent moved and pulled
  // it back up a second later — the jump was more distracting than the
  // information was useful. An overlay costs no layout at all.
  const [nowPlaying, setNowPlaying] = useState(null); // { id, player, card, description, lifeMs }
  const nowPlayingSeqRef = useRef(0);

  // Every move gets its own id so the overlay's entrance/fly-to-the-pile
  // animation replays for each one — two identical moves in a row would
  // otherwise reuse the same DOM node and animate only once.
  //
  // `lifeMs` is how long this move will be on screen (travel + settle). The
  // card's flight to the discard pile is scaled to fit inside it: the overlay
  // is unmounted the moment the move ends, so a fixed flight would leave a
  // one-space move's card hanging in mid-air halfway to the pile, and a card
  // that vanishes instead of landing is worse than one that never moved.
  const showNowPlaying = useCallback((meta) => {
    nowPlayingSeqRef.current += 1;
    setNowPlaying({ ...meta, id: nowPlayingSeqRef.current });
  }, []);

  // Load the saved pace once on mount rather than in a useState initialiser, so
  // the module stays safe to import where there is no localStorage.
  useEffect(() => {
    setAnimationSpeedState(loadSpeed());
  }, []);

  const setAnimationSpeed = useCallback((speed) => {
    setAnimationSpeedState(speed);
    saveSpeed(speed);
  }, []);

  // Sound / haptics
  const [soundOn, setSoundOn] = useState(() => !isMuted());

  // Player statistics (persisted to localStorage)
  const [stats, setStats] = useState(() => loadStats());
  const [showStats, setShowStats] = useState(false);

  // Per-game tallies, folded into stats when the game ends. Refs so updating
  // them mid-turn never triggers a re-render.
  //
  // `turnsRef` is a plain shared counter, incremented once per seat that
  // actually moves (Package 4's turn-counter fix) — directly at each site that
  // ends a turn, not by watching `currentPlayer` for a transition. The old
  // transition-watching effect miscounted the moment a remote state could jump
  // `currentPlayer` by more than one seat in a single adopt (and counted
  // differently on each client, since each only sees its own transitions).
  //
  // jokersPlayed/bumpsDelivered/timesBumped are per-seat arrays [n0,n1,n2,n3],
  // not personal totals — see the comment on serializeGame's tallies in
  // persistence.js for why. Whichever client actually simulates a seat's move
  // records it at that seat's index; stats-record time sums over `mySeats`.
  const turnsRef = useRef(0);
  const jokersPlayedRef = useRef([0, 0, 0, 0]);
  const bumpsDeliveredRef = useRef([0, 0, 0, 0]);
  const timesBumpedRef = useRef([0, 0, 0, 0]);
  const startModeRef = useRef('chosen'); // 'chosen' | 'random' | null (remote)
  // Every game has an id (a fresh uuid locally, the server row id remotely).
  // Stats are recorded against it, so a game can only ever be counted once
  // however many times its end is observed.
  const gameIdRef = useRef(null);
  const endedRef = useRef(false); // guard against a second terminal transition

  // Bump fly-back animation:
  // { holding: bool, tick: number, items: [{ player, pegIndex, from, to, kind,
  //   startTick, onImpact }] }
  //
  // A *list*, because one card can displace more than one peg — a partner bump
  // onto an entrance an opponent is sitting on moves both of them — and the
  // move that displaces two is exactly the move you are most likely to miss.
  // All of them run off the shared `tick`, staggered by `startTick` so the
  // chain reads in causal order (see stageBumpFlights in anim.js).
  //
  // `holding` is the wait before impact. A human move commits its state before
  // the cosmetic glide runs (see playMoveVisual), so the bumped peg is already
  // sitting in its start slot while the peg that bumped it is still counting its
  // way across the board. During the hold the bumped peg is drawn — unchanged,
  // no glow — on the space it still visually occupies, and it is not knocked
  // anywhere until the mover actually arrives on it. The same is true of a peg
  // waiting for its turn in the chain: until its own `startTick` comes round it
  // sits, unglowed, where the board says it no longer is.
  const [bumpFx, setBumpFx] = useState(null);
  const bumpFxRef = useRef(null);      // the fly-back interval
  const bumpHoldRef = useRef(null);    // the pre-impact hold timeout

  // The three things a move can shout about (game/announce.js): "Joker!",
  // "Partner Bump!", "Double Play!". A list rather than one slot, because a
  // single card can legitimately trigger all three and the alternative —
  // last-one-wins — would drop exactly the flashiest move in the game down to
  // one message. They stack, newest at the bottom, each expiring on its own
  // timer.
  const [announcements, setAnnouncements] = useState([]); // [{ id, kind, text, color }]
  const announceSeqRef = useRef(0);
  const announceTimersRef = useRef([]);

  // Cartoon speech bubbles over pegs: the "@$#*!" of a peg knocked back to
  // start, and the "Thanks!" / "You're welcome!" a partner bump earns.
  // [{ id, player, text, spot }], where `spot` is symbolic — `{ area: 'start',
  // pegIndex }` or `{ area: 'track', position }` — and resolved to coordinates
  // at render time, so the bubbles follow the board rotation for free. A list
  // for the same reason the fly-back is: one card can displace two pegs, and
  // both of them have something to say about it.
  const [speechBubbles, setSpeechBubbles] = useState([]);
  const tauntTimersRef = useRef([]);

  // Show a batch of announcements, optionally deferred to the moment the
  // mover's peg actually lands — the same `landingDelayMs` discipline the
  // arrival chimes and the bump fly-back already use. A human move commits its
  // state before its cosmetic glide runs, so an undeferred "Double Play!" would
  // flash while the peg that caused it was still two-thirds of the way across
  // the board.
  const announce = useCallback((items, delayMs = 0) => {
    if (!items || items.length === 0) return;
    const show = () => {
      const entries = items.map((item) => {
        announceSeqRef.current += 1;
        return { ...item, id: announceSeqRef.current };
      });
      setAnnouncements(prev => [...prev, ...entries]);
      // The fanfare belongs to the banner, not to the move, so it is fired
      // from the same place the banner appears — the `onImpact` discipline
      // again: one timer, so sound and picture can't drift apart.
      if (entries.some(e => e.kind === ANNOUNCEMENTS.doublePlay.kind)) sfx.fanfare();
      const ids = new Set(entries.map(e => e.id));
      const expiry = setTimeout(() => {
        announceTimersRef.current = announceTimersRef.current.filter(t => t !== expiry);
        setAnnouncements(prev => prev.filter(a => !ids.has(a.id)));
      }, ANNOUNCE_MS);
      announceTimersRef.current.push(expiry);
    };
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        announceTimersRef.current = announceTimersRef.current.filter(t => t !== timer);
        show();
      }, delayMs);
      announceTimersRef.current.push(timer);
    } else {
      show();
    }
  }, []);

  // Put a bubble over a peg. Every caller fires this as a peg's flight *ends*
  // rather than at impact: what a peg has to say belongs over where it comes to
  // rest, and at impact it is still in mid-air. `delayMs` is only used for the
  // "You're welcome!" reply, which has to wait its turn.
  const showBubble = useCallback(({ player, text, spot, delayMs = 0, onShow = null }) => {
    announceSeqRef.current += 1;
    const id = announceSeqRef.current;
    const show = () => {
      setSpeechBubbles(prev => [...prev, { id, player, text, spot }]);
      if (onShow) onShow();
      const expiry = setTimeout(() => {
        tauntTimersRef.current = tauntTimersRef.current.filter(t => t !== expiry);
        setSpeechBubbles(prev => prev.filter(b => b.id !== id));
      }, TAUNT_MS);
      tauntTimersRef.current.push(expiry);
    };
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        tauntTimersRef.current = tauntTimersRef.current.filter(t => t !== timer);
        show();
      }, delayMs);
      tauntTimersRef.current.push(timer);
    } else {
      show();
    }
  }, []);

  // The knocked-back peg's cartoon curse, over the start slot it was sent to.
  const showBumpTaunt = useCallback((player, pegIndex) => {
    showBubble({
      player,
      text: TAUNT_TEXT,
      spot: { area: 'start', pegIndex },
      onShow: () => sfx.grumble(player),
    });
  }, [showBubble]);

  // The other half of a knock-back: the peg that did it, sniggering from
  // wherever the move left it. A beat after the victim's "@$#*!", so the two
  // read as an exchange — and skipped entirely when the culprit can't be placed
  // on the board (a come-out bump by a peg still being drawn, say), since a
  // bubble with nothing under it is worse than no bubble.
  const showGloat = useCallback((bumper) => {
    if (!bumper) return;
    showBubble({
      player: bumper.player,
      text: GLOAT_TEXT,
      spot: { area: 'track', position: bumper.position },
      delayMs: REPLY_MS,
      onShow: () => sfx.snicker(bumper.player),
    });
  }, [showBubble]);

  // The partner-bump exchange. `thanks` is the peg that was carried to its own
  // home entrance; `welcome` is whichever peg put it there — the mover in an
  // ordinary friendly bump, and the *partner that stayed put* in the entrance
  // swap, where the mover is the one getting the free ride. Both bubbles sit
  // over track spaces (a friendly bump never ends anywhere else), and the reply
  // comes a beat later so the two read as an exchange.
  const showPartnerThanks = useCallback((thanks, welcome) => {
    showBubble({
      player: thanks.player, text: THANKS_TEXT,
      spot: { area: 'track', position: thanks.position },
    });
    if (welcome) {
      showBubble({
        player: welcome.player, text: WELCOME_TEXT,
        spot: { area: 'track', position: welcome.position },
        delayMs: REPLY_MS,
      });
    }
  }, [showBubble]);

  // Every overlay is a timer, and a timer that outlives its game is the same
  // class of bug as the status-line timers that used to print "Blue is
  // thinking…" under a win banner. So this is called from every place that
  // cancels the animation and bump timers: endGame, a new game, a board clear,
  // adopting a save, and unmount.
  const clearAnnouncements = useCallback(() => {
    announceTimersRef.current.forEach(clearTimeout);
    announceTimersRef.current = [];
    tauntTimersRef.current.forEach(clearTimeout);
    tauntTimersRef.current = [];
    setAnnouncements([]);
    setSpeechBubbles([]);
  }, []);

  // Instant replay: a buffer of the AI moves made since your last turn, plus the
  // playback state. Frames live in a ref (they hold peg snapshots and don't need
  // to trigger renders); `replayReady` mirrors the count so the button can show.
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayInfo, setReplayInfo] = useState(null); // { player, description, index, total }
  const [replayReady, setReplayReady] = useState(0);
  const replayLogRef = useRef([]);        // recorded frames for the current round
  // Frames THIS client has itself simulated since it last adopted a wire seed
  // — a subset of replayLogRef, which also holds the seed (the frames adopted
  // from the wire). Publishing must use only this: the seed is always the
  // *recipient's own earlier move(s)*, since with exactly two humans strictly
  // alternating publishes, whoever I'm about to publish to is exactly whoever
  // my current seed originated from. Reusing replayLogRef (seed + own) for the
  // wire re-forwards the recipient's own move back to them, and the next hop
  // does it again — the buffer grows every round and eventually "replays the
  // whole game". See commitTurn.
  const replayOwnRef = useRef([]);
  const replayCancelRef = useRef(false);  // set to abort an in-flight replay
  const replaySegTimerRef = useRef(null); // per-step interval
  const replayFrameTimerRef = useRef(null); // between-frame / lead-in timeout
  const replayRestoreRef = useRef(null);  // true current board, restored when replay ends
  const replayPrevPlayerRef = useRef(0);  // detect the human handing off to start a fresh round
  // Package 5: set when a remote state is adopted, so the buffer (wire frames,
  // then whatever this client simulates locally) auto-plays once it becomes
  // this client's turn — or once the game ends, if the win happened during
  // silent AI simulation and control never actually reaches this seat. Cleared
  // the moment the auto-play effect consumes it.
  const pendingAutoReplayRef = useRef(false);

  // Append an AI move to the replay buffer. Peg snapshots are immutable (the
  // engine never mutates), so storing references is safe.
  // A reactive mirror of replayLogRef's descriptions, for the text summary
  // shown in place of auto-play when animations are disabled (§5.2) — the
  // buffer itself lives in a ref (no re-render on every AI frame), so this is
  // the one place its contents become visible to render.
  const [replayDescriptions, setReplayDescriptions] = useState([]);

  // Called only for a move THIS client is simulating (an AI move, or another
  // seat's stuck discard) — never for this client's own move, which builds a
  // frame and hands it straight to commitTurn. So every call here is, by
  // construction, new-since-the-seed: append to both the full display buffer
  // and the wire-only "own" buffer.
  const recordReplayFrame = useCallback((frame) => {
    replayLogRef.current = appendReplayFrame(replayLogRef.current, frame);
    replayOwnRef.current = appendReplayFrame(replayOwnRef.current, frame);
    setReplayReady(replayLogRef.current.length);
    setReplayDescriptions(replayLogRef.current.map(f => ({ player: f.player, description: f.description })));
  }, []);

  // Tear down any in-flight replay and empty the buffer (used on new game / load).
  const resetReplay = useCallback(() => {
    replayCancelRef.current = true;
    if (replaySegTimerRef.current) { clearInterval(replaySegTimerRef.current); replaySegTimerRef.current = null; }
    if (replayFrameTimerRef.current) { clearTimeout(replayFrameTimerRef.current); replayFrameTimerRef.current = null; }
    replayRestoreRef.current = null;
    replayLogRef.current = [];
    replayOwnRef.current = [];
    setReplayReady(0);
    setReplayDescriptions([]);
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
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }
    if (replaySegTimerRef.current) { clearInterval(replaySegTimerRef.current); replaySegTimerRef.current = null; }
    if (replayFrameTimerRef.current) { clearTimeout(replayFrameTimerRef.current); replayFrameTimerRef.current = null; }
    if (spinIntervalRef.current) { clearInterval(spinIntervalRef.current); spinIntervalRef.current = null; }
    if (aiTimerRef.current) { clearTimeout(aiTimerRef.current); aiTimerRef.current = null; }
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    arrivalTimersRef.current.forEach(clearTimeout);
    arrivalTimersRef.current = [];
    clearAnnouncements();
    replayCancelRef.current = true;
    aiProcessingRef.current = false;
    setAnimatingPeg(null);
    setVisualBusy(false);
    setNowPlaying(null);
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
    //    `turnsRef` is incremented directly at each site that ends a turn
    //    (including the winning move itself), so it needs no "+1" here.
    //    jokersPlayed/bumpsDelivered/timesBumped are per-seat arrays; sum only
    //    the seats this client controls to get "my" lifetime tallies.
    //
    //    Mode and seats come from the refs, never the render closure: a game
    //    can end on the *other* device, in which case this runs from the fetch
    //    or listener that adopted the finished state, whose closure predates
    //    the setGameMode/setSeatOwners that opened the game. Reading the
    //    closure there recorded a partner win as a classic one played from
    //    seat 0 — the right win/loss by luck (team 0 contains seat 0), filed in
    //    the Solo bucket, with the wrong seat's joker/bump tallies.
    const mode = gameModeRef.current;
    const seats = mySeatsRef.current;
    const sumMine = (perSeat) => seats.reduce((n, s) => n + (perSeat[s] || 0), 0);
    const tallies = {
      turns: turnsRef.current,
      jokersPlayed: sumMine(jokersPlayedRef.current),
      bumpsDelivered: sumMine(bumpsDeliveredRef.current),
      timesBumped: sumMine(timesBumpedRef.current),
    };
    const { stats: updated } = recordFinishedGame(gameIdRef.current, {
      won: didIWin(winnerIdx, mode, seats),
      winner: winnerIdx,
      mySeats: seats,
      startMode: startModeRef.current,
      mode,
      ...tallies,
    });
    setStats(updated);
    setEndInfo({ winner: winnerIdx, winningSeat, description, ...tallies });
    setEndOverlayDismissed(false);
  }, [clearAnnouncements]);

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
    setLastMoves([null, null, null, null]);
    setNowPlaying(null);
    aiProcessingRef.current = false;
    setAnimatingPeg(null);
    setVisualBusy(false);
    if (animationRef.current) {
      clearInterval(animationRef.current);
      animationRef.current = null;
    }
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    arrivalTimersRef.current.forEach(clearTimeout);
    arrivalTimersRef.current = [];
    clearAnnouncements();
    setBumpFx(null);
    if (bumpFxRef.current) {
      clearInterval(bumpFxRef.current);
      bumpFxRef.current = null;
    }
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }
    resetReplay();
    replayPrevPlayerRef.current = firstPlayer;
    pendingAutoReplayRef.current = false;
    // Reset per-game stat tallies for the new game. `turnsRef` starts at 0 —
    // it is now incremented directly at each site a turn ends (including the
    // winning move), not inferred from a currentPlayer transition.
    turnsRef.current = 0;
    jokersPlayedRef.current = [0, 0, 0, 0];
    bumpsDeliveredRef.current = [0, 0, 0, 0];
    timesBumpedRef.current = [0, 0, 0, 0];
    gameIdRef.current = newGameId();
    endedRef.current = false;
    setEndInfo(null);
    setEndOverlayDismissed(false);
    setShowFirstPlayerModal(false);
  }, [resetReplay, ownsSeat, clearAnnouncements]);

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
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }
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

    // Clear transient selection/interaction state.
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);
    setAnimatingPeg(null);
    setVisualBusy(false);
    setNowPlaying(null);
    setBumpFx(null);
    if (bumpFxRef.current) { clearInterval(bumpFxRef.current); bumpFxRef.current = null; }
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }
    // The board hold outlives its move by seconds now (a joker's whole sequence
    // runs on it), so a game switch has to cancel it like every other timer —
    // otherwise it fires into the adopted game and blanks its played card.
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    arrivalTimersRef.current.forEach(clearTimeout);
    arrivalTimersRef.current = [];
    clearAnnouncements();

    // Restore per-game stat tallies so a resumed game still records correctly.
    // jokersPlayed/bumpsDelivered/timesBumped are per-seat arrays on the wire;
    // coerce a legacy single-number tally (an old local save) onto seat 0.
    const toPerSeat = (v) => (Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0] : [v ?? 0, 0, 0, 0]);
    const t = saved.tallies || {};
    turnsRef.current = t.turns ?? 0;
    jokersPlayedRef.current = toPerSeat(t.jokersPlayed);
    bumpsDeliveredRef.current = toPerSeat(t.bumpsDelivered);
    timesBumpedRef.current = toPerSeat(t.timesBumped);
    // A legacy save with no startMode at all defaults to 'chosen'; an explicit
    // `null` (a remote game) must stay null, not fall back — `??` would treat
    // both the same, which is exactly the bug this distinction exists to avoid.
    startModeRef.current = t.startMode === undefined ? 'chosen' : t.startMode;
    // Keep the saved game's identity so resuming it cannot record it twice.
    gameIdRef.current = saved.gameId ?? newGameId();
    endedRef.current = false;
    setEndInfo(null);
    setEndOverlayDismissed(false);

    // Seed the turn-return tracker to the restored player so resuming doesn't
    // fire a spurious "your turn" chime.
    prevPlayerRef.current = saved.currentPlayer;
    aiProcessingRef.current = false;

    // No replay is available for a freshly resumed game until a new AI round
    // runs (or, remotely, handleRemoteState seeds one right after this call).
    resetReplay();
    replayPrevPlayerRef.current = saved.currentPlayer;
    pendingAutoReplayRef.current = false;

    setNotice(null);

    setPendingResume(null);
    setShowResumeModal(false);
    setShowFirstPlayerModal(false);
  }, [resetReplay, ownsSeat, clearAnnouncements]);

  // Blank the board: no hands, pegs at start, nothing pending.
  //
  // The counterpart to applySavedGame, for opening a game that has *no* state
  // to adopt — a host still waiting for a partner to join, or a guest whose
  // host hasn't dealt. Without it, opening such a game left the previously
  // open game's board on screen: switching between a dealt game and an undealt
  // one in the lobby showed the same board both times, so two different games
  // looked like one game. Worse, that stale board sat under the newly-opened
  // game's session, so a move made on it would have been published to the
  // wrong game.
  //
  // `parkOn` is the seat the empty board waits on. With no hands dealt the
  // phase is `dealing` either way, but parking on a seat this client owns also
  // keeps the AI-simulation effect from reaching for a hand that isn't there.
  const clearBoard = useCallback((parkOn = 0) => {
    if (animationRef.current) { clearInterval(animationRef.current); animationRef.current = null; }
    if (bumpFxRef.current) { clearInterval(bumpFxRef.current); bumpFxRef.current = null; }
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }
    if (spinIntervalRef.current) { clearInterval(spinIntervalRef.current); spinIntervalRef.current = null; }
    if (aiTimerRef.current) { clearTimeout(aiTimerRef.current); aiTimerRef.current = null; }
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    arrivalTimersRef.current.forEach(clearTimeout);
    arrivalTimersRef.current = [];
    clearAnnouncements();
    aiProcessingRef.current = false;

    setDeck([]);
    setDiscardPiles([[], [], [], []]);
    setStuckCounts([0, 0, 0, 0]);
    setHands([[], [], [], []]);
    setPegs(createInitialPegs());
    setCurrentPlayer(parkOn);
    setLastMoves([null, null, null, null]);

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
    setAnimatingPeg(null);
    setVisualBusy(false);
    setNowPlaying(null);
    setBumpFx(null);
    setIsSpinning(false);
    setSpinningPlayer(0);

    setWinner(null);
    setNotice(null);
    setEndInfo(null);
    setEndOverlayDismissed(false);
    endedRef.current = false;

    // No game is in progress, so nothing may be carried into the one that is
    // dealt next — applySavedGame / dealAndStartAsHost set these for real.
    turnsRef.current = 0;
    jokersPlayedRef.current = [0, 0, 0, 0];
    bumpsDeliveredRef.current = [0, 0, 0, 0];
    timesBumpedRef.current = [0, 0, 0, 0];
    startModeRef.current = null;

    resetReplay();
    replayPrevPlayerRef.current = parkOn;
    prevPlayerRef.current = parkOn;
    pendingAutoReplayRef.current = false;
  }, [resetReplay, clearAnnouncements]);

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

  // Publish exactly once, at the end of a human turn (§4.1) — the only call
  // site any of executeMove/completeSplit/discardAndDraw's human
  // branch/handleJokerTarget should ever reach for a remote publish. No-op in
  // solo (sessionRef.current is null there).
  //
  // Component state setters are async, so `snapshot` must be the fresh values
  // the call site just computed (its local `newPegs`/`newHands`/...), never
  // the stale `pegs`/`hands`/... closures — those still hold last render's
  // values at the moment a handler runs. A half-finished split never crosses
  // the wire (§4.1's "consequence worth knowing"): splitRemaining/splitCard/
  // splitPegIndex/splitOwner always publish as cleared, so a disconnect
  // mid-split just restarts the turn from the pre-split state.
  //
  // `frame` is this client's own move, described the same way an AI move is
  // (§5.3's frame shape) — it rides the wire appended after whatever this
  // client already had buffered (the AI moves it simulated since its last
  // turn; see the reset-on-handoff effect below), so the receiving client
  // replays everything that happened, in order (`seedReplay`/
  // `appendReplayFrame` in net/replay.js).
  const commitTurn = useCallback(({
    nextPlayer, pegs: nextPegs, hands: nextHands, deck: nextDeck, discardPiles: nextDiscardPiles,
    stuckCounts: nextStuckCounts, lastMoves: nextLastMoves, frame = null,
    winner: winnerIdx = null, winningSeat = null, description = null,
  }) => {
    // Advance locally regardless of whether a session is open — this is the
    // one place every human-turn-end site hands off to the next player.
    setCurrentPlayer(nextPlayer);
    const s = sessionRef.current;
    if (!s) return; // solo — nothing to publish
    const waitingOn = winnerIdx !== null ? null : nextHumanSeat(nextPlayer, seatOwnersRef.current);
    const wireState = serializeGame({
      gameId: gameIdRef.current,
      mode: gameModeRef.current,
      pegs: nextPegs,
      hands: nextHands,
      deck: nextDeck,
      discardPiles: nextDiscardPiles,
      stuckCounts: nextStuckCounts,
      currentPlayer: nextPlayer,
      splitRemaining: 0, splitCard: null, splitPegIndex: null, splitOwner: null,
      lastMoves: nextLastMoves,
      turns: turnsRef.current,
      jokersPlayed: jokersPlayedRef.current,
      bumpsDelivered: bumpsDeliveredRef.current,
      timesBumped: timesBumpedRef.current,
      startMode: null, // remote: counts toward neither chosenFirst nor randomFirst
    });
    // Use replayOwnRef, not replayLogRef: replayLogRef also holds the seed
    // (frames adopted from the wire), which is always the recipient's own
    // earlier move — re-publishing it back to them is the bug that made the
    // replay grow to "the whole game" over a few rounds. See the comment on
    // replayOwnRef's declaration.
    const wireReplay = frame ? appendReplayFrame(replayOwnRef.current, frame) : seedReplay(replayOwnRef.current);
    publishState(s.id, {
      state: wireState, replay: wireReplay, currentPlayer: nextPlayer, waitingOn,
      winner: winnerIdx, winningSeat, description,
    }, s.version).then((newVersion) => {
      if (sessionRef.current && sessionRef.current.id === s.id) {
        setActiveSession({ ...sessionRef.current, version: newVersion });
      }
    }).catch((err) => {
      // The mover already committed locally — a failed publish must never
      // leave the local board stuck. Non-fatal: the next successful publish,
      // or re-adopting after a VersionConflict, reconciles it.
      setMpNotice(
        err instanceof VersionConflict
          ? 'Could not sync — reopen this game from My Games to catch up.'
          : 'Move saved locally, but could not sync to your partner. Check your connection.'
      );
    });
    // Mode and seat layout are read from the refs (see their declaration), so
    // this is stable and can never publish a turn labelled with the mode of a
    // game that is no longer the open one.
  }, [setActiveSession]);

  // The seat + description of the winning move, once the corresponding state
  // (at the same version) has actually been adopted. Metadata and live/current
  // are written in one transaction but delivered by two independent listeners,
  // so a winner can arrive here before its state has landed — wait for the
  // versions to line up rather than showing a stale board under a win.
  const maybeEndFromMeta = useCallback((meta) => {
    if (!meta || meta.winner == null) return;
    const s = sessionRef.current;
    if (!s) return;
    if (typeof meta.version === 'number' && (s.version == null || s.version < meta.version)) return;
    endGame(meta.winner, { winningSeat: meta.winningSeat ?? null, description: meta.description ?? null });
  }, [endGame]);

  // The metadata delivered for the open game, mirrored into a ref so
  // handleRemoteState (a different listener) can check the freshest winner
  // without waiting for a render.
  const openMetaRef = useRef(null);

  // Adopt a state snapshot arriving over the wire for the open game. In
  // Package 3 this is how the guest receives the initial deal; Package 4/5
  // layer turn exchange, win detection and auto-replay on top of the same
  // seam. Ignore our own echo.
  const handleRemoteState = useCallback((id, payload, info) => {
    const s = sessionRef.current;
    if (!s || s.id !== id) return; // a stale delivery from a game we left
    if (!payload || !payload.state) return; // not dealt yet
    if (info && info.isEcho(s.version)) return; // our own write coming back
    applySavedGame(payload.state); // resets replayLogRef — seed it back below
    replayLogRef.current = seedReplay(payload.replay);
    replayOwnRef.current = []; // the seed is not "own" — see its declaration
    setReplayReady(replayLogRef.current.length);
    setReplayDescriptions(replayLogRef.current.map(f => ({ player: f.player, description: f.description })));
    setActiveSession({ ...s, version: payload.version });
    // §4.3: adopt first, then endGame — a terminal state can be adopted any
    // number of times safely (recordFinishedGame is idempotent on gameId).
    // §5.1: otherwise, queue the auto-replay for when the AI chain this client
    // is responsible for (if any) delivers control to isMyTurn — or, if the
    // game ends *during* that silent simulation, to `winner !== null` instead,
    // since control may never actually reach this seat.
    pendingAutoReplayRef.current = true;
    maybeEndFromMeta(openMetaRef.current);
  }, [applySavedGame, setActiveSession, maybeEndFromMeta]);

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
      turns: 0,
      jokersPlayed: [0, 0, 0, 0], bumpsDelivered: [0, 0, 0, 0], timesBumped: [0, 0, 0, 0],
      // Remote games count toward neither the chosenFirst nor randomFirst
      // bucket — "did I choose to go first" isn't a meaningful question when
      // the host always goes first by fixed rule and the guest never chose.
      startMode: null,
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
  // for the host waiting on a partner — the trigger to deal once a guest
  // appears. Also the second of the two places a winner can arrive (§4.3):
  // metadata and live/current are written together but delivered by two
  // independent listeners, so check here too in case this one lands second.
  const handleOpenMeta = useCallback((id, meta) => {
    const s = sessionRef.current;
    if (!s || s.id !== id) return;
    setOpenMeta(meta);
    openMetaRef.current = meta;
    if (!meta) return;
    if (s.seat === HOST_SEAT && meta.status === STATUS.LOBBY && meta.guestUid && !hostDealtRef.current) {
      hostDealtRef.current = true;
      dealAndStartAsHost(id);
      return;
    }
    maybeEndFromMeta(meta);
  }, [dealAndStartAsHost, maybeEndFromMeta]);

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
    setHostInfo(null);
    setShowFirstPlayerModal(false);
    setShowResumeModal(false);
    setOpenMeta(null);
    openMetaRef.current = null;
    // Nothing of the game we just left may survive the switch — not while the
    // fetch is in flight, and not at all if the game we are opening turns out
    // to have no state yet. Whatever comes back below replaces this.
    clearBoard(seat);
    try {
      // Sign in *before* the fetch. Every other caller reaches here already
      // signed in (the lobby listener, joining, hosting), but the mount routing
      // does not — and an unauthenticated read is denied by the rules, which
      // would land a reload in the lobby with "could not open that game"
      // instead of on the board it was told to restore. signIn is idempotent.
      setMyUid(await signIn());
      const snap = await fetchGame(id);
      setOpenMeta(snap.meta);
      openMetaRef.current = snap.meta;
      const action = openActionFor({ meta: snap.meta, hasState: Boolean(snap.state), seat });
      if (action === 'adopt') {
        applySavedGame(snap.state); // resets replayLogRef — seed it back below
        replayLogRef.current = seedReplay(snap.replay);
        replayOwnRef.current = []; // the seed is not "own" — see its declaration
        setReplayReady(replayLogRef.current.length);
        setReplayDescriptions(replayLogRef.current.map(f => ({ player: f.player, description: f.description })));
        setActiveSession({ id, seat, version: snap.version });
        // Same seam as handleRemoteState (§4.3/§5.1): this one-shot fetch is
        // just as much an "adopted state I didn't watch happen" as a live
        // delivery — reopening an in-progress game or switching into one from
        // the lobby should replay what happened and show a finished result,
        // not silently skip both because it arrived via fetchGame instead of
        // the listener.
        pendingAutoReplayRef.current = true;
        maybeEndFromMeta(snap.meta);
      } else if (action === 'deal') {
        // Re-entering our own game that a guest joined while we were away.
        hostDealtRef.current = true;
        await dealAndStartAsHost(id);
      } else if (action === 'await_guest') {
        // Our own game, still with nobody in the other seat: show the code and
        // the invite link again, exactly as at create time. The metadata
        // listener attached below deals the moment a partner joins. Without
        // this the board is (correctly) blank but nothing says why.
        setHostInfo({
          id,
          code: snap.meta.code ?? getLocalGame(id)?.code ?? '',
          link: inviteLinkFor(id),
        });
        setMpScreen('hosting');
      }
      attachGameListeners(id);
    } catch {
      setMpNotice('Could not open that game. It may have been removed.');
      // The board is blank at this point, so send them somewhere they can act
      // rather than leaving them staring at an empty board.
      setShowLobby(true);
    }
  }, [applySavedGame, attachGameListeners, clearBoard, detachGameListeners, dealAndStartAsHost, setActiveSession, maybeEndFromMeta]);

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
    openMetaRef.current = null;
    setMpNotice(null);
    if (target === 'solo' || target == null) {
      setActiveSession(null);
      setActiveId(null);
      setSeatOwners(SOLO_SEAT_OWNERS);
      setShowLobby(false);
      setHostInfo(null);
      const saved = loadGame();
      if (saved) applySavedGame(saved);
      else { clearBoard(0); initGame(); }
      return;
    }
    const seat = target.seat ?? seatForUid(target, myUid) ?? GUEST_SEAT;
    await openRemoteGame(target.id, seat);
  }, [splitRemaining, detachGameListeners, setActiveSession, applySavedGame, clearBoard, initGame, myUid, openRemoteGame]);

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
    openMetaRef.current = null;
    setHostInfo(null);
    setSeatOwners(SOLO_SEAT_OWNERS);
    clearBoard(0);
    initGame();
  }, [detachGameListeners, setActiveSession, clearBoard, initGame]);

  // On mount, route back to whatever was on screen (§3.4) — `bootTargetFor` is
  // the whole decision and is pure, because a reload must never *change* games.
  // The one input that matters is the stored `activeId`; a device that merely
  // *has* a remote game is not a device that was looking at one. A solo-only
  // player, even with the env vars set, gets today's exact flow and is never
  // signed in.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const joinId = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('g')
      : null;
    const saved = loadGame();
    const local = multiplayerConfigured ? loadLocalGames() : emptyLocalGames();
    const target = bootTargetFor({
      joinId,
      multiplayer: multiplayerConfigured,
      activeId: local.activeId,
      games: local.games,
      hasSave: Boolean(saved),
    });

    if (target.kind === 'join') {
      if (saved) setPendingResume(saved);
      beginJoin(target.id, { byId: true });
      return;
    }
    if (target.kind === 'remote') {
      openRemoteGame(target.id, target.seat);
      return;
    }
    if (target.kind === 'resume') {
      setPendingResume(saved);
      setShowResumeModal(true);
      return;
    }
    initGame();
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

  // Where a peg is sitting right now, in the shape `animatingPeg.path` uses, so
  // the origin can be drawn as a ghost for as long as the move is in flight.
  const pegAnchor = useCallback((peg, pegIndex) => {
    if (!peg) return null;
    if (peg.location === 'track') return { type: 'track', position: peg.position };
    if (peg.location === 'home') return { type: 'home', position: peg.homePosition };
    // A start slot is addressed by the peg's index in its own array, which is
    // also how the start area is drawn — don't trust `peg.index`, which is only
    // set at deal time.
    if (peg.location === 'start') return { type: 'start', position: pegIndex };
    return null;
  }, []);

  // Run animation for a move, then call onComplete when done.
  //
  // One space per tick, with a click on each — the peg counts itself along the
  // board the way a hand would, instead of teleporting. `stepMs` comes from the
  // pace setting, so "slow" really is slow all the way down to the sound.
  const animateMove = useCallback((player, pegIndex, card, amount, currentPegs, onComplete, options = {}) => {
    const { stepMs = pacing.stepMs } = options;
    const path = calculateMovePath(player, pegIndex, card, amount, currentPegs);

    if (path.length === 0 || stepMs <= 0) {
      // No animation needed (a joker has no path; `off` has no animation)
      onComplete();
      return;
    }

    const from = pegAnchor(currentPegs?.[player]?.[pegIndex], pegIndex);

    // Start animation
    setAnimatingPeg({
      player,
      pegIndex,
      path,
      currentStep: 0,
      from,
    });
    sfx.step(player, 0, path.length);

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
        sfx.step(player, step, path.length);
        setAnimatingPeg(prev => prev ? { ...prev, currentStep: step } : null);
      }
    }, stepMs);
  }, [pacing.stepMs, pegAnchor]);

  // When the cosmetic glide puts the peg *on* its destination space.
  //
  // Not the same as when `animateMove` calls back: it draws `path[k]` at
  // k * stepMs, so the peg is standing on the last space a whole step before the
  // interval clears. Bumps and arrival chimes key off the landing — a bump that
  // fires a step late reads as the target flinching after the fact.
  const landingDelayFor = useCallback((player, pegIndex, card, amount, fromPegs) => {
    if (!animationsEnabled) return 0;
    const path = calculateMovePath(player, pegIndex, card, amount, fromPegs);
    return path.length > 1 ? (path.length - 1) * pacing.stepMs : 0;
  }, [animationsEnabled, pacing.stepMs]);

  // Hold the board — nothing else may start moving — for `ms`, then let go and
  // clear the played card. The one mechanism behind three different waits: the
  // settle beat after a move, the extra two seconds a special play earns
  // (SPECIAL_PAUSE_MS), and the joker's whole card-and-flight sequence, which
  // has no peg travel of its own to hold anything.
  //
  // A `visualBusy` left true is a game that never takes another turn, so this
  // reuses `settleTimerRef` rather than adding a fourth timer: every path that
  // can strand it (endGame, new game, clearBoard, adopting a save, unmount)
  // already clears that one.
  const holdBoard = useCallback((ms) => {
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    // A hold of nothing still has to *let go*: at the `fast` pace there is no
    // settle beat at all, and returning early here would leave the board busy
    // for ever — see the note above about a stranded `visualBusy`.
    if (!(ms > 0)) {
      setNowPlaying(null);
      setVisualBusy(false);
      return;
    }
    setVisualBusy(true);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setNowPlaying(null);
      setVisualBusy(false);
    }, ms);
  }, []);

  // Replay the move that was *just committed*, for the eye only. Human turns
  // apply their state synchronously (executeMove and friends validate, apply,
  // publish and hand off in one pass, and unpicking that would put the wire
  // protocol behind an animation timer), so your own peg used to jump straight
  // to its destination while the AI's glided. This runs the same step-by-step
  // glide over the already-final board: the real peg is hidden while it flies
  // and a ghost marks where it started.
  //
  // `visualBusy` is what keeps it honest — the AI effect will not start a turn
  // while a cosmetic playback is running, so the opponents wait for your peg to
  // finish counting rather than moving over the top of it.
  const playMoveVisual = useCallback((player, pegIndex, card, amount, fromPegs, meta = null, extraHoldMs = 0) => {
    if (!animationsEnabled) return;
    const path = calculateMovePath(player, pegIndex, card, amount, fromPegs);
    if (!path.length) return;
    if (animationRef.current) { clearInterval(animationRef.current); animationRef.current = null; }
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    setVisualBusy(true);
    if (meta) showNowPlaying({ ...meta, lifeMs: (path.length - 1) * pacing.stepMs + pacing.settleMs });
    animateMove(player, pegIndex, card, amount, fromPegs, () => {
      // Hold the "now playing" banner through the settle beat, so the card that
      // was played is still on screen when the peg stops — and through
      // `extraHoldMs` on top of that when the move was a special one, so the
      // bumped peg finishes its flight and the player gets a moment with the
      // result before an opponent starts moving.
      holdBoard(pacing.settleMs + extraHoldMs);
    });
  }, [animationsEnabled, animateMove, pacing.stepMs, pacing.settleMs, showNowPlaying, holdBoard]);

  // Fly every peg a move displaced, from the space it was on to wherever the
  // bump sent it. `items` is [{ player, pegIndex, from, to, kind, onImpact }]
  // in *causal* order — the peg that was pushed first goes first — and they all
  // run off one interval, staggered by `stageBumpFlights` so a cascade reads as
  // one peg shoving the next rather than two unrelated things happening at
  // once.
  //
  // `holdMs` is the wait before impact, and it is what makes the bump read as a
  // *consequence* of the move rather than something that happened alongside it.
  // The board state is already final when this is called — a human move commits
  // before its cosmetic glide runs, so the bumped peg is sitting in its start
  // slot while the peg that bumped it is still two-thirds of the way across the
  // board. So the peg is pinned, unchanged, on the space it visually still
  // occupies, and nothing happens to it until the mover has counted its way onto
  // it. Each item's `onImpact` (its sound and haptic) fires from the same timer
  // as its own flight, so what you hear and what you see can't drift apart —
  // and in a chain you hear the two hits in the order you see them.
  //
  // `onLand` is the counterpart to `onImpact`, fired when that peg's flight
  // *finishes*: what a peg has to say belongs over where it comes to rest, and
  // at impact it is still in mid-air. It carries the "@$#*!" of a knock-back and
  // the "Thanks!"/"You're welcome!" of a partner bump.
  // `leadCount` items fly alone and are *finished* before the rest set off (see
  // stageBumpFlights): the joker's own peg has to land on the space it is
  // taking before the peg standing there can be knocked off it. Every other
  // move passes 0 and gets the overlapping cascade it always had.
  const runBumpFx = useCallback((items, holdMs = 0, leadCount = 0) => {
    if (!items || items.length === 0) return;
    if (bumpFxRef.current) { clearInterval(bumpFxRef.current); bumpFxRef.current = null; }
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }

    const { startTicks, totalTicks } = stageBumpFlights(items.length, leadCount);
    const staged = items.map((item, i) => ({ ...item, startTick: startTicks[i] }));

    // Everything that begins or ends on this tick. Split out so the last tick
    // can fire its landings before the effect is torn down.
    const fireTakeoffs = (tick) => {
      for (const item of staged) {
        if (item.startTick === tick && item.onImpact) item.onImpact();
      }
    };
    const fireLandings = (tick) => {
      for (const item of staged) {
        if (item.onLand && item.startTick + BUMP_FLY_STEPS === tick) item.onLand();
      }
    };

    const fly = () => {
      let tick = 0;
      fireTakeoffs(0);
      setBumpFx(prev => (prev ? { ...prev, holding: false } : null));
      bumpFxRef.current = setInterval(() => {
        tick++;
        fireTakeoffs(tick);
        fireLandings(tick);
        if (tick >= totalTicks) {
          clearInterval(bumpFxRef.current);
          bumpFxRef.current = null;
          setBumpFx(null);
        } else {
          setBumpFx(prev => (prev ? { ...prev, tick } : null));
        }
      }, BUMP_FLY_TICK_MS);
    };

    setBumpFx({ holding: holdMs > 0, tick: 0, items: staged });
    if (holdMs > 0) {
      bumpHoldRef.current = setTimeout(() => {
        bumpHoldRef.current = null;
        fly();
      }, holdMs);
    } else {
      fly();
    }
  }, []);

  // When you finish your turn and control passes to the AI, start recording a
  // fresh round so the replay buffer only ever holds the moves made since your
  // last turn.
  useEffect(() => {
    const prev = replayPrevPlayerRef.current;
    if (ownsSeat(prev) && !ownsSeat(currentPlayer)) {
      replayLogRef.current = [];
      replayOwnRef.current = [];
      setReplayReady(0);
      setReplayDescriptions([]);
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
    // Banners belong to the live board. A remote adopt simulates the AI seats
    // silently and only *then* plays the round back, so anything still on
    // screen from that silent run would hang over the replay describing a move
    // the player is about to watch happen.
    clearAnnouncements();
    setIsReplaying(true);
    setSelectedCard(null);
    setSelectedPeg(null);
    setJokerMode(false);
    setJokerSourcePeg(null);
    setDiscardMode(false);

    const total = frames.length;
    // A replay is meant to be watchable, so it never runs faster than the
    // floor — but if the player has chosen an even slower live pace, honour it
    // rather than speeding their moves up when they play them back.
    const replayStepMs = Math.max(REPLAY_MIN_STEP_MS, pacing.stepMs);

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
      setAnimatingPeg({
        player: seg.owner,
        pegIndex: seg.pegIndex,
        path,
        currentStep: 0,
        from: pegAnchor(seg.fromPegs?.[seg.owner]?.[seg.pegIndex], seg.pegIndex),
      });
      sfx.step(seg.owner, 0, path.length);
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
          sfx.step(seg.owner, step, path.length);
          setAnimatingPeg(prev => prev ? { ...prev, currentStep: step } : null);
        }
      }, replayStepMs);
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
  }, [isReplaying, pegs, pacing.stepMs, pegAnchor, clearAnnouncements]);

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

  // Package 5: auto-play the buffered frames once it becomes this client's
  // turn — the wire frames (the partner's move, and anything the *other*
  // client simulated) plus whatever this client just silently simulated
  // itself. Solo never sets `pendingAutoReplayRef` (only handleRemoteState
  // does), so this is a no-op there — the manual button stays the only way to
  // watch a replay in solo, unchanged.
  //
  // Triggered on `isMyTurn` OR `winner !== null`, not `isMyTurn` alone: if the
  // game ends during the silent AI simulation this client just ran, control
  // never actually reaches this seat (the AI's winning move doesn't hand off),
  // so `isMyTurn` would never become true — but the player should still watch
  // the winning move play out before the end-of-game overlay appears.
  useEffect(() => {
    if (!session) return;
    if (!pendingAutoReplayRef.current) return;
    if (!(isMyTurn || winner !== null)) return;
    pendingAutoReplayRef.current = false;
    if (!replayLogRef.current.length) return; // first turn / fresh join: nothing to show
    if (!animationsEnabled) return; // §5.2: text summary instead (see render)
    startReplay();
  }, [isMyTurn, winner, session, animationsEnabled, startReplay]);

  // Clean up replay and pacing timers if the component unmounts mid-playback.
  useEffect(() => {
    const arrivals = arrivalTimersRef;
    const announceTimers = announceTimersRef;
    const tauntTimers = tauntTimersRef;
    return () => {
      if (replaySegTimerRef.current) clearInterval(replaySegTimerRef.current);
      if (replayFrameTimerRef.current) clearTimeout(replayFrameTimerRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (bumpFxRef.current) clearInterval(bumpFxRef.current);
      if (bumpHoldRef.current) clearTimeout(bumpHoldRef.current);
      arrivals.current.forEach(clearTimeout);
      arrivals.current = [];
      announceTimers.current.forEach(clearTimeout);
      announceTimers.current = [];
      tauntTimers.current.forEach(clearTimeout);
      tauntTimers.current = [];
    };
  }, []);

  // `mover` is the acting player (for stats); `displacements` is the engine's
  // own account of every peg this move shoved off a space (see
  // resolveDisplacement in engine.js). The two kinds of displacement are read
  // differently, and deliberately:
  //
  //   * Knock-backs are *diffed* (`findBumps`). A peg going from the track to a
  //     start area can't be anything but a bump, so the diff is exact and needs
  //     nothing threaded through from the caller.
  //   * Friendly partner bumps are *reported*, because a diff genuinely cannot
  //     see them. A peg on its own home entrance looks the same whether it was
  //     shoved there or simply landed there under its own card — the entrance
  //     is the last space before the home corridor, so pegs land on it all the
  //     time — and in the entrance swap the peg displaced is the mover itself,
  //     which any diff must exclude as "the peg that meant to move".
  //
  // `landingDelayMs` exists because the two kinds of caller sit on opposite
  // sides of the animation. An AI move calls this *after* its peg has finished
  // gliding, so everything here is already in time. A human move commits its
  // state first and replays the glide cosmetically afterwards
  // (`playMoveVisual`), so with no delay the "peg is home" chime would land
  // several seconds before the peg does, and a bumped peg would be knocked back
  // to start while the peg doing the bumping was still counting its way over to
  // it — badly wrong at the slow pace this whole change exists to support. So
  // it defers *every* consequence of the move (arrival chimes, the bump sound
  // and the bumped peg's fly-back) to the moment the mover actually lands.
  //
  // `joker` is `{ player, pegIndex }` for the peg a joker moves, and null for
  // every other card. It has to be told, not diffed: a joker's peg simply
  // appears on a space the other side of the board with no path between, which
  // is exactly why the card needs its own flight here rather than the empty
  // `calculateMovePath` every other part of the UI gets from it.
  //
  // Returns the extra hold the *board* needs after these effects start, before
  // the next play may begin — 0 for an ordinary move, and for a special one
  // (see isSpecialPlay) the flights plus SPECIAL_PAUSE_MS. Every caller owns a
  // `visualBusy` hold already; this is what to add to it.
  const triggerMoveEffects = useCallback((oldPegs, updatedPegs, mover, displacements = [], landingDelayMs = 0, { joker = null } = {}) => {
    const bumps = findBumps(oldPegs, updatedPegs);
    // No mode check needed: the engine only ever produces a friendly
    // displacement under the partner rule.
    const friendly = (displacements ?? []).filter(d => d.friendly);

    // The events every player at a real table hears, whoever made the move:
    // a peg coming out of start, a peg reaching home, and a seat finishing.
    // Derived from the before/after boards (game/events.js) rather than from
    // whichever call site happened to know, so an AI's peg going home sounds
    // exactly like yours — which is the whole point of adding them.
    const { cameOut, reachedHome, finishedAll } = diffPegEvents(oldPegs, updatedPegs);
    const playArrivals = () => {
      for (const p of cameOut) sfx.comeOut(p.player);
      // `finishedAll` supersedes the plain home chime for that seat's last peg
      // — one sound per peg, with the fifth one upgraded to the flourish.
      const finishing = new Set(finishedAll);
      for (const p of reachedHome) {
        if (!finishing.has(p.player)) sfx.home(p.player);
      }
      for (const player of finishedAll) sfx.allHome(player);
    };
    if (cameOut.length || reachedHome.length || finishedAll.length) {
      if (landingDelayMs > 0) {
        const timer = setTimeout(() => {
          arrivalTimersRef.current = arrivalTimersRef.current.filter(t => t !== timer);
          playArrivals();
        }, landingDelayMs);
        arrivalTimersRef.current.push(timer);
      } else {
        playArrivals();
      }
    }

    if (!joker && bumps.length === 0 && friendly.length === 0) return 0;

    // Tally bumps for stats, per seat — not gated on `ownsSeat`. That gate is
    // exactly the bug the per-seat restructure exists to fix: a bump an AI
    // seat delivers or receives while the *other* client is simulating it
    // would never be counted anywhere. Recording objectively at the mover's
    // and target's seat means whichever client actually simulates the move
    // records it correctly, and each client sums only its own seats
    // (`mySeats`) at stats-record time (see endGame). Friendly partner bumps
    // are cooperative and don't count.
    for (const b of bumps) {
      bumpsDeliveredRef.current[mover] += 1;
      timesBumpedRef.current[b.player] += 1;
    }

    // Every peg this card displaced, in the order the rules displaced them:
    // the friendly shove first, then whoever that shove knocked off the
    // entrance. Both fly — animating only the first left the "Double Play!"
    // banner describing something the board never showed, and the peg you were
    // *not* watching simply teleported.
    //
    // Three bump sounds, not one, and now one per peg rather than one per move.
    // Being knocked back is the worst thing that happens to you in this game
    // and it used to sound identical to doing it to someone else; a partner
    // bump is actively *good* and sounded like a punishment. Whose peg it was
    // decides which you hear, so a cascade is a chirp and then a thud — in the
    // order you watch it happen.
    //
    // A friendly bump additionally ends in the two pegs thanking each other.
    // The engine names the peg that did the shoving on the displacement itself
    // (`byPlayer`/`byPegIndex`), which is what makes the *swap* — where the
    // mover is the peg carried to its entrance by a partner that never moved —
    // read the right way round with no special case here. Where each speaker
    // ends up is read from the committed board rather than from the
    // displacement, since the peg replying is usually the mover and its
    // landing spot is the move's own business, not the bump's.
    const restingSpot = (player, pegIndex) => {
      const peg = updatedPegs[player]?.[pegIndex];
      return peg && peg.location === 'track' ? { player, position: peg.position } : null;
    };
    // Who knocked this peg back, so it can be answered from wherever the move
    // left it. The engine names the culprit on every displacement it logs
    // (`byPlayer`/`byPegIndex`), including the ordinary knock-backs the UI
    // otherwise diffs — so the gloat needs no guessing, and a bump with no
    // logged displacement (a legacy caller, an adopted board) simply gets none.
    const bumperOf = (b) => {
      const d = (displacements ?? []).find(
        x => !x.friendly && x.player === b.player && x.pegIndex === b.pegIndex && x.byPlayer !== null
      );
      return d ? restingSpot(d.byPlayer, d.byPegIndex) : null;
    };
    const fxItems = [
      ...friendly.map(fb => ({
        player: fb.player,
        pegIndex: fb.pegIndex,
        from: getTrackPosition(fb.fromPosition),
        to: getTrackPosition(fb.toPosition),
        kind: 'friendly',
        onImpact: () => sfx.friendlyBump(fb.player),
        onLand: () => showPartnerThanks(
          { player: fb.player, position: fb.toPosition },
          fb.byPlayer === null ? null : restingSpot(fb.byPlayer, fb.byPegIndex),
        ),
      })),
      ...bumps.map(b => ({
        player: b.player,
        pegIndex: b.pegIndex,
        from: getTrackPosition(b.fromPosition),
        to: getStartAreaPosition(b.player, b.pegIndex),
        kind: 'start',
        onImpact: () => (ownsSeat(b.player) ? sfx.bumpReceived() : sfx.bumpDelivered()),
        // Both sides of it: the peg that was sent home swears, and the peg that
        // sent it there snickers back a beat later.
        onLand: () => { showBumpTaunt(b.player, b.pegIndex); showGloat(bumperOf(b)); },
      })),
    ];

    // The joker's own peg, flying to the space it is taking. Every other card
    // moves its peg along the track a space at a time; this one crosses the
    // board in one jump with no path to draw, so without a flight of its own
    // the only visible evidence a joker was played is that the board has
    // silently changed shape. It leads the chain: it has to *land* before the
    // peg standing there can be knocked off (hence `leadCount` below), which is
    // also the order the rules describe it in.
    //
    // Skipped when the joker's peg is already flying as a displacement of its
    // own — the partner entrance swap, where the mover is the peg that gets
    // carried off. Drawing it twice is exactly the "two of the same peg" bug
    // `isPegAnimating` exists to prevent.
    const jokerAlreadyFlying = joker && fxItems.some(
      it => it.player === joker.player && it.pegIndex === joker.pegIndex
    );
    const anchorOf = (pegState, player, pegIndex) => {
      if (!pegState) return null;
      if (pegState.location === 'track') return getTrackPosition(pegState.position);
      if (pegState.location === 'start') return getStartAreaPosition(player, pegIndex);
      if (pegState.location === 'home') return getHomePosition(player, pegState.homePosition);
      return null;
    };
    if (joker && !jokerAlreadyFlying) {
      const from = anchorOf(oldPegs[joker.player]?.[joker.pegIndex], joker.player, joker.pegIndex);
      const to = anchorOf(updatedPegs[joker.player]?.[joker.pegIndex], joker.player, joker.pegIndex);
      if (from && to) {
        fxItems.unshift({
          player: joker.player,
          pegIndex: joker.pegIndex,
          from,
          to,
          kind: 'joker',
          // No sound of its own: the cackle is already playing over the card,
          // and the peg's arrival is immediately followed by the bump it causes.
          onImpact: null,
          onLand: null,
        });
      }
    }
    const leadCount = fxItems[0]?.kind === 'joker' ? 1 : 0;

    // "Partner Bump!" and "Double Play!", on the same landing delay as the
    // sound: both describe something the board is about to do, and a banner
    // that appears while the peg causing it is still travelling reads as a
    // banner about the *previous* move.
    announce(announcementsFor({ bumps, friendly }), landingDelayMs);

    // How long all this takes, and therefore how long the board is held before
    // the next play may start. A special play gets the flights plus a full
    // two seconds of nothing afterwards (anim.js): these are the moves with
    // more than one moving part, and rolling straight from one into the next
    // opponent's turn is how they get missed.
    const { totalTicks } = stageBumpFlights(fxItems.length, leadCount);
    const special = isSpecialPlay({ bumps, friendly, isJoker: joker != null });

    // With animations off there is no travel to be out of step with, so the
    // impact is now. The bubbles still show: they are feedback, not travel, and
    // this is precisely the setting where a peg vanishes from the track and
    // reappears somewhere else with nothing in between. Nothing is held either:
    // a player who has turned animations off is asking for none of this.
    if (!animationsEnabled) {
      for (const item of fxItems) {
        if (item.onImpact) item.onImpact();
        if (item.onLand) item.onLand();
      }
      return 0;
    }

    // `runBumpFx` holds the pegs where they are for `landingDelayMs` and fires
    // each one's sound as its own flight starts, so the whole cascade happens
    // when the mover arrives, not before.
    runBumpFx(fxItems, landingDelayMs, leadCount);
    return specialPlayHoldMs({ special, totalTicks });
  }, [animationsEnabled, runBumpFx, ownsSeat, announce, showBumpTaunt, showGloat, showPartnerThanks]);

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
    const { newPegs, displacements } = applyMove(owner, pegIndex, card, splitAmount, pegs, moveOptions);
    const newPeg = newPegs[owner][pegIndex];

    // Record last move description (under the acting human)
    const moveDescription = describeMoveAction(oldPeg, newPeg, card, splitAmount);

    // The cosmetic glide runs over the already-committed board (see
    // playMoveVisual); everything the move causes — the chimes, and the bump —
    // is delayed to match it, so the "peg is home" note and the knock-back both
    // land when the peg does.
    const travelMs = landingDelayFor(owner, pegIndex, card, splitAmount, pegs);
    // A move that bumps something holds the board past its own settle beat —
    // long enough for the bumped peg to finish flying, and then two seconds of
    // stillness to take in what just happened.
    const specialHoldMs = triggerMoveEffects(pegs, newPegs, actor, displacements, travelMs);
    sfx.cardPlay();
    playMoveVisual(owner, pegIndex, card, splitAmount, pegs, {
      player: actor, card, description: moveDescription,
    }, specialHoldMs);

    const updatedLastMoves = [...lastMoves];
    updatedLastMoves[actor] = moveDescription;
    setLastMoves(updatedLastMoves);

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

    // The frame for the wire/replay: a single-peg move (see the AI effect's
    // 'simple'/'start' case for the same shape). Split completions build their
    // own frame in completeSplit; jokers in handleJokerTarget.
    const frame = {
      player: actor,
      // §5.3: once your pegs are all home your cards move your partner's —
      // say so explicitly, since the frame is attributed to the actor's turn.
      description: attributeFrameDescription(moveDescription, actor, owner),
      pegsBefore: pegs,
      pegsAfter: newPegs,
      segments: [{ owner, pegIndex, card, amount: splitAmount, fromPegs: pegs, toPegs: newPegs }],
    };

    turnsRef.current += 1; // §4.4: once per seat that actually moves

    const w = checkWinner(newPegs, gameMode);
    if (w !== null) {
      endGame(w, { winningSeat: actor, description: moveDescription });
      const nextPlayer = (actor + 1) % 4;
      commitTurn({
        nextPlayer, pegs: newPegs, hands, deck, discardPiles, stuckCounts,
        lastMoves: updatedLastMoves, frame, winner: w, winningSeat: actor, description: moveDescription,
      });
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

    // Switch to next player. §4.1: this is one of the four human-turn-end
    // sites — publish exactly once, at handoff (no-op in solo).
    const nextPlayer = (actor + 1) % 4;
    commitTurn({
      nextPlayer, pegs: newPegs, hands: newHands, deck: newDeck, discardPiles: updatedDiscardPiles,
      stuckCounts: newStuckCounts, lastMoves: updatedLastMoves, frame,
    });
    setNotice(null);

    return true;
  }, [pegs, hands, deck, discardPiles, stuckCounts, lastMoves, triggerMoveEffects, moveOptions, gameMode, mySeat, endGame, commitTurn, landingDelayFor, playMoveVisual]);

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
    const { newPegs, displacements } = applyMove(owner, pegIndex, splitCard, amount, pegs, moveOptions);
    const newPeg = newPegs[owner][pegIndex];

    // Update last move description to show split completion
    const secondMoveDesc = describeMoveAction(oldPeg, newPeg, splitCard, amount);
    const splitDescription = `Split: ${lastMoves[actor]}, ${secondMoveDesc}`;

    const travelMs = landingDelayFor(owner, pegIndex, splitCard, amount, pegs);
    const specialHoldMs = triggerMoveEffects(pegs, newPegs, actor, displacements, travelMs);
    sfx.cardPlay();
    playMoveVisual(owner, pegIndex, splitCard, amount, pegs, {
      player: actor, card: splitCard, description: secondMoveDesc,
    }, specialHoldMs);

    const updatedLastMoves = [...lastMoves];
    updatedLastMoves[actor] = splitDescription;
    setLastMoves(updatedLastMoves);

    setPegs(newPegs);

    // The frame for the wire/replay. The second half's amount is known so it
    // animates; the first half only shows as the frame's before/after (a snap
    // rather than an animated glide) — a minor fidelity trade, not a
    // correctness one, since pegsBefore/pegsAfter are exact either way.
    const frame = {
      player: actor,
      // §5.3 attribution — see the same note in executeMove.
      description: attributeFrameDescription(splitDescription, actor, owner),
      pegsBefore: splitUndo?.pegs ?? pegs,
      pegsAfter: newPegs,
      segments: [{ owner, pegIndex, card: splitCard, amount, fromPegs: pegs, toPegs: newPegs }],
    };

    turnsRef.current += 1; // §4.4: once per seat that actually moves

    const w = checkWinner(newPegs, gameMode);
    if (w !== null) {
      endGame(w, { winningSeat: actor, description: splitDescription });
      const nextPlayer = (actor + 1) % 4;
      commitTurn({
        nextPlayer, pegs: newPegs, hands, deck, discardPiles, stuckCounts,
        lastMoves: updatedLastMoves, frame, winner: w, winningSeat: actor, description: splitDescription,
      });
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
    commitTurn({
      nextPlayer, pegs: newPegs, hands: newHands, deck: newDeck, discardPiles: updatedDiscardPiles,
      stuckCounts: newStuckCounts, lastMoves: updatedLastMoves, frame,
    });
    setNotice(null);

    return true;
  }, [splitCard, splitPegIndex, splitOwner, splitUndo, pegs, hands, deck, discardPiles, stuckCounts, lastMoves, triggerMoveEffects, controlledOwnerFor, moveOptions, gameMode, mySeat, endGame, commitTurn, landingDelayFor, playMoveVisual]);

  // Undo a half-finished split: restore the board (and anything the first half
  // bumped) to the snapshot taken before it, and return the turn to the point
  // where the card is selected and pegs are glowing, ready to try again. This is
  // only available between the two halves of a split — once the second peg is
  // played the move is committed and there's nothing to undo.
  const undoSplit = useCallback(() => {
    if (!splitUndo) return;
    // Cancel any in-flight (or not-yet-landed) bump fly-back from the first half
    // before restoring.
    if (bumpFxRef.current) {
      clearInterval(bumpFxRef.current);
      bumpFxRef.current = null;
    }
    if (bumpHoldRef.current) { clearTimeout(bumpHoldRef.current); bumpHoldRef.current = null; }
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
    let startDisplacements = [];
    if (newStuckCounts[player] >= 3) {
      // Find a peg in start and move it to come-out position. applyComeOut keeps
      // partner-mode rules intact: a teammate on the come-out space is
      // friendly-bumped to its home entrance (not knocked to start) exactly like
      // any other move, so this mercy start doesn't quietly fall back to solo
      // rules for the rest of the game.
      const pegInStart = pegs[player].findIndex(p => p.location === 'start');
      if (pegInStart !== -1) {
        const { newPegs: afterStart, ok, displacements } = applyComeOut(player, pegInStart, pegs, { actor: player, mode: gameMode });
        if (ok) {
          newPegs = afterStart;
          autoStarted = true;
          startDisplacements = displacements;
        }
      }
      newStuckCounts[player] = 0; // Reset even if no peg to start
    }

    // Record last move description for discard
    const updatedLastMoves = [...lastMoves];
    updatedLastMoves[player] = autoStarted ? 'Stuck 3x - Started a peg' : 'Discarded (stuck)';
    setLastMoves(updatedLastMoves);

    const discardFrame = {
      player,
      description: autoStarted ? 'Stuck 3x — started a peg' : 'No move — discarded',
      pegsBefore: pegs,
      pegsAfter: newPegs,
      segments: [],
    };
    // Log other seats' discards into the replay buffer too, so a stuck
    // opponent's turn is still accounted for when you watch the replay.
    if (!ownsSeat(player)) {
      recordReplayFrame(discardFrame);
    }

    // A forced come-out can land on somebody, and a bump is a bump however it
    // was caused: hold the board through the fly-back and the pause after it,
    // the same as any other special play.
    if (autoStarted) holdBoard(triggerMoveEffects(pegs, newPegs, player, startDisplacements));

    setPegs(newPegs);
    setHands(newHands);
    setDeck(newDeck);
    setDiscardPiles(updatedDiscardPiles);
    setStuckCounts(newStuckCounts);
    setSelectedCard(null);
    setSelectedPeg(null);
    setDiscardMode(false);

    setNotice(null);

    // Turns counter fix (§4.4): once per seat that actually moves — a stuck
    // discard is still a turn.
    turnsRef.current += 1;

    // Hand off. What just happened is already visible on the board — the
    // last-move label under the seat and its stuck counter — so nothing is
    // announced here. The old code posted three messages on 1200/1500 ms
    // timers, which then fired after a win had landed and overwrote the win
    // text; the status line derives itself now and there are no timers left to
    // outlive their turn.
    const nextPlayer = (player + 1) % 4;
    if (ownsSeat(player)) {
      // §4.1: this is one of the four human-turn-end sites — publish exactly
      // once, at handoff (no-op in solo).
      commitTurn({
        nextPlayer, pegs: newPegs, hands: newHands, deck: newDeck, discardPiles: updatedDiscardPiles,
        stuckCounts: newStuckCounts, lastMoves: updatedLastMoves, frame: discardFrame,
      });
    } else {
      setCurrentPlayer(nextPlayer);
      aiProcessingRef.current = false; // Allow the next AI seat to process
    }
  }, [hands, deck, discardPiles, stuckCounts, pegs, lastMoves, triggerMoveEffects, recordReplayFrame, gameMode, ownsSeat, commitTurn, holdBoard]);

  // AI logic - drives the AI seats this client is responsible for.
  //
  // §4.2's gate: a client runs an AI seat forward only when the run of AI
  // seats starting there terminates at one of ITS OWN seats — i.e. it is the
  // client that will next need this AI's move to reach its own turn. This
  // replaces the earlier (insufficient) `!isAISeat` check, which only stopped
  // a client from running the *other* human's turn but let both clients
  // simulate the same AI move independently (a double-simulation bug that had
  // no write to race on yet, so nothing had caught it). `shouldSimulateAI` is
  // `nextHumanSeat` + `ownsSeat` as one predicate (net/seats.js); in solo every
  // chain leads back to seat 0, so this is always true there and solo behaviour
  // is unchanged.
  //
  // In a remote game, this effect only ever runs as a *catch-up* simulation —
  // never as a live continuation of this client's own move, because the fixed
  // human/AI/human/AI layout means the seat right after your own move is
  // always AI, and its chain always leads to the OTHER human, never back to
  // you (see the gate trace in CLAUDE.md). So `session != null` is exactly
  // "run this silently": no animation, no thinking delay, so the whole chain
  // resolves as fast as React will commit it, ready for the auto-replay
  // (Package 5) to play back at a watchable pace afterwards.
  useEffect(() => {
    if (isMyTurn || winner !== null) return;
    if (!shouldSimulateAI(currentPlayer, seatOwners)) return;
    // Wait for a cosmetic playback to finish. This is what stops an opponent
    // from starting its move while your own peg is still counting itself along
    // the board, and what spaces consecutive AI turns apart by `settleMs`.
    if (visualBusy) return;
    if (aiProcessingRef.current) return; // Already processing this turn

    aiProcessingRef.current = true;
    const aiPlayer = currentPlayer;
    const nextPlayer = (currentPlayer + 1) % 4;
    const silent = session != null;

    const timer = setTimeout(() => {
      aiTimerRef.current = null;
      const aiHand = hands[aiPlayer];

      // Helper function to complete AI move.
      //
      // `joker` is `{ player, pegIndex }` when the move was a joker, and null
      // otherwise — the one move whose effects don't start when this is called:
      // its card is thrown up over the board first and everything waits on it
      // (see the human joker site for the sequence).
      const completeAIMove = (newPegs, card, moveDescription, displacements = [], joker = null) => {
        // Record last move description for AI
        const updatedLastMoves = [...lastMoves];
        updatedLastMoves[aiPlayer] = moveDescription;
        setLastMoves(updatedLastMoves);

        // No landing delay: an AI move calls this *after* its peg has finished
        // gliding, so the chimes and the bump are already in time with the
        // board. A joker is the exception — nothing has travelled yet, and its
        // card is still throbbing over the middle of the board.
        // A silent catch-up simulation (remote) shows none of this and must not
        // be slowed down by it — it is racing to get to the auto-replay, which
        // is what the player actually watches.
        const showJoker = joker != null && !silent;
        const jokerDelay = showJoker && animationsEnabled ? JOKER_CARD_HOLD_MS : 0;
        const specialHoldMs = triggerMoveEffects(
          pegs, newPegs, aiPlayer, displacements, jokerDelay, { joker: showJoker ? joker : null },
        );
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

        // Turns counter fix (§4.4): count directly here, once per seat that
        // actually moves — including the winning move — rather than inferring
        // it from a currentPlayer transition (which double-counts or
        // undercounts across an adopted remote state).
        turnsRef.current += 1;

        const w = checkWinner(newPegs, gameMode);
        if (w !== null) {
          endGame(w, { winningSeat: aiPlayer, description: moveDescription });
          // A decision the plan doesn't spell out: §4.2 says the AI effect's
          // own player-advance "must stay purely local", folded into this
          // client's *next* human publish. But if the AI's move ends the
          // game, there is no next human publish to fold it into — this
          // client's own turn never arrives, so without publishing here the
          // partner would never learn the game ended. A game-ending AI move
          // is therefore the one case where this effect publishes directly,
          // exactly as if it were the human turn that "ended" (no-op in
          // solo). `frame` is omitted: recordReplayFrame already pushed this
          // move onto replayLogRef above, so seedReplay(replayLogRef.current)
          // already carries it as the last frame.
          commitTurn({
            nextPlayer, pegs: newPegs, hands: newHands, deck: newDeck, discardPiles: updatedDiscardPiles,
            stuckCounts: newStuckCounts, lastMoves: updatedLastMoves,
            winner: w, winningSeat: aiPlayer, description: moveDescription,
          });
          return true;
        }

        // The settle beat: hold the board (and the "Blue played 7♠" banner) for
        // a moment before the next seat starts thinking, so a run of three AI
        // turns reads as three separate events instead of one blur. The next
        // turn is gated on `visualBusy`, so this is the whole mechanism.
        //
        // A special play adds its flights and its two seconds on top (and a
        // joker its card, which hasn't even dropped yet): the opponent after a
        // bump should be watching the same thing you are, not already moving.
        if (!silent) {
          holdBoard(pacing.settleMs + jokerDelay + specialHoldMs);
        } else {
          setNowPlaying(null);
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
        // What the move shoved off its space, straight from the engine (both
        // halves' worth for a split — see getPossibleMoves).
        const displacements = bestMove.displacements ?? [];
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
        // §5.3 attribution — see the same note in executeMove. A joker never
        // moves the owner's own peg (it bumps a target), so it's excluded.
        const frameDescription = bestMove.type === 'joker'
          ? moveDescription
          : attributeFrameDescription(moveDescription, aiPlayer, owner);
        recordReplayFrame({
          player: aiPlayer,
          description: frameDescription,
          pegsBefore: pegs,
          pegsAfter: bestMove.newPegs,
          segments: replaySegments,
        });

        const jokerPeg = bestMove.type === 'joker' ? { player: owner, pegIndex: bestMove.pegIndex } : null;
        if (jokerPeg) {
          jokersPlayedRef.current[aiPlayer] += 1;
          // Same as the human joker site: nothing travels, so the only way to
          // know a joker was played is to be told — the banner, the cackle, and
          // the card left throbbing over the board before the peg sets off.
          // Skipped for a silent catch-up simulation, exactly like `nowPlaying`
          // below — that run isn't being watched; the auto-replay afterwards is.
          if (!silent) {
            announce([ANNOUNCEMENTS.joker]);
            sfx.evilLaugh();
          }
        }

        // Say who is moving and what they played, over the board, for as long
        // as the move takes. Cleared by the settle beat in completeAIMove.
        // The segments are exactly what is about to be animated (both halves of
        // a split; none at all for a joker), so they also give the overlay the
        // move's length — see `lifeMs` on showNowPlaying.
        if (!silent) {
          const travelMs = replaySegments.reduce(
            (ms, s) => ms + landingDelayFor(s.owner, s.pegIndex, s.card, s.amount, s.fromPegs),
            0,
          );
          showNowPlaying({
            player: aiPlayer, card: bestMove.card, description: moveDescription,
            // A joker's card is the move: it holds centre-board for its own
            // fixed span (and animates differently — see renderPlayedCard)
            // rather than being scaled to travel it doesn't have.
            lifeMs: jokerPeg ? JOKER_CARD_MS : travelMs + pacing.settleMs,
          });
        }

        // If animations are disabled, or this is a silent catch-up simulation
        // (Package 5 — remote, running ahead of the auto-replay), complete
        // immediately with no per-peg animation.
        if (!animationsEnabled || silent) {
          if (completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, displacements, jokerPeg)) return;
          return;
        }

        // Animate the move before completing
        if (bestMove.type === 'simple' || bestMove.type === 'start') {
          // Single move animation
          animateMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, displacements);
          });
        } else if (bestMove.type === 'split7' || bestMove.type === 'split9') {
          // Two-part animation for a split. Effects play once, at the end: the
          // board isn't committed until both halves have animated, so a bump
          // played after the first half would fly the peg away and then have it
          // reappear on the space it started from when the FX ended.
          animateMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, () => {
            // After first animation, animate second peg (may be the partner's)
            const afterFirstPegs = applyMove(owner, bestMove.pegIndex, bestMove.card, bestMove.amount, pegs, { actor: aiPlayer, mode: gameMode }).newPegs;
            animateMove(secondOwner, bestMove.secondPeg, bestMove.card, bestMove.remaining, afterFirstPegs, () => {
              completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, displacements);
            });
          });
        } else if (bestMove.type === 'joker') {
          // Joker — no glide to run (its path is empty by construction); the
          // card, the peg's flight and the bump all sequence off completeAIMove.
          completeAIMove(bestMove.newPegs, bestMove.card, moveDescription, displacements, jokerPeg);
        }
        return;
      }

      // No valid move, discard (discardAndDraw handles player transition for AI)
      discardAndDraw(aiPlayer);
      // §5.1: a silent catch-up simulation has no thinking delay. Otherwise the
      // pause comes from the pace setting — long enough at `slow` to notice
      // whose turn it is before the board changes under you.
    }, silent ? 0 : pacing.thinkMs);
    aiTimerRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (aiTimerRef.current === timer) aiTimerRef.current = null;
      aiProcessingRef.current = false;
    };
  }, [currentPlayer, isMyTurn, winner, hands, pegs, deck, discardPiles, stuckCounts, lastMoves, discardAndDraw, animationsEnabled, animateMove, triggerMoveEffects, recordReplayFrame, gameMode, ownsSeat, endGame, seatOwners, session, commitTurn, visualBusy, pacing.thinkMs, pacing.settleMs, announce, showNowPlaying, landingDelayFor, holdBoard]);

  // Chime + gentle buzz when control passes back to a seat you own
  useEffect(() => {
    const prev = prevPlayerRef.current;
    if (isMyTurn && prev !== null && !ownsSeat(prev) && winner === null) {
      sfx.yourTurn();
    }
    prevPlayerRef.current = currentPlayer;
  }, [currentPlayer, isMyTurn, winner, ownsSeat]);

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
      turns: turnsRef.current,
      jokersPlayed: jokersPlayedRef.current,
      bumpsDelivered: bumpsDeliveredRef.current,
      timesBumped: timesBumpedRef.current,
      startMode: startModeRef.current,
    });
  }, [
    pegs, hands, deck, discardPiles, stuckCounts, currentPlayer,
    splitRemaining, splitCard, splitPegIndex, splitOwner, lastMoves,
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

  // What the move on screen says, folded into the status line. The played card
  // is still drawn over the board; the *words* live in the status box, which is
  // where a player is already looking and which costs no layout to change.
  const statusMove = useMemo(
    () => (nowPlaying && !isReplaying && winner === null
      ? {
          player: nowPlaying.player,
          card: nowPlaying.card,
          description: nowPlaying.description,
          mine: ownsSeat(nowPlaying.player),
        }
      : null),
    [nowPlaying, isReplaying, winner, ownsSeat]
  );

  const statusParts = useMemo(
    () => describeStatusParts({
      phase, currentPlayer, splitRemaining, splitCard, jokerMode, discardMode, mode: gameMode,
      moving: animatingPeg != null, move: statusMove, replay: replayInfo,
    }),
    [phase, currentPlayer, splitRemaining, splitCard, jokerMode, discardMode, gameMode, animatingPeg,
     statusMove, replayInfo]
  );

  const outcome = useMemo(
    () => describeOutcome(winner, gameMode, mySeats),
    [winner, gameMode, mySeats]
  );

  // When the 📺 header button does something: your turn has come round, the
  // game is still running, and there are buffered opponent moves to watch.
  // (The button itself is always mounted — see the header — so this only
  // enables it, never adds or removes it.)
  const replayAvailable = !isReplaying && replayReady > 0 && isMyTurn && winner === null;

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

  // Mirror that same count onto the home-screen icon, so a game waiting on you
  // is visible without opening the app. Free to run: setAppBadge is a local OS
  // call, and the count is already derived for the in-app badge — no extra
  // listener, no extra read. Deliberately no cleanup function: the badge must
  // survive unmount, or closing the app would wipe the only signal there is
  // (see badge.js). A solo player never attaches the lobby listener, so
  // waitingCount stays 0 here and this only ever clears a badge that is
  // already empty.
  useEffect(() => {
    syncAppBadge(waitingCount);
  }, [waitingCount]);

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
    const { newPegs, bumped, displacements } = applyJoker(owner, jokerSourcePeg, targetPlayer, targetPegIndex, pegs, moveOptions);
    if (!bumped) {
      setNotice('That joker bump is not legal. Pick another target.');
      return;
    }

    // Record last move for Joker
    const friendly = gameMode === GAME_MODES.PARTNERS && sameTeam(targetPlayer, actor);
    const jokerDescription = friendly
      ? `Joker sent ${PLAYER_NAMES[targetPlayer]} to home stretch`
      : `Joker bumped ${PLAYER_NAMES[targetPlayer]}`;
    const updatedLastMoves = [...lastMoves];
    updatedLastMoves[actor] = jokerDescription;
    setLastMoves(updatedLastMoves);

    jokersPlayedRef.current[actor] += 1;
    // The joker's moment, and the one card that has to make its own. Its
    // animation path is empty by construction — the peg simply appears the
    // other side of the board — so instead: the card itself, dealt face-up over
    // the middle of the board and left there throbbing with a cackle over it
    // (JOKER_CARD_HOLD_MS), and only then the peg, pulsing, flying across to the
    // space it is taking, and only then the peg it knocks off.
    //
    // Everything after the card is `triggerMoveEffects`' business: it is handed
    // the joker's peg so it can lead the flight chain, and the card's hold as
    // the delay before any of it starts.
    announce([ANNOUNCEMENTS.joker]);
    sfx.evilLaugh();
    showNowPlaying({ player: actor, card, description: jokerDescription, lifeMs: JOKER_CARD_MS });
    const jokerDelay = animationsEnabled ? JOKER_CARD_HOLD_MS : 0;
    const specialHoldMs = triggerMoveEffects(pegs, newPegs, actor, displacements, jokerDelay, {
      joker: { player: owner, pegIndex: jokerSourcePeg },
    });
    // Nothing else animates, so this hold *is* the joker's animation: the card,
    // the flights, and then the pause before the next seat plays.
    holdBoard(jokerDelay + specialHoldMs);

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

    // A joker's animation path is empty (no gliding peg to show), so the
    // frame carries only the before/after snapshot — same as the AI's joker
    // frame above.
    const frame = {
      player: actor,
      description: jokerDescription,
      pegsBefore: pegs,
      pegsAfter: newPegs,
      segments: [],
    };

    turnsRef.current += 1; // §4.4: once per seat that actually moves

    const w = checkWinner(newPegs, gameMode);
    const nextPlayer = (actor + 1) % 4;
    if (w !== null) {
      endGame(w, { winningSeat: actor, description: jokerDescription });
      commitTurn({
        nextPlayer, pegs: newPegs, hands: newHands, deck: newDeck, discardPiles: updatedDiscardPiles,
        stuckCounts: newStuckCounts, lastMoves: updatedLastMoves, frame, winner: w, winningSeat: actor, description: jokerDescription,
      });
      return;
    }

    // §4.1: this is one of the four human-turn-end sites — publish exactly
    // once, at handoff (no-op in solo).
    commitTurn({
      nextPlayer, pegs: newPegs, hands: newHands, deck: newDeck, discardPiles: updatedDiscardPiles,
      stuckCounts: newStuckCounts, lastMoves: updatedLastMoves, frame,
    });
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

  // A peg that is mid-glide is drawn once, by the animation layer — every other
  // place that would draw it (its start slot, its home slot, its space on the
  // track) renders empty instead, so a move never shows two of the same peg.
  const isPegAnimating = (player, pegIndex) =>
    animatingPeg != null && animatingPeg.player === player && animatingPeg.pegIndex === pegIndex;

  // Same rule for a peg the bump layer has taken over — including the hold
  // before impact, when the board state already has it at its destination but
  // the eye should still see it on the space it hasn't been knocked off yet.
  // Without this a friendly bump (which lands on the track, not in a start slot)
  // showed two of the peg for the length of the fly.
  // It covers every peg in the chain, not just the one currently in flight: a
  // peg still waiting for its turn in the cascade is drawn by the bump layer
  // too, sitting on the space the board says it has already left.
  const isPegBumping = (player, pegIndex) =>
    bumpFx != null && bumpFx.items.some(it => it.player === player && it.pegIndex === pegIndex);

  // The card being played, dealt large over the middle of the board and then
  // dropped onto its owner's discard pile — the one moment at a real table
  // where you can see what someone actually spent, and knowing an opponent has
  // just burned their King is half of following the game.
  //
  // This is an *overlay*, and that is the whole point of it. It used to be a
  // bordered "Blue played 7♠" box in the page flow above the board, joined by a
  // "Recent moves" list: on a phone the box appeared and vanished with every
  // single move, shoving the board down the screen and yanking it back up a
  // second later, and the list ate the space the board needed. For anyone not
  // already fluent in the game, a board that jumps around is worse than no
  // commentary at all. Drawn over the board, it costs no layout: nothing moves.
  //
  // Same viewBox as the board (like the taunt overlay), so it scales with it
  // and the discard-pile target follows the board rotation for free.
  const renderPlayedCard = () => {
    if (!nowPlaying || isReplaying || winner !== null) return null;
    const { id, player, card, lifeMs } = nowPlaying;
    const colour = PLAYER_COLORS[player];
    const isRed = card && (card.suit === '♥' || card.suit === '♦');
    const isJoker = card && card.rank === 'JOKER';
    const ink = isRed ? '#DC2626' : '#1F2937';

    // Where the card is headed. Read from the same slot table the piles
    // themselves are drawn from, so the two can't drift apart.
    const slot = DISCARD_SLOTS[visualSideFor(player, mySeat)];
    const dx = slot.x + DISCARD_CARD_W / 2 - PLAYED_CARD.cx;
    const dy = slot.y + DISCARD_CARD_H / 2 - PLAYED_CARD.cy;

    // Land the card by the time the move ends, but never dawdle over the middle
    // of the board for more than a beat and a half — a peg crossing half the
    // board at the slow pace takes several seconds, and "briefly" is the point.
    //
    // The joker is the exception, and deliberately breaks both rules: its card
    // is the only visible part of the move until the peg leaves the ground, so
    // it holds centre-board for a fixed JOKER_CARD_MS, throbbing (a keyframe of
    // its own, `pnj-card-joker`), and drops onto the pile exactly as the peg
    // sets off — the flight is scheduled off the same constant.
    const flightMs = isJoker
      ? JOKER_CARD_MS
      : Math.min(PLAYED_CARD_MAX_MS, Math.max(PLAYED_CARD_MIN_MS, lifeMs || 0));

    const left = PLAYED_CARD.cx - PLAYED_CARD.w / 2;
    const top = PLAYED_CARD.cy - PLAYED_CARD.h / 2;

    // The words that used to sit in a pill above this card ("Blue — Space 20 to
    // Space 25") are now the status line (see `statusMove` / `describeStatusParts`).
    // The board shows the card; the status box says what it did. Two captions
    // for one move, one of them floating over the piles in the middle of the
    // board, was one too many.
    return (
      <svg
        viewBox="0 0 400 400"
        className="pointer-events-none absolute inset-0 w-full h-full z-10"
        aria-hidden="true"
      >
        {/* The card itself: pops in, holds, then shrinks away onto the pile. */}
        {card && (
          <g
            key={`card-${id}`}
            className={isJoker ? 'pnj-card-joker' : 'pnj-card-play'}
            style={{
              '--pnj-card-dx': `${dx}px`,
              '--pnj-card-dy': `${dy}px`,
              animationDuration: `${flightMs}ms`,
              filter: isJoker
                ? 'drop-shadow(0 0 10px rgba(168, 85, 247, 0.95)) drop-shadow(0 3px 5px rgba(0,0,0,0.65))'
                : 'drop-shadow(0 3px 5px rgba(0,0,0,0.65))',
            }}
          >
            <rect
              x={left} y={top} width={PLAYED_CARD.w} height={PLAYED_CARD.h}
              rx="4" fill="white"
              stroke={isJoker ? ANNOUNCEMENTS.joker.color : colour}
              strokeWidth={isJoker ? 4 : 3}
            />
            {isJoker ? (
              <>
                {/* Bigger than the rank-and-suit of an ordinary card, and in
                    the joker's own purple: at a glance across a table, the
                    shape and colour are what say "this is the bad one". */}
                <text x={PLAYED_CARD.cx} y={top + 38} textAnchor="middle" fontSize="30">🃏</text>
                <text
                  x={PLAYED_CARD.cx} y={top + 54} textAnchor="middle"
                  fill={ANNOUNCEMENTS.joker.color} fontSize="10" fontWeight="bold"
                >
                  JOKER
                </text>
              </>
            ) : (
              <>
                <text x={PLAYED_CARD.cx} y={top + 30} textAnchor="middle" fill={ink} fontSize="22" fontWeight="bold">
                  {card.rank}
                </text>
                <text x={PLAYED_CARD.cx} y={top + 52} textAnchor="middle" fill={ink} fontSize="18">
                  {card.suit}
                </text>
              </>
            )}
          </g>
        )}
      </svg>
    );
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-2 sm:p-4">
      <InstallPrompt />

      {/* My Games lobby. A modal overlay in the same style as the stats/resume
          modals — not a route. Populated by one subscribeMyGames listener, so it
          updates itself when a partner moves whether or not it is open. */}
      {showLobby && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90dvh] overflow-y-auto">
            <div className="flex justify-between items-center gap-2 p-4 sm:p-5 pb-3 border-b border-gray-700 sticky top-0 bg-gray-800">
              <h2 className="text-xl sm:text-2xl font-bold">🎮 My Games</h2>
              <button
                onClick={() => setShowLobby(false)}
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-lg leading-none flex-shrink-0"
                aria-label="Close My Games"
              >
                ✕
              </button>
            </div>

            <div className="p-4 sm:p-5 space-y-3">
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
          metadata listener deals automatically the moment they do. Yields to
          the lobby (both are z-50 overlays) so "My Games" below can open it. */}
      {hostInfo && !showLobby && (
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
            {/* Two ways out, because this modal covers the whole screen: a host
                waiting here still needs to reach their other games. */}
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setShowLobby(true)}
                className="text-sm text-gray-400 hover:text-gray-200"
              >
                My Games
              </button>
              <button
                onClick={() => { setHostInfo(null); switchToGame('solo'); }}
                className="text-sm text-gray-400 hover:text-gray-200"
              >
                Return to solo
              </button>
            </div>
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
      {/* Package 5's settle/present split: `winner` is set immediately when
          the game ends (endGame), but the overlay itself waits for any
          in-flight replay to finish — a remote win auto-replays the winning
          move first, so the player sees it before the result appears. */}
      {winner !== null && outcome && !isReplaying && !endOverlayDismissed && (
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
        {/* The header wraps rather than overflowing. On a ~360px phone the five
            controls cannot sit beside the title, and in a single non-wrapping row
            they used to push "New Game" off the right edge *and* widen the
            document — which in turn widened the layout viewport that every
            `position: fixed` modal sizes against, so the modals rendered wider
            than the screen too. Two groups, so the wrap lands somewhere chosen:
            the two small toggles stay beside the title, and the three actions
            drop to a full-width row of equal, thumb-sized buttons. From `sm` up
            the width overrides collapse and it is one row again, as before. */}
        <div className="flex flex-wrap justify-end items-center gap-2 mb-4">
          {/* The auto margin belongs on the title, not on a button group: on a
              group it would swallow the row's free space and force the wrap even
              on a wide screen. */}
          <h1 className="text-xl sm:text-2xl font-bold mr-auto">Pegs and Jokers</h1>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => {
                unlockAudio();
                const next = !soundOn;
                setSoundOn(next);
                setMuted(!next);
              }}
              className="px-2.5 sm:px-3 py-2 rounded text-sm bg-gray-700 hover:bg-gray-600"
              aria-label={soundOn ? 'Mute sound and vibration' : 'Unmute sound and vibration'}
            >
              {soundOn ? '🔊' : '🔇'}
            </button>
            {/* Four-way pace control, cycling slow → normal → fast → off. It
                replaced an on/off toggle: "off" was the only escape from a
                150ms-per-space peg, which is not a choice anyone who wants to
                *follow* the game should have to make. */}
            <button
              onClick={() => setAnimationSpeed(nextSpeed(animationSpeed))}
              className={`px-2.5 sm:px-3 py-2 rounded text-sm whitespace-nowrap ${
                animationsEnabled
                  ? 'bg-green-600 hover:bg-green-700'
                  : 'bg-gray-600 hover:bg-gray-700'
              }`}
              aria-label={`Move speed: ${pacing.label}. Tap to change.`}
              title="How fast pegs move around the board"
            >
              <span aria-hidden="true">{pacing.icon}</span>
              <span className="hidden sm:inline"> Speed:</span>
              {` ${pacing.label}`}
            </button>
            {/* Instant replay, as a toggle beside the pace control. It is
                *always* mounted — disabled and dimmed when there is nothing to
                watch — because as a button that came and went with each turn it
                pushed the whole board down the screen every time it appeared.
                While a replay runs it becomes the Stop button, so the playback
                banner (which did the same thing again, for as long as the
                replay lasted) is gone too; the progress reads in the status
                line instead. */}
            <button
              onClick={isReplaying ? stopReplay : startReplay}
              disabled={!isReplaying && !replayAvailable}
              className={`relative px-2.5 sm:px-3 py-2 rounded text-sm whitespace-nowrap ${
                isReplaying
                  ? 'bg-purple-600 hover:bg-purple-700'
                  : replayAvailable
                    ? 'bg-purple-700 hover:bg-purple-600'
                    : 'bg-gray-700 opacity-40 cursor-not-allowed'
              }`}
              aria-label={
                isReplaying
                  ? 'Stop the instant replay'
                  : replayAvailable
                    ? `Instant replay: watch the last ${replayReady} ${replayReady === 1 ? 'move' : 'moves'}`
                    : 'Instant replay: nothing to replay yet'
              }
              title="Instant replay of the moves since your last turn"
            >
              {/* ⏹ while it is running: on a phone the label is hidden, and a
                  lit-up 📺 doesn't say "tap me to stop" on its own. */}
              <span aria-hidden="true">{isReplaying ? '⏹' : '📺'}</span>
              {isReplaying && <span className="hidden sm:inline"> Stop</span>}
              {!isReplaying && replayAvailable && (
                <span
                  className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-gray-900"
                  aria-hidden="true"
                >
                  {replayReady}
                </span>
              )}
            </button>
          </div>
          <div className="flex gap-2 items-center w-full sm:w-auto">
            {multiplayerConfigured && (
              <button
                onClick={() => setShowLobby(true)}
                className="relative flex-1 sm:flex-none px-2.5 sm:px-4 py-2 rounded text-sm sm:text-base bg-teal-600 hover:bg-teal-700 whitespace-nowrap"
              >
                <span aria-hidden="true">🎮</span> My Games
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
              className="flex-1 sm:flex-none px-2.5 sm:px-4 py-2 rounded text-sm sm:text-base bg-indigo-600 hover:bg-indigo-700 whitespace-nowrap"
            >
              <span aria-hidden="true">📊</span> Stats
            </button>
            <button
              onClick={startNewSoloGame}
              className="flex-1 sm:flex-none px-2.5 sm:px-4 py-2 rounded text-sm sm:text-base bg-blue-600 hover:bg-blue-700 whitespace-nowrap"
            >
              New Game
            </button>
          </div>
        </div>

        {/* The status line is derived from `phase` — it can never be stale, and
            in particular never reads "Blue is thinking…" after the game ends.
            `notice` sits under it for transient feedback and clears itself on
            the next phase change. */}
        {/* `aria-live` so a screen reader (or VoiceOver on an iPad, which is
            how a lot of people play) speaks each change of turn instead of the
            player having to notice it. Polite, so it never interrupts. */}
        {/* Two lines' worth of height is reserved whether or not both are used.
            This box now carries the move commentary as well as the turn, so it
            is the one element on the page whose text length changes with every
            move — left to size itself it would grow and shrink under the board
            and shove it up and down the screen, which is exactly what the
            overlays were introduced to stop. Clamped to two lines for the same
            reason: the longest line in the game (a split, described in full)
            must not be able to make a third. */}
        <div className="text-center mb-4 p-2 bg-gray-800 rounded" aria-live="polite">
          <div className="min-h-[3.5rem] flex flex-col items-center justify-center">
            <div className="text-base sm:text-lg line-clamp-2">
              {statusParts.prefix && <span className="text-gray-300">{statusParts.prefix} </span>}
              {statusParts.who && (
                <span className="font-bold" style={{ color: PLAYER_COLORS[statusParts.player] }}>
                  {statusParts.who}
                </span>
              )}
              {statusParts.who && statusParts.detail ? ' ' : ''}
              {statusParts.detail}
            </div>
          </div>
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

        {/* §5.2: remote, but animations are off — no auto-replay (there'd be
            nothing to watch), so summarize what happened as text instead. */}
        {session && !animationsEnabled && !isReplaying && replayDescriptions.length > 0 && isMyTurn && winner === null && (
          <div className="mb-4 p-3 rounded bg-gray-800 text-sm">
            <div className="font-semibold mb-1">Since your last turn:</div>
            <ul className="space-y-0.5">
              {replayDescriptions.map((f, i) => (
                <li key={i}>
                  <span className="font-semibold" style={{ color: PLAYER_COLORS[f.player] }}>{PLAYER_NAMES[f.player]}</span>
                  <span className="text-gray-300"> — {f.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The instant-replay button and its playback banner used to live here,
            between the status box and the board. Both appeared and disappeared
            on their own schedule — the button the moment your turn came round,
            the banner for the length of the replay — and each one shoved the
            board down the screen and pulled it back up again. They are now the
            📺 toggle in the header (which is always mounted, so it changes
            nothing about the layout) and the replay's progress is in the status
            line, alongside everything else that is "what is happening now". */}

        <div className="flex flex-col lg:flex-row gap-4 items-center lg:items-start">
          {/* Game Board */}
          <div className="flex-shrink-0 w-full max-w-[400px] relative">
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
                    // While a bumped peg is waiting to be hit or flying back — or
                    // gliding through a move — its start slot renders empty, so
                    // there is only ever one of it on the board.
                    const isFlyingBack = isPegBumping(player, i);
                    const hasPeg = pegs[player][i]?.location === 'start' && !isFlyingBack && !isPegAnimating(player, i);
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
                    const pegIndex = pegs[player].findIndex(p => p.location === 'home' && p.homePosition === i);
                    // Empty while that peg is mid-glide: a human move commits
                    // its state before the cosmetic playback runs, so without
                    // this the peg would be sitting in its home slot while a
                    // copy of it is still counting its way there.
                    const hasPeg = pegIndex !== -1 && !isPegAnimating(player, pegIndex);
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
                  // The gliding copy — and the copy the bump layer is holding or
                  // flying — is drawn separately, below.
                  if (isPegAnimating(player, pegIndex)) return null;
                  if (isPegBumping(player, pegIndex)) return null;

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

              {/* The bumped pegs: each pinned on the space it still occupies
                  until the peg that bumps it arrives, then flying to wherever
                  it was sent. Drawn as ordinary track pegs while they wait —
                  nothing has happened to them yet, and colouring one early
                  would give the bump away before the move that causes it. In a
                  cascade the second peg waits, unglowed, through the first
                  peg's flight and then sets off itself. */}
              {bumpFx && bumpFx.items.map((item) => {
                // The entrance swap is the one bump whose victim is the *mover*
                // — a partner sitting on its own entrance keeps the space and
                // shoves the arriving peg on to its entrance instead. That peg
                // is still gliding in while this layer is holding it on the
                // space it is about to reach, which would draw it twice. The
                // glide owns it until the glide ends.
                if (isPegAnimating(item.player, item.pegIndex)) return null;
                const elapsed = bumpFx.holding ? 0 : bumpFx.tick - item.startTick;
                const p = Math.max(0, Math.min(1, elapsed / BUMP_FLY_STEPS));
                const t = 1 - Math.pow(1 - p, 3); // ease-out
                const x = item.from.x + (item.to.x - item.from.x) * t;
                const y = item.from.y + (item.to.y - item.from.y) * t;
                // The joker's own peg is the one item here that is *making* the
                // move rather than suffering it, so it gets the card's purple
                // and is lit from the moment the card lands — the whole point
                // is to know which peg to watch before it moves. Friendly
                // partner bumps fly forward (green); knock-backs fly to start
                // (red), and neither is coloured until it is actually hit.
                const isJokerPeg = item.kind === 'joker';
                const glow = isJokerPeg
                  ? ANNOUNCEMENTS.joker.color
                  : (item.kind === 'friendly' ? '#22C55E' : '#EF4444');
                const shadow = isJokerPeg
                  ? 'drop-shadow(0 0 6px rgba(168, 85, 247, 0.95))'
                  : (item.kind === 'friendly'
                    ? 'drop-shadow(0 0 4px rgba(34, 197, 94, 0.9))'
                    : 'drop-shadow(0 0 4px rgba(239, 68, 68, 0.9))');
                // Waiting its turn (or held before impact) — still an ordinary
                // peg, unless it is the joker's, which pulses on its own space
                // for the whole time the card is throbbing over the board.
                const waiting = !isJokerPeg && (bumpFx.holding || bumpFx.tick < item.startTick);
                return (
                  <g key={`bumpfx-${item.player}-${item.pegIndex}`}>
                    {isJokerPeg && (
                      <circle cx={x} cy={y} r={13} fill={glow} opacity={0.3} className="joker-peg" />
                    )}
                    <circle
                      cx={x}
                      cy={y}
                      r={isJokerPeg ? 8 : 7}
                      fill={PLAYER_COLORS[item.player]}
                      stroke={waiting ? '#1F2937' : glow}
                      strokeWidth={waiting ? 1 : (isJokerPeg ? 3 : 2)}
                      style={waiting ? undefined : { filter: shadow }}
                      className={isJokerPeg ? 'joker-peg' : undefined}
                    />
                  </g>
                );
              })}

              {/* Animating peg — one space at a time, with everything needed to
                  follow it: a ghost on the space it left, a fading trail over
                  the spaces it has counted, a halo so the eye finds it, and the
                  running count of spaces moved. Between them you can look away,
                  look back, and still see where the peg came from and how far
                  it has got. */}
              {animatingPeg && (() => {
                const color = PLAYER_COLORS[animatingPeg.player];
                const anchorXY = (anchor) => {
                  if (!anchor) return null;
                  if (anchor.type === 'track') return getTrackPosition(anchor.position);
                  if (anchor.type === 'home') return getHomePosition(animatingPeg.player, anchor.position);
                  if (anchor.type === 'start') return getStartAreaPosition(animatingPeg.player, anchor.position);
                  return null;
                };

                const currentPos = animatingPeg.path[animatingPeg.currentStep];
                const pos = anchorXY(currentPos);
                if (!pos) return null;

                const ghost = anchorXY(animatingPeg.from);
                // Spaces already counted, oldest first. Older breadcrumbs fade,
                // so the direction of travel reads at a glance.
                const trail = animatingPeg.path.slice(0, animatingPeg.currentStep);
                const trailLen = trail.length;
                const count = animatingPeg.currentStep + 1;

                return (
                  <g>
                    {ghost && (
                      <circle
                        cx={ghost.x}
                        cy={ghost.y}
                        r={7}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        strokeDasharray="3 2"
                        opacity={0.55}
                      />
                    )}
                    {trail.map((anchor, i) => {
                      const p = anchorXY(anchor);
                      if (!p) return null;
                      return (
                        <circle
                          key={`trail-${i}`}
                          cx={p.x}
                          cy={p.y}
                          r={4}
                          fill={color}
                          opacity={0.15 + 0.35 * ((i + 1) / Math.max(trailLen, 1))}
                        />
                      );
                    })}
                    <circle cx={pos.x} cy={pos.y} r={13} fill={color} opacity={0.25} />
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={8}
                      fill={color}
                      stroke="white"
                      strokeWidth={3}
                      style={{ filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.8))' }}
                    />
                    {/* The count, the way you'd say it out loud: one, two,
                        three… Sits above the peg with its own dark plate so it
                        stays readable over any part of the board. */}
                    <circle cx={pos.x} cy={pos.y - 15} r={8} fill="#111827" opacity={0.85} />
                    <text
                      x={pos.x}
                      y={pos.y - 12}
                      textAnchor="middle"
                      fill="white"
                      fontSize="11"
                      fontWeight="bold"
                    >
                      {count}
                    </text>
                  </g>
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
                const pos = DISCARD_SLOTS[visualSideFor(player, mySeat)];
                const lastCard = discardPiles[player]?.[discardPiles[player].length - 1];
                const stuckCount = stuckCounts[player];

                return (
                  <g key={`discard-${player}`}>
                    {/* Player's last played card (face up) */}
                    {lastCard ? (
                      <g>
                        <rect x={pos.x} y={pos.y} width={DISCARD_CARD_W} height={DISCARD_CARD_H} rx="2" fill="white" stroke={PLAYER_COLORS[player]} strokeWidth="1.5" />
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
                      <rect x={pos.x} y={pos.y} width={DISCARD_CARD_W} height={DISCARD_CARD_H} rx="2" fill="none" stroke={PLAYER_COLORS[player]} strokeWidth="1" strokeDasharray="3" opacity="0.5" />
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

            {/* The card being played, over the board and then onto the pile.
                Rendered *before* the banners so a "Double Play!" is drawn on
                top of it rather than under it — a joker's banner and its card
                appear at the same instant. */}
            {renderPlayedCard()}

            {/* No `sr-only` companion here any more: the status box above is an
                `aria-live` region and now carries the same sentence ("Blue
                played 7♠ — Space 20 to Space 25"), so a second one would read
                every move twice. */}

            {/* "Joker!" / "Partner Bump!" / "Double Play!" — the three things
                that happen with nothing to watch, said large over the middle of
                the board. `aria-live` region is always mounted so a screen
                reader announces each one as it is inserted; pointer-events-none
                so a banner can never swallow a tap on the board underneath it. */}
            <div
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 z-10"
              aria-live="polite"
            >
              {!isReplaying && announcements.map((a) => (
                <div
                  key={a.id}
                  className="announce-pop px-4 py-2 rounded-xl border-2 bg-gray-900/85 font-extrabold text-2xl sm:text-3xl tracking-wide"
                  style={{
                    color: a.color,
                    borderColor: a.color,
                    textShadow: '0 2px 8px rgba(0,0,0,0.9)',
                  }}
                >
                  {a.text}
                </div>
              ))}
            </div>

            {/* The pegs having their say: the "@$#*!" of one knocked back to
                start, and the "Thanks!" / "You're welcome!" a partner bump
                earns. Its own overlay SVG rather than a layer inside the board,
                purely so it sits *above* the banners: a partner bump raises a
                banner and a bubble at the same time, and drawn inside the board
                the bubble ended up underneath the very message telling you to
                look at it. Same `viewBox` over the same box, so the position
                helpers need no adjustment and the bubbles follow the board
                rotation for free. Keyed on the bubble id so a fresh one plays
                the pop animation instead of re-using a finished one. */}
            <svg
              viewBox="0 0 400 400"
              className="pointer-events-none absolute inset-0 w-full h-full z-20"
              aria-hidden="true"
            >
              {speechBubbles.map((bubble) => {
                const pos = bubble.spot.area === 'track'
                  ? getTrackPosition(bubble.spot.position)
                  : getStartAreaPosition(bubble.player, bubble.spot.pegIndex);
                // Sized from the text, which now ranges from "@$#*!" to
                // "You're welcome!". The longer lines drop a point of type so a
                // bubble never spans a quarter of the board.
                const fontSize = bubble.text.length > 9 ? 10 : 13;
                const width = Math.max(40, bubble.text.length * fontSize * 0.63 + 14);
                const half = width / 2;
                // Kept inside the board: a bump on the outer edge of the track
                // would otherwise push the bubble off the side of the SVG.
                const cx = Math.min(Math.max(pos.x, half + 2), 398 - half);
                const cy = pos.y - 20; // bubble body sits above the peg
                return (
                  <g key={bubble.id} className="taunt-bubble">
                    <path
                      d={`M ${pos.x - 3} ${cy + 8} L ${pos.x + 4} ${cy + 8} L ${pos.x} ${cy + 15} Z`}
                      fill="#FFFFFF"
                      stroke={PLAYER_COLORS[bubble.player]}
                      strokeWidth={1.5}
                    />
                    <rect
                      x={cx - half} y={cy - 10} width={width} height={19} rx={9}
                      fill="#FFFFFF"
                      stroke={PLAYER_COLORS[bubble.player]}
                      strokeWidth={1.5}
                    />
                    <text
                      x={cx} y={cy + 4}
                      textAnchor="middle"
                      fill="#111827"
                      fontSize={fontSize}
                      fontWeight="bold"
                      style={{ fontFamily: 'monospace' }}
                    >
                      {bubble.text}
                    </text>
                  </g>
                );
              })}
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
