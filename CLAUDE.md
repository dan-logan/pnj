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
- **src/net/seats.js** - Pure seat-ownership helpers, no React: `mySeatsOf`, `primarySeat`, `isMyTurnFor`, `isAISeat`, `nextHumanSeat`, the board-rotation math `visualSideFor`/`seatAtVisualSide`, and the `SOLO_/HOST_/GUEST_SEAT_OWNERS` layouts. See "Seat ownership" below
- **src/net/firebase.js** - Firebase config from `VITE_FIREBASE_*` env, `isMultiplayerConfigured()`, and the single lazy `import()` of the Firestore/Auth SDK (`getFirebase`). A solo player never triggers it. See "Remote play" below
- **src/net/protocol.js** - Pure wire-document builders that mirror the security rules exactly (`buildCreateMeta`/`buildJoinMeta`/`buildPublishMeta`, `isEcho`, `waitingSeatOf`, `STATUS`, seat constants). Heavily tested because a shape mismatch here is a rejected write
- **src/net/gameCode.js** - The 6-char join-code generator over an unambiguous alphabet (no 0/O/1/I/L); pure, injectable randomness
- **src/net/session.js** - The remote session client (the §2.5 interface): `signIn`, `createGame`, `joinGame`/`joinGameById`, `fetchGame`, `startGame`, `publishState`, `subscribeGameMeta`/`subscribeGameState`/`subscribeMyGames`. Talks to Firestore through an injectable backend (in-memory fake in tests). Stores the live state/replay as JSON blobs — Firestore can't hold the nested arrays in the game state
- **src/net/localSession.js** - The device's local cache/nickname store of its remote games (`pnj:games:v1`): labels, per-game seat, archive flag, `activeId`. A cache, not the source of truth — Firestore's `participants` is
- **src/net/lobby.js** - Pure lobby derivations: `buildRemoteRows`/`sortLobbyRows` (your-turn first, then recency), `countWaitingOnMe` (the badge), `relativeTime`, and `openActionFor` (what opening a game should do: `adopt` / `deal` / `await_guest` / `await_deal`). "Your turn" is `waitingOn === seat`, never `currentPlayer`
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

**`endGame` reads the mode and the seats from refs (`gameModeRef`/`mySeatsRef`), never from the render closure**, and is therefore dependency-free and stable. A remote game can end on the *other* device, so `endGame` frequently runs from the fetch or listener that adopted the finished state — and those callbacks were created before the `setGameMode`/`setSeatOwners` that opened the game took effect. Reading `gameMode`/`mySeats` there saw the mount defaults (`classic`, `['me','ai','ai','ai']`), which filed a remote *partner* win in the **Solo** bucket and summed seat 0's joker/bump tallies for a guest who plays seat 2 (the win/loss itself came out right only by luck: `winningSeats(0, 'classic')` is `[0]`, and team 0 contains seat 0). `setGameMode` and `setSeatOwners` are wrappers that write ref and state together — the same discipline `setActiveSession`/`sessionRef` already used — so **always go through them**, and prefer the refs over the closure in anything a listener or an `await` can outlive.

### Remote play

Two humans play partner mode against two AI opponents, asynchronously, each on their own device. It is entirely optional and entirely additive: with no `VITE_FIREBASE_*` config, or on a device with no remote games, the app is byte-for-byte the solo game — same first-player modal, same single local save, same resume prompt — and never signs in or downloads the Firestore SDK. All of Packages 0–5 of `docs/multiplayer-phase1-plan.md` are built: turn exchange and automatic replay work end to end. Package 6 (a manual playtest matrix and a final docs pass) is the only thing left.

**Turn exchange (§4.1–4.3).** A `commitTurn` helper is the single place a human turn ends: it advances `currentPlayer` locally and, if a remote session is open, publishes exactly once — never mid-turn. It is called from the four real handoff sites (`executeMove`, `completeSplit`, `discardAndDraw`'s human branch, `handleJokerTarget`) and, as one addition beyond what the plan spelled out, from the AI effect's own `completeAIMove` **only when that AI move ends the game** — see "One thing the plan didn't cover" below. A half-finished split never crosses the wire: `commitTurn` always publishes `splitRemaining`/`splitCard`/`splitPegIndex`/`splitOwner` as cleared, so a disconnect mid-split simply restarts that turn from the pre-split state when the player returns. The published state's `winningSeat`/`description` (added to `buildPublishMeta`/`publishState` beyond the plan's original sketch) are how the client that didn't make the winning move still learns who made it and what it was — the shared `state` blob itself has no `winner` field by design (see below).

**The AI-simulation gate (§4.2).** `shouldSimulateAI(currentPlayer, seatOwners)` (`src/net/seats.js`) is `nextHumanSeat` + `ownsSeat` as one predicate: a client runs an AI seat forward only when the chain of AI seats starting there terminates at one of its own seats. Exactly one client is ever eligible for a given AI turn — the one that needs the move to reach its own turn — so nothing double-simulates and nothing double-publishes. In solo every chain leads back to seat 0, so the predicate is always true there and solo is unaffected. In a remote game this effect only ever runs as a *catch-up* simulation, never as a live continuation of the mover's own turn (the fixed human/AI/human/AI layout means the seat after your own move always leads to the *other* human, never back to you) — so `session != null` alone is the correct "run this silently" signal: no thinking delay, no animation.

**Per-seat stat tallies.** `jokersPlayed`/`bumpsDelivered`/`timesBumped` are `[n0, n1, n2, n3]` arrays, not personal totals — `triggerMoveEffects` used to gate them on `ownsSeat`, which silently broke the moment an AI's bump was simulated by the *other* client (that client's `ownsSeat` check would never be true for either side). Now whichever client actually simulates a seat's move records it at that seat's index, unconditionally; `endGame` sums only `mySeats` at record time to get "my" lifetime stats. `turns` stays a single shared counter, but is now incremented directly at each site a turn ends (including the winning move) rather than inferred from a `currentPlayer` transition — the old effect miscounted the moment an adopted remote state could jump `currentPlayer` by more than one seat. `startMode` is `null` for every remote turn (host and guest both) — "did I choose to go first" isn't meaningful once the host's deal is a fixed rule and the guest never chose — so a remote game counts toward neither the `chosenFirst` nor `randomFirst` stat bucket.

**Automatic replay (§5.1–5.2).** On adopting a remote state, `handleRemoteState` seeds the local replay buffer from the wire's `replay` frames (`seedReplay`/`appendReplayFrame`, `src/net/replay.js` — wire frames always play before anything this client simulates locally) and sets `pendingAutoReplayRef`. A silent AI simulation (no delay, no animation — the same `session != null` signal as the gate) may run after that; once it becomes this client's turn — or the game ends, if the win happened *during* that silent simulation and control never actually reaches this seat — the buffered frames auto-play at the normal replay pace, then unlock. `derivePhase` ranks `replaying` above `finished` (flipped from Package 1) and the end-of-game overlay is additionally gated on `!isReplaying`, so a remote win plays out before the result appears rather than under it. Skippable via the existing Stop button. Solo is unaffected: `pendingAutoReplayRef` is only ever set by an adopted remote state, so the AI still animates live there and the manual "📺 Instant Replay" button is the only way to watch a replay. When animations are disabled, there is no auto-replay (nothing to watch) — a plain-text "Since your last turn" summary renders instead.

**Two replay buffers, not one — `replayLogRef` vs `replayOwnRef`.** `replayLogRef` is what a client should *watch*: the seed it adopted (its partner's move, forwarded through any AI hops) plus whatever it simulated locally — correct for the auto-play and the manual button. It is **not** what a client should *publish*. `commitTurn` publishes `replayOwnRef` instead: only the frames this client itself simulated since its last adopt, via `recordReplayFrame` (never touched by seeding). The reason: with exactly two humans strictly alternating publishes, the seed in `replayLogRef` is always *the recipient's own earlier move* — publishing it back re-forwards someone their own move, and the next hop does it again, so a buffer built from `replayLogRef` grows to "replay the whole game" within a few rounds. `replayOwnRef` is reset to `[]` everywhere a seed is adopted (`handleRemoteState`, `openRemoteGame`) and everywhere `replayLogRef` resets (hand-off, new game), and is appended to only alongside `recordReplayFrame`. Regression test: `src/net/replay.test.js`'s "two-buffer discipline across multiple hops".

**One thing the plan didn't cover:** what happens when a *silently-simulated AI move* ends the game. §4.2 says the AI effect's own player-advance "must stay purely local," folded into this client's next human publish — but a game-ending AI move has no next human publish to fold into, since this client's own turn never arrives. Without publishing there, the other player would never learn the game ended. So `completeAIMove` publishes directly in exactly that one case (still a no-op in solo), reusing the same `commitTurn` every human site uses.

**The security rules are the whole backend.** There is no server. `firestore/firestore.rules` is the only thing between the app's public config and the data, and it enforces one rule: you may read or write a game only if your anonymous uid is in its `participants`, with a single exception for an unclaimed `lobby` game (a joiner must read it to claim the seat, and it holds no state yet). The acceptance gate — a *different* anonymous uid can read neither an active game's metadata nor its `live/current` — is proven against the emulator in `firestore/rules.test.js` (`npm run test:rules`), which is the most important test in the package. `firestore/indexes.json` carries the one composite index the lobby query needs.

**Data model.** `games/{id}` holds small metadata only (participants, hostUid/guestUid, code, status, version, currentPlayer, `waitingOn`, winner, `winningSeat`, `description`) so the lobby can listen to it cheaply; the heavy blob lives in `games/{id}/live/current` (`state`, `replay`, `version`), which only the open game listens to. A turn writes both in one transaction, advancing `version` by exactly one — rule (b) makes the compare-and-swap a database guarantee. `codes/{CODE}` resolves a typed code to a game id (the id alone grants nothing). `state`/`replay` are stored as **JSON strings**: the game state is arrays-of-arrays (pegs/hands/discardPiles) and Firestore cannot store nested arrays — this is the one place the plan's "sync the whole `serializeGame()` blob" needed a correction. `state` never carries a `winner` field by design (the engine's win check runs on adoption, not on the wire), which is why `winningSeat`/`description` live in the metadata instead — it's the only way the client that didn't make the winning move learns who made it and what it was.

**Auth is anonymous and lazy.** `signInAnonymously()` mints a durable per-device uid with no UI. Sign-in and the SDK load happen only from a multiplayer action (create/join, opening the lobby, or a device that already has games) — see `src/net/firebase.js`. Verify the SDK stays out of the main bundle: it is a dynamic `import()` and lands in a separate chunk.

**Seat model.** A remote game swaps the solo `['me','ai','ai','ai']` for `['me','ai','them','ai']` (host, seat 0) or `['them','ai','me','ai']` (guest, seat 2). Everything else — board rotation, turn gating, actor identity — already derives from `seatOwners` (see "Seat ownership"), so the guest sees their own pegs at the bottom with no special-casing. `waitingOn` is `nextHumanSeat(currentPlayer, seatOwners)` and is written into the shared metadata; because seats 1 and 3 are `'ai'` in every layout, it is the same absolute seat from either client's point of view.

**The lobby (My Games).** A modal overlay, not a route, populated by one `subscribeMyGames` listener that feeds both the game list and the waiting-on-you badge. **"Your turn" is `waitingOn === seat`, never `currentPlayer === seat`** — a turn is published after it passes on, so every stored game is parked on an AI seat and the naive test is false for everything. Switching games reuses `applySavedGame` (switch ≈ resume a different save); it is blocked mid-split. The lobby opens on mount only when the device actually has remote games (`hasLocalGames()`), never merely because the env vars are set — that is what preserves the solo resume flow in production.

**Opening a game always replaces the board — `clearBoard` is the counterpart to `applySavedGame`.** `openRemoteGame` branches on `openActionFor(...)` (`lobby.js`), which is pure and tested precisely because getting it wrong made two games look like one: only `adopt` has a state to show, and the other three answers (`deal`, `await_guest`, `await_deal`) mean the board must be **blanked**, not left as it was. It used to be left as it was — an undealt game fell through every branch, so switching from a game in progress to one still waiting for a partner kept the first game's board on screen, under the second game's session (a move there would have published to the wrong game). So `openRemoteGame` calls `clearBoard(seat)` up front, before the fetch: no stale board during the round trip, and none at all if the game turns out to be undealt. `clearBoard` empties the hands (so `dealt` is false and the phase is `dealing`), resets pegs/split/selection/tallies, cancels every timer, and parks `currentPlayer` on a seat this client owns so the AI-simulation effect doesn't reach for a hand that isn't there. `await_guest` additionally re-shows the host's code + invite link (`inviteLinkFor`), which is the only thing on screen that explains a deliberately blank board; that modal yields to the lobby (`hostInfo && !showLobby`) since both are z-50, so its "My Games" button can reach your other games.

**Listener discipline.** Detaching a Firestore listener on game switch and on unmount is the discipline that used to be "clear the interval" — a leaked listener bills forever. Every path that changes the open game goes through `detachGameListeners` first, and the component detaches all three listeners on unmount. Your own write echoes back through your own listener; `isEcho` (hasPendingWrites, or a version you already hold) ignores it.

**Setup.** `scripts/setup-firebase.sh` provisions a Firebase project (a human runs it — the agent has no Google credentials); it prints the four `VITE_FIREBASE_*` values, which go in `.env` locally and as GitHub Actions repository **variables** (public by design, not secrets — wired into `deploy.yml`). `npm run rules:deploy` redeploys the rules; `npm run emulators` runs the emulator suite for local dev (point the app at it with `VITE_FIRESTORE_EMULATOR_HOST` / `VITE_AUTH_EMULATOR_URL`).

### PWA

`vite-plugin-pwa` (configured in `vite.config.js`, `registerType: 'autoUpdate'`) generates the service worker and web manifest at build time and precaches the built shell for offline play. Icons live in `public/` (`pwa-192x192.png`, `pwa-512x512.png`, `pwa-maskable-512x512.png`, `apple-touch-icon.png`, favicons) and were generated by `scripts/gen-icons.py` (Pillow). Manifest `start_url`/`scope` are relative (`.`) so install works from a GitHub Pages subpath.

Peg state shape: a 4-element array (one per player) of 5 peg objects, each `{ location: 'start' | 'track' | 'home', position?, homePosition?, index }`.

## Testing

Tests live next to the modules they cover (`src/game/*.test.js`, `src/net/*.test.js`) and run with Vitest. They cover deck composition, move validation for every card type (including 7/9 split rules and home-corridor edge cases), bumping, win detection, AI move selection, seat-ownership derivations (including `nextHumanSeat`), board rotation, phase/status derivation, idempotent stats recording, and — for remote play — the game-code generator, the wire-document builders, the session client against a mocked Firestore, the local game store, and the lobby derivations. `vitest.config.js` restricts `npm test` to `src/**`, so the emulator-backed rules test is not part of it. CI (`.github/workflows/ci.yml`) runs `npm test` and the build on every pull request with no Firebase env vars — that is deliberately what a solo build must pass.

**The security rules are tested separately, against the emulator.** `npm run test:rules` starts the Firestore emulator (`firebase emulators:exec`) and runs `firestore/rules.test.js`, which is the acceptance gate for the backend: a client with the app's public config, signed in as a *different* anonymous uid, can read neither an active game's metadata nor its `live/current`. It is not in the default suite because CI has no emulator. `@firebase/rules-unit-testing` and `firebase-tools` are devDependencies so `npm run test:rules`/`npm run emulators` work out of the box (or install `firebase-tools` globally and prune them).

There is no component-test setup and none is planned: logic that needs testing belongs in a plain module, not in `PegsAndJokers.jsx`. The two-device flow that can only be seen through the component (host creates → guest joins by link → both land on a correctly-oriented dealt board) was verified with two Chromium/Playwright contexts driving the emulator; that harness is not committed.

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
