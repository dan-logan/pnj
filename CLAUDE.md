# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A digital implementation of the Pegs and Jokers board game built with React, Vite, and Tailwind CSS. Single-player game where you (Yellow) play against 3 AI opponents (Blue, Pink, Green).

## Commands

- `npm install` - Install dependencies
- `npm run dev` - Start development server
- `npm run build` - Build for production (outputs to `dist/`)
- `npm run preview` - Preview production build locally
- `npm test` - Run the Vitest suite once
- `npm run test:watch` - Run tests in watch mode

## Architecture

The rules engine is pure JavaScript (no React), separated from the UI so it can be unit-tested and reused:

- **src/game/constants.js** - Card values, board dimensions (72-space track, 18 per side), player colors/names. Also `GAME_MODES`, `TEAMS` (partners 0+2 vs 1+3) and the `getPartner`/`sameTeam` helpers used by partner mode
- **src/game/deck.js** - Deck creation (two 52-card decks + 4 jokers), shuffling, drawing with discard-pile reshuffle
- **src/game/engine.js** - Move validation (`isValidMove`, `hasAnyValidMove`), move application (`applyMove`), win detection, animation paths, UI affordances (`getValidDestinations`, `getMovablePegs`, `findBumps`). All functions take the peg state as an argument and return new state without mutating. Movement functions accept an `options` arg (`{ actor, mode }`) so a player can move a partner's pegs and so the partner friendly-bump rule applies; `applyJoker` and `findFriendlyBumps` support partner mode, and `checkWinner(pegs, mode)` returns a team index in partner mode
- **src/game/ai.js** - AI move enumeration and scoring (`getPossibleMoves`, `findBestAIMove`); prioritizes moves that advance toward home, avoids vulnerable positions. In partner mode it scores by team distance, plays for its partner once its own pegs are all home, and values friendly-bump jokers
- **src/game/stats.js** - Persistent player statistics in localStorage; pure record/derive logic with an optional injectable storage backend. `didIWin`/`winningSeats` interpret a winner correctly per mode (classic: a player index; partners: a *team* index). `recordFinishedGame(gameId, result)` is idempotent, deduping on `pnj:recordedGames:v1` (FIFO, capped)
- **src/game/status.js** - Pure derivation of what the game is doing and how it reads: `derivePhase`, `describeStatus`, `describeOutcome`. See "Game phase and status" below
- **src/net/seats.js** - Pure seat-ownership helpers, no React: `mySeatsOf`, `primarySeat`, `isMyTurnFor`, `isAISeat`, and the board-rotation math `visualSideFor`/`seatAtVisualSide`. See "Seat ownership" below
- **src/game/persistence.js** - Save/resume of an in-progress game to localStorage (`serializeGame`, `saveGame`, `loadGame`, `clearGame`, `isResumable`). Snapshots pegs/hands/deck/discards/currentPlayer plus split state, per-game stat tallies and the game's `gameId` as plain JSON. Same injectable-storage pattern as stats.js; no-ops without storage
- **src/audio.js** - Web Audio synth sound effects + `navigator.vibrate` haptics with a persisted mute setting; all no-ops outside a browser
- **src/PegsAndJokers.jsx** - React component: game state via hooks, turn flow, input handlers, SVG board rendering. Turn gating, actor identity and board orientation all derive from `seatOwners` (see "Seat ownership"). Move input is tap-driven: selecting a card glows the movable pegs (`getMovablePegs`), selecting a peg with a 7/9 renders tappable ghost destination circles (`getValidDestinations`). A `useEffect` snapshots the game to localStorage after every committed change and clears it on win; on load it offers a "Resume game?" modal when a save exists. **Instant replay:** each AI move (and stuck-discard) is recorded into a `replayLogRef` buffer as a frame (`{ player, description, pegsBefore, pegsAfter, segments }`); the buffer resets when you hand off your turn and holds exactly the opponents' moves since your last turn. When it's your turn a "📺 Instant Replay" button plays them back slowed down, driving the board from the recorded peg snapshots (reusing `calculateMovePath`/`animatingPeg`) and restoring the live board when it finishes or you press Stop. Interaction handlers and the persistence effect are gated on `isReplaying` so playback never mutates the real game or save
- **src/InstallPrompt.jsx** - Dismissible "Add to Home Screen" banner: replays the captured `beforeinstallprompt` on Chrome/Android, shows manual Share-sheet instructions on iOS Safari, hidden when already installed
- **src/main.jsx** - React entry point
- **src/index.css** - Tailwind imports plus small keyframe animations for peg glow/ghost destinations

### Seat ownership

The component never assumes "the local human is player 0". A single `seatOwners` state array says who owns each of the four seats **from this client's point of view**:

| Layout | `seatOwners` |
|---|---|
| Solo (today's only mode) | `['me', 'ai', 'ai', 'ai']` |
| Remote host | `['me', 'ai', 'them', 'ai']` |
| Remote guest | `['them', 'ai', 'me', 'ai']` |

Everything else is derived from it (helpers in `src/net/seats.js`):

- `mySeats` — every seat this client controls, **an array** even though only one seat is ever owned today, so a client driving two seats needs no second refactor. `ownsSeat(p)` is the membership test.
- `mySeat` — the primary seat: whose hand is shown, who acts as the engine `actor`, and whose board edge faces the player.
- `isMyTurn` — replaces every `currentPlayer === 0` turn gate.
- Board rotation — seat `x` is drawn on visual side `(x - mySeat + 2) mod 4` (0 top, 1 right, 2 bottom, 3 left), so your own seat is always at the bottom. `getTrackPosition` / `getStartAreaPosition` / `getHomePosition`, the discard-pile corners and the four board labels all go through `visualSideFor` / `seatAtVisualSide`. With `mySeat = 0` this collapses to the original `(x + 2) % 4`, which is why solo rendering is byte-for-byte unchanged.

Solo is not a special case in the code — it is just the layout whose only non-AI seat is seat 0.

### Game phase and status

The status line is **derived, never set**. `gameMessage` used to be imperative state written from ~40 call sites, several on 800–1500 ms timers; every win path set `winner` and returned *before* touching it, and the timers then fired after the game ended and overwrote the result — which is how "Blue is thinking…" ended up under a win banner. Instead:

- `phase` (`derivePhase`) is the single answer to "what is happening": `finished` → `replaying` → `dealing` → `my_turn` → `waiting_partner` / `ai_turn`, in that precedence.
- `statusLine` (`describeStatus`) renders the phase, folding in the split remainder, joker mode and discard mode.
- `notice` is the only imperative text — transient feedback like "Invalid move. Try again." — and clears itself on any phase change.
- `describeOutcome` phrases the result for the mode and the seat: "You and Pink win!", "Blue and Green win."

There are no status timers left. Don't add one; if something needs saying, derive it from state.

### Ending a game

`endGame(winner, { winningSeat, description })` is the **only** terminal transition, called from `executeMove`, `completeSplit`, `completeAIMove` and `handleJokerTarget`. It cancels every pending timer (animation, bump FX, both replay timers, the first-player spinner and the AI's thinking timeout), sets `winner`, and records stats. Adding a new win-detection site means calling `endGame`, not `setWinner`.

Stats are recorded from the **terminal state**, keyed by game id — not by watching the `winner` transition, which only fires for whoever happens to be looking. Every game gets an id (`newGameId()` locally; it round-trips through the save so resuming keeps it), and `recordFinishedGame` is a no-op for an id already in `pnj:recordedGames:v1`. So a result is counted exactly once whether you were open when it landed, and whether the winning move was yours, your partner's or an AI's. `didIWin(winner, mode, mySeats)` decides whether it was a win for you — in partner mode `winner` is a team index, so this is what credits you when your *partner's* move wins.

### PWA

`vite-plugin-pwa` (configured in `vite.config.js`, `registerType: 'autoUpdate'`) generates the service worker and web manifest at build time and precaches the built shell for offline play. Icons live in `public/` (`pwa-192x192.png`, `pwa-512x512.png`, `pwa-maskable-512x512.png`, `apple-touch-icon.png`, favicons) and were generated by `scripts/gen-icons.py` (Pillow). Manifest `start_url`/`scope` are relative (`.`) so install works from a GitHub Pages subpath.

Peg state shape: a 4-element array (one per player) of 5 peg objects, each `{ location: 'start' | 'track' | 'home', position?, homePosition?, index }`.

## Testing

Tests live next to the modules they cover (`src/game/*.test.js`, `src/net/*.test.js`) and run with Vitest. They cover deck composition, move validation for every card type (including 7/9 split rules and home-corridor edge cases), bumping, win detection, AI move selection, seat-ownership derivations, board rotation, phase/status derivation, and idempotent stats recording. CI (`.github/workflows/ci.yml`) runs tests and the build on every pull request, and the deploy workflow runs tests before deploying. When changing game rules, add or update engine tests in the same change. There is no component-test setup and none is planned: logic that needs testing belongs in a plain module, not in `PegsAndJokers.jsx`.

## Game Logic Key Concepts

- Track positions: 0-71 (18 spaces per side × 4 sides)
- Start position: `player * 18 + 8` (position 8 on each player's side)
- Home entrance: `player * 18 + 3` (position 3 on each player's side)
- Cards A/J/Q/K allow moving from start; 7 can split forward; 8 moves backward; 9 must split (forward + backward); Joker bumps opponent

### Partner mode

Note that `checkWinner(pegs, 'partners')` and everything downstream of it return a **team** index, not a player index — `stats.js`'s `didIWin`/`winningSeats` are how that is interpreted, including crediting both members of the winning team in the nemesis stat.

Selectable at game start (Classic is the default). Players sit opposite in teams — you (Yellow) + Pink vs Blue + Green. The team wins when both partners have all pegs home. Bumping a partner is legal and *strategic*: instead of going to start, a friendly-bumped peg lands on its owner's home-entrance space (`player*18+3`), ready to go home. If that entrance is occupied by an opponent it cascades (opponent → start); if occupied by that owner's own peg the whole move is illegal (like landing on your own peg). Once your own pegs are all home, your cards move your partner's pegs. Classic mode is unchanged — the engine `options` default (`actor === owner`, `mode: 'classic'`) preserves the original behavior.

## Deployment

GitHub Actions automatically deploys to GitHub Pages on push to `main`. The workflow is in `.github/workflows/deploy.yml`.
