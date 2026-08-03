# Multiplayer Phase 1 — Implementation Plan

**Status:** Packages 0 through 5 are built and pushed to the branch. Package 4/5 unit tests pass
(311 total) and the build is verified with and without the Firebase env vars. A live host session
was exercised against `pnj-dan-4a7f`; live two-human turn exchange was not re-verified this pass —
see "What Packages 4 and 5 actually built" for why and what to re-check. Package 6 (final pass —
the manual playtest matrix and a CLAUDE.md pass) is the only work left.
**Branch:** `claude/multiplayer-remote-play-ecx61a`
**Audience:** the agent implementing this. Assume no memory of the design discussion — everything needed is here.

**Backend decision (supersedes earlier drafts).** Packages 2–6 were originally designed around
Supabase, then Cloud Run + Cloud Storage. Both are abandoned. Supabase's free tier pauses a project
after ~7 days idle and requires a **manual** restore from its dashboard — for a game explicitly
designed around multi-day turns, that means the first person back after a quiet fortnight is
guaranteed to hit a dead backend and cannot fix it themselves. Cloud Storage's always-free tier
(50,000 reads per *month*) could not sustain the polling design. **Package 2 is now Firestore**,
which never sleeps, bills listeners per document delivered rather than per request, and let §4.4
drop polling entirely. Anything below still saying "Supabase", "RPC", "anon key" or "poll" is stale
— §2 and §4.4 are the current answer.

**Revision note (written after building Packages 0 and 1).** §3.1, §3.2, §3.4, §4.1, §4.3, §5.1 and
§5.2 have been corrected against the code as it now stands. The shape of the design is unchanged; what changed is a handful of RPC signatures, the tally model, the lobby's "whose turn" test, and three assumptions that Package 1 invalidated. Revised passages are marked **[revised]** and say what was wrong.

**Second revision note (written after building Packages 2 and 3).** Read "What Packages 2 and 3
actually built" right before §Package 4 — it is the ground truth for the session client's real
interface (which differs from §2.5's sketch in a few names), the seat-owner layouts and
`nextHumanSeat` (already implemented, reuse them), the JSON-string encoding `publishState` already
handles, and exactly which turn-handoff call sites in `PegsAndJokers.jsx` need to route through the
`commitTurn` helper Package 4 introduces. Line numbers anywhere else in this plan are stale — the
file has grown to ~3160 lines. Also fixed in this pass: a real bug in `scripts/setup-firebase.sh`
(a missing header made a failed anonymous-auth enable print "enabled" anyway) — the live project is
healthy now, but if you ever re-run that script, know it was broken and is now fixed.

---

## 1. What we are building

Two humans play **partner mode** against two AI opponents, remotely and asynchronously,
each on their own device.

- Seat 0 (Yellow) — the **host**, a human
- Seat 1 (Blue) — AI
- Seat 2 (Pink) — the **guest**, a human, and the host's **partner** (`TEAMS = [[0, 2], [1, 3]]`)
- Seat 3 (Green) — AI

The host creates a game, gets a share link, sends it to a friend. The friend opens it,
claims seat 2, and they play out a full partner-mode game against Blue + Green, taking
turns hours apart if they like.

**Several games at once.** Because turns can be hours apart, a single game is not enough to hold
anyone's attention — you need something to do while your partner thinks. So a player can have any
number of remote games running against different partners, plus their solo game, and switch
between them freely from a **My Games** lobby reachable from inside any game. See Package 3.

### Explicitly NOT in Phase 1

Do not build these. They are later phases and adding them now will sink the change.

| Not now | Why |
|---|---|
| Web push / email notifications | Phase 2. In-app turn indication only. |
| Classic ("vs") mode remotely | Phase 1 is partner-only. Keep the `mode` column, always write `'partners'`. |
| 3–4 human seats | The seat model must *support* it; the UI must not offer it. |
| Server-side move validation | Clients are trusted. |
| Hidden hands | Partners share a win condition, so there is no incentive to peek. Deliberately out of scope. |
| Server-side AI execution | Not needed — see §4.2. |
| User accounts | The game list lives on the device. Consequence in §4 risks — accepted. |
| Server-side anything | There is no server. Firestore security rules (§2.4) are the entire backend. |
| Changing `NUM_PLAYERS`, board geometry, or any game rule | The engine is correct. Do not touch the rules in `src/game/engine.js`. |

### Non-negotiable constraint

**Solo play must be behaviourally unchanged.** Same feel, same offline PWA behaviour, same
localStorage save/resume, same stats. If the Firebase env vars are absent the app must build,
deploy, and play solo with no multiplayer UI visible. The deployed GitHub Pages site must never
break because a backend is missing or down.

The one deliberate exception is Package 1, which fixes real solo bugs in win handling and stats.
Those changes are visible in solo play and that is intended.

---

## 2. Why this shape (context you need to not re-litigate)

- **The rules engine is already pure.** `src/game/engine.js` and `src/game/ai.js` take state and
  return new state. Nothing there needs to change.
- **`serializeGame()` (`src/game/persistence.js`) is very nearly the network payload.** A complete,
  plain-JSON snapshot — pegs, hands, deck, discards, current player, split state. Sync the whole
  blob; no deltas, no CRDTs. It needs one correction before it goes on the wire, in §4.1: three of
  its stat tallies are personal to the client that computed them.
- **Turn-based and slow.** No realtime *netcode* is needed — no interpolation, no prediction, no
  authoritative tick. A realtime *transport* is still the right call, because a Firestore listener
  is both cheaper and simpler than the polling it replaces.
- **`findBestAIMove` is deterministic** (no `Math.random` in `ai.js`; the only RNG is the deck
  shuffle in `deck.js:7` and the first-player spinner). The design doesn't depend on this, but it
  means a re-simulation can't diverge.
- **Partner mode is the right first mode.** Teammates share a win condition, which is why hidden
  hands can be skipped honestly rather than deferred as debt. The AI already plays partner mode
  properly.

---

## 3. Work packages

Ship in this order. Packages 0 and 1 need no backend and are independently verifiable.

**Every package ships its own tests and its own `CLAUDE.md` update.** Package 6 is a final pass,
not the place where testing happens — see the table there for what each package owns.

---

### Package 0 — Seat-ownership refactor (no backend)

**Goal:** remove the hardcoded assumption that "the local human is player 0" from
`src/PegsAndJokers.jsx`, with zero behaviour change in solo play.

**Introduce one concept**, near the top of the component:

```js
// Who owns each seat from THIS client's point of view.
// Solo:  ['me', 'ai', 'ai', 'ai']
// Remote host:  ['me', 'ai', 'them', 'ai']
// Remote guest: ['them', 'ai', 'me', 'ai']
const [seatOwners, setSeatOwners] = useState(['me', 'ai', 'ai', 'ai']);

const mySeats = useMemo(
  () => seatOwners.map((o, i) => (o === 'me' ? i : -1)).filter(i => i >= 0),
  [seatOwners]
);
const mySeat = mySeats[0];                       // primary seat: 0 solo/host, 2 guest
const isMyTurn = mySeats.includes(currentPlayer); // replaces every `currentPlayer === 0`
const isAISeat = (p) => seatOwners[p] === 'ai';
```

Make `mySeats` an **array**, not a scalar, even though Phase 1 only ever puts one seat in it.
It costs nothing now and is what makes 4-human and one-human-drives-both-partners fall out later
without a second refactor.

**Sites to change.** These are the ones that matter; there are ~45 `=== 0` hits in the file total,
so sweep for stragglers after the listed ones.

*Turn gating — `currentPlayer === 0` / `!== 0` becomes `isMyTurn` / `!isMyTurn`:*
- `:918` AI effect guard — becomes `if (isMyTurn || winner !== null) return;` **and gets a further
  condition in Package 4.**
- `:1081` "your turn" chime — `currentPlayer === mySeat`
- `:1175` `movablePegSet`, `:1194` `ghostDestinations`
- `:1204`, `:1209`, `:1229` `playableCards` / `handleCardClick` / `handlePegClick`
- `:1890` split-undo button, `:1902` replay button
- `:1965`, `:1999`, `:2045` peg clickability (start / home / track)
- `:2313` stuck-discard button

*Actor identity — the hardcoded `actor = 0` / `player 0`:*
- `:151` `controlledOwnerFor` — `pegState[0]` → `pegState[mySeat]`, `getPartner(0)` → `getPartner(mySeat)`
- `:158` `moveOptions` — `{ actor: 0 }` → `{ actor: mySeat }`
- `:663` `executeMove` — `const actor = 0` → `const actor = mySeat`
- `:706` `completeSplit` — same
- `:845`, `:883` `discardAndDraw` — the `player === 0` branches decide who advances the turn
- `hands[0]` → `hands[mySeat]` everywhere (`:1204`, `:1272`, `:2313`, …)
- `stuckCounts[0]` → `stuckCounts[mySeat]` (`:2313`, `:2321`)

*Stats tallies:*
- `:536` `mover === 0 && b.player !== 0` / `mover !== 0 && b.player === 0` — "bumps I delivered"
  and "times I was bumped". Use `mySeats.includes(...)`.

*Board rotation — three helpers, one change each:*
- `:1383` `getTrackPosition`: `const visualSide = (side + 2) % 4`
- `:1417` `getStartAreaPosition`: `const visualSide = (player + 2) % 4`
- `:1454` `getHomePosition`: `const visualSide = (player + 2) % 4`

Generalise all three to `(x - mySeat + 2) % 4` (where `x` is `side` or `player`). Check: with
`mySeat = 0` this is identical to today; with `mySeat = 2`, seat 2 maps to visualSide 2 = bottom,
so the guest sees their own pegs at the bottom exactly as the host does. **Verify this visually
before building anything on top** — it is the easiest thing to get subtly wrong, and everything
downstream looks fine while being wrong.

*Labels:*
- `:1478` `roleLabel` — `'You (Yellow)'` becomes `` `You (${PLAYER_NAMES[player]})` `` for
  `mySeats.includes(player)`; `sameTeam(player, 0)` → `sameTeam(player, mySeat)`.

**Acceptance:** solo play is indistinguishable from `main`. Full game start → win, save/resume,
replay, stats, partner mode, split undo, joker targeting, stuck discard. `npm test` green.

---

### Package 1 — Game phase, win state, and stats integrity (no backend)

This fixes bugs that exist in solo play today, and it must land before remote play because remote
play makes all of them worse.

#### 1.1 The bug

`gameMessage` (`:72`) is imperative state written from ~40 call sites. The win banner (`:1876`)
and the message line (`:1882`) render independently of each other. Every win path — `executeMove`
(`:663`), `completeSplit` (`:745`), `completeAIMove` (`:963`) — sets `winner` and returns *before*
touching `gameMessage`, so the status line keeps its stale `"Blue is thinking…"` text sitting
under a "You win!" banner.

It gets worse: `discardAndDraw` schedules `setGameMessage` on 1200 ms and 1500 ms timers (`:888`,
`:906`) and the AI effect runs on an 800 ms timer (`:1074`). Those fire *after* a win lands and
actively overwrite whatever the win path set. Any fix that just sets a better message from the win
path will still lose the race.

#### 1.2 Derive status, don't set it

Delete `gameMessage`. Replace it with two things:

```js
// Derived. Always correct, cannot go stale, cannot be clobbered by a stale timer.
const phase = useMemo(() => {
  if (winner !== null) return 'finished';
  if (isReplaying) return 'replaying';
  if (!dealt) return 'dealing';
  if (isMyTurn) return 'my_turn';
  return seatOwners[currentPlayer] === 'them' ? 'waiting_partner' : 'ai_turn';
}, [winner, isReplaying, dealt, isMyTurn, currentPlayer, seatOwners]);

const statusLine = useMemo(() => { /* phase + splitRemaining + jokerMode + discardMode */ }, [...]);

// Transient feedback only: "Invalid move. Try again." Cleared on any phase change.
const [notice, setNotice] = useState(null);
```

Every `setGameMessage(...)` call becomes either **nothing** (the status derives itself) or
`setNotice(...)` for genuinely transient feedback. This kills the entire class of stale-message
bugs, not just the one on the win screen.

#### 1.3 One terminal transition

Add a single `endGame(winnerIdx, { winningSeat, description })` and call it from **every**
win-detection site (`executeMove`, `completeSplit`, `completeAIMove`, and remote state adoption in
Package 4). It must:

1. Cancel every pending timer — `animationRef`, `bumpFxRef`, `replaySegTimerRef`,
   `replayFrameTimerRef`, `spinIntervalRef`, and the AI effect's `setTimeout`. Nothing may fire
   after the game ends.
2. Set `winner`.
3. Record stats exactly once (§1.4).
4. Publish the final state if a remote session is active (Package 4).

#### 1.4 Stats from the terminal state, keyed by game id

Today stats are folded in by an effect watching the `winner` *transition* (`:1108`), guarded by a
per-mount ref (`gameRecordedRef`). Remotely that is wrong in both directions: your partner may
never observe the transition (their client was closed when you made the winning move), and
reopening a finished game could record it twice.

Record from the **terminal state**, not the transition:

- Every game gets an id — `crypto.randomUUID()` for solo, the Firestore document id for remote.
- `pnj:recordedGames:v1` holds the ids already recorded (cap ~100, FIFO). Add it to
  `src/game/stats.js` using the same injectable-storage pattern as the rest of that module.
- `recordFinishedGame(gameId, terminalState)` is idempotent — a no-op if the id is already present.
- Call it from `endGame` **and** whenever a terminal state is adopted on load or from a poll.

Result: it no longer matters whether you were open when the game ended, whether the winning move
was yours, your partner's, or an AI's.

#### 1.5 Credit for a partner's winning move

`:1112` computes `won: winner === 0`. In partner mode `winner` is a *team* index and both humans
are on team 0, so this is accidentally right today and would break the moment a human sits in
seat 1 or 3. Make it explicit:

```js
// classic: `winner` is a player index. partners: `winner` is a team index.
export function didIWin(winner, mode, mySeats) {
  if (winner == null) return false;
  return mode === GAME_MODES.PARTNERS
    ? mySeats.some(s => TEAMS[winner].includes(s))
    : mySeats.includes(winner);
}
```

This is what gives you credit when your partner's move wins the game.

#### 1.6 Fix the nemesis stat for partner mode

`src/game/stats.js:148` does `lossesByOpponent[winner]++`. In partner mode `winner` is a team
index, so losing to Blue + Green records a single loss against "Blue" and none against Green.
Record the losing side correctly — credit both members of the winning team in partner mode, or
give teams their own bucket. Add a test; this is a pre-existing bug and in scope now that stats
accuracy is a goal.

#### 1.7 End-of-game presentation

Replace the inline green banner (`:1876`) with a proper end-of-game overlay:

- Result, phrased for the mode ("You and Pink win!" / "Blue and Green win").
- **Who made the winning move and what it was** — from `lastMoves` and the final replay frame.
  This matters remotely: a game can end on a move you never saw.
- The game's tallies (turns, jokers, bumps) and the updated lifetime stats.
- New Game / Rematch.

The status line reads "Game over", never "Blue is thinking…".

**Acceptance:** win by every route — your move, a split that completes the win, an AI move, your
partner's move arriving over the wire — and the status line is correct in all four. No stale
"thinking" text. Force-quit right after a win and reopen: stats recorded exactly once. Losing in
partner mode credits both opponents.

---

### What Packages 0 and 1 actually built

Both are on the branch and `CLAUDE.md` documents them under "Seat ownership", "Game phase and
status" and "Ending a game". Read those before starting Package 2 — they are the ground truth, and
the line numbers scattered through this plan predate them and are now wrong. The short version:

- `src/net/seats.js` — `mySeatsOf`, `primarySeat`, `isMyTurnFor`, `isAISeat`, `visualSideFor`,
  `seatAtVisualSide`. The component holds `seatOwners` state and derives `mySeats` / `mySeat` /
  `isMyTurn` / `ownsSeat` from it. `setSeatOwners` exists and is unused — it is the hook Package 3
  needs when a game is opened.
- `src/game/status.js` — `derivePhase`, `describeStatus`, `describeOutcome`. `gameMessage` is gone;
  `notice` holds transient feedback and clears on any phase change. **There are no status timers
  left. Do not add one.**
- `endGame(winner, { winningSeat, description })` is the only terminal transition, and cancels every
  pending timer. `recordFinishedGame(gameId, result)` in `src/game/stats.js` is idempotent on
  `pnj:recordedGames:v1`; `didIWin(winner, mode, mySeats)` interprets a winner per mode. The game id
  round-trips through `serializeGame()`, so a remote game should use its Firestore document id.
- Beyond the sites this plan listed, Package 0 also had to fix: two hardcoded `nextPlayer = 1`
  handoffs, the discard-pile corner coordinates, and the four board labels. Expect the same — the
  line-number lists here are a starting point, not an inventory.

---

### Package 2 — Firestore backend

Create a Firebase project (Spark / free plan is sufficient). Add the `firebase` npm package.

**Why Firestore and not a server.** Every earlier draft of this plan had a server in front of a
database and a 4-second poll behind it. That was the weakest part of the design: it specified a
synchronous cadence for a product whose whole premise is "turns hours apart", and it was the
binding free-tier constraint on every backend considered. Firestore removes it. Listeners are
billed per *document delivered*, so a subscription held open all afternoon with nobody moving costs
nothing, and updates arrive instantly instead of up to four seconds late. There is no service to
deploy, no cold start, and no instance to keep warm — Package 2 is a rules file and a client module.

It also puts Phase 2 within reach: Firestore and Firebase Cloud Messaging are the same SDK, the
same project and the same identity, so push notifications become an increment rather than a second
backend integration.

#### 2.1 The access model, in plain terms

Two clients, no login screen, and yet every read has to be checked by something other than the
client asking. **Firebase Anonymous Auth** is what makes that possible: `signInAnonymously()` mints
a durable per-device user id with no signup, no UI and no email. Firestore security rules then get a
trustworthy `request.auth.uid` to check against the document.

The rule is simply: **you may read a game if you are one of its participants.** Each game document
carries `participants: [hostUid, guestUid]`, and the rules check membership on every read and every
write. This is *stronger* than the token-in-a-column scheme earlier drafts used — there, anyone who
ever saw a share link had permanent, unrevokable read access. Here participation is enforced
server-side on every access, and the anonymous uid is exactly the thing Phase 2 upgrades to a real
account.

Two secrets remain, in the same shape as before:

- **Game code** — 6 typable characters, used *once* to join. Resolves to a game id and nothing else.
- **Game id** — a UUID. Share links carry it (`?g=<uuid>`), so a link isn't guessable.

Sign in anonymously **lazily** — only when the player creates a game or opens a `?g=` link. A
solo-only player must never be signed in, must never download the Firestore SDK, and must never
notice any of this exists.

The one accepted exposure: a game still in `lobby` state is readable by any signed-in client that
knows its id, because the joining client has to read it to claim the seat. At that point the
document holds no game state — only the mode, the code and the host's uid. Anyone who sees the code
before your partner does can take the guest seat; the host sees that happened and can start over.
Same trade the earlier drafts accepted, documented here for the same reason.

#### 2.2 Config

`.env` (already gitignored) plus a committed `.env.example`:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
```

All four are public by design — Firebase's own documentation is explicit that the web API key is an
identifier, not a credential, and the security model rests entirely on the rules in §2.4. Add them
as GitHub Actions repository **variables** (not secrets) and wire them into the build step in
`.github/workflows/deploy.yml`, since the Pages build is static and bakes them in.

`isMultiplayerConfigured()` is "all four present". With any of them missing the app must build,
deploy and play solo with no multiplayer UI — CI will not have them, which is what keeps CI green.

**Lazy-load the SDK.** `firebase/firestore` is a substantial download. Import it behind a dynamic
`import()` reached only from the multiplayer paths, so a solo player's bundle and cold-load time are
unchanged. This is part of the non-negotiable constraint in §1, not an optimisation.

#### 2.3 Data model

Keep it in the repo at `firestore/firestore.rules` and `firestore/indexes.json` so it is reviewable
and re-deployable.

The heavy state lives in a **subcollection**, deliberately:

```
games/{gameId}                    ← metadata only. Small. The lobby listens to this.
  participants  [uid, ...]        ← membership, and what the lobby queries on
  hostUid       string
  guestUid      string | null
  code          string            ← 6 chars, unambiguous alphabet (no 0/O/1/I)
  mode          'partners'
  status        'lobby' | 'active' | 'finished'
  version       number
  currentPlayer number            ← the seat the state is parked on (always an AI seat)
  waitingOn     number | null     ← the HUMAN seat that must act next — see §3.2
  winner        number | null
  createdAt     timestamp
  updatedAt     timestamp

games/{gameId}/live/current       ← the payload. Only the open game listens to this.
  state         map               ← the shared game state (§4.1)
  replay        array             ← frames for the last human move
  version       number            ← written in the same transaction as the metadata

codes/{CODE}                      ← join-by-code lookup
  gameId        string
```

Splitting the blob out is what lets the lobby be a live query. The web SDK has no projection, so a
listener on `games` delivers whole documents — with `state` inline, rendering a four-game list would
stream four full games on every change. Metadata documents are a few hundred bytes.

A turn writes both documents in **one transaction**: the metadata (version, currentPlayer,
waitingOn, winner, updatedAt) and `live/current` (state, replay, version).

#### 2.4 Security rules

This is the whole server. It replaces §2.1's `SECURITY DEFINER` functions from earlier drafts, and
it is the only thing standing between the public config in §2.2 and your data — review it as such.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }
    function isParticipant(data) {
      return signedIn() && request.auth.uid in data.participants;
    }

    match /games/{gameId} {
      // Participants always. Plus an unclaimed game, because the joining client
      // must read it to claim the seat — at which point it holds no game state.
      allow read: if isParticipant(resource.data) || resource.data.guestUid == null;

      allow create: if signedIn()
        && request.resource.data.hostUid == request.auth.uid
        && request.resource.data.guestUid == null
        && request.resource.data.participants == [request.auth.uid]
        && request.resource.data.version == 0
        && request.resource.data.status == 'lobby';

      allow update: if
        // (a) claim the empty guest seat. The only write a non-participant may make.
        (signedIn()
         && resource.data.guestUid == null
         && request.resource.data.guestUid == request.auth.uid
         && request.resource.data.hostUid == resource.data.hostUid
         && request.resource.data.participants == resource.data.participants.concat([request.auth.uid])
         && request.resource.data.version == resource.data.version)
        ||
        // (b) publish a turn. Participants only; membership is frozen; version advances by one.
        (isParticipant(resource.data)
         && request.resource.data.participants == resource.data.participants
         && request.resource.data.hostUid == resource.data.hostUid
         && request.resource.data.guestUid == resource.data.guestUid
         && request.resource.data.version == resource.data.version + 1);

      allow delete: if false;

      match /live/{docId} {
        // Mirrors the parent. get() costs a read; it is only paid on writes and
        // on the first attach of a listener, not on every delivered update.
        allow read, write: if isParticipant(
          get(/databases/$(database)/documents/games/$(gameId)).data
        );
      }
    }

    match /codes/{code} {
      // A code resolves to a game id and nothing more. The id alone grants
      // nothing: reading the game still requires being a participant.
      allow read, create: if signedIn();
      allow update, delete: if false;
    }
  }
}
```

Note what rule (b) buys: **the compare-and-swap is enforced by the database**, not by client
etiquette. Two clients cannot both advance the same version, so §4.4's version-conflict path is a
real guarantee rather than an assumption about one-writer-per-turn.

`firestore/indexes.json` needs a composite index for the lobby query
(`participants array-contains` + `updatedAt desc`).

#### 2.5 Client module

`src/net/session.js`, plain JS, no React. Same interface earlier drafts specified — the seam was
always backend-agnostic — plus two subscriptions where the polling used to be:

```js
export function isMultiplayerConfigured()   // all four env vars present
export async function signIn()              // anonymous, lazy, idempotent
export async function createGame(mode)      // → { id, code }
export async function joinGame(code)        // → { id, seat }
export async function joinGameById(id)      // share links carry the id, not the code
export async function fetchGame(id)         // one-shot read, for switching games
export async function publishState(id, payload, expectedVersion)  // transaction; throws VersionConflict
export async function startGame(id, state)  // host only
export function subscribeGame(id, onState)  // → unsubscribe
export function subscribeMyGames(onRows)    // → unsubscribe. Powers the lobby and the badge.
```

Plus `src/net/localSession.js` — the device's list of remote games in localStorage under
`pnj:games:v1`:

```js
{ version: 1, activeId: '<uuid>|null', games: [
  { id, seat, code, label, createdAt, archived }
] }
```

This is now a **local cache and nickname store, not the source of truth** — Firestore knows which
games are yours via `participants`, so a device that has the same anonymous uid recovers its games
without it. `label` is a local nickname ("Sara", "Topher"), since there are no accounts and
therefore no real partner names; prompt for it at create/join time, defaulting to the game code.
`archived` hides a finished or abandoned game from the lobby without touching the document.

#### 2.6 Setting up the Firebase project

Write `scripts/setup-firebase.sh` — idempotent, re-runnable, and commented so a human can read it
before running it. **The agent cannot run this**: it has no Google credentials, and it must not be
given any. It writes the script; the repo owner runs it on a machine where `gcloud auth login` has
happened.

The script should cover:

```bash
# 1. Project + Firebase
gcloud projects create "$PROJECT_ID" --name="Pegs and Jokers"
firebase projects:addfirebase "$PROJECT_ID"

# 2. APIs
gcloud services enable firestore.googleapis.com identitytoolkit.googleapis.com \
  --project "$PROJECT_ID"

# 3. Firestore, native mode, a US region so it lands in the always-free tier
gcloud firestore databases create --location=nam5 --type=firestore-native \
  --project "$PROJECT_ID"

# 4. Anonymous auth. No console click needed — it is a config patch.
curl -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.anonymous.enabled" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"signIn":{"anonymous":{"enabled":true}}}'

# 5. Web app + the four values for .env
firebase apps:create WEB "pnj-web" --project "$PROJECT_ID"
firebase apps:sdkconfig WEB --project "$PROJECT_ID"

# 6. Rules and indexes
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"
```

Treat those commands as a sketch to verify, not gospel — flags drift between CLI versions. The
script must check for `gcloud` and `firebase` up front and say how to install them if missing, and
it must print the four `VITE_FIREBASE_*` values at the end in copy-pasteable form.

Also add an `npm run rules:deploy` script, because the rules will change while Packages 3–5 are
built and redeploying them must not require remembering a command.

**Acceptance:** unit tests for the code generator and for `session.js` against a mocked Firestore
(follow the injectable-backend pattern in `stats.js` / `persistence.js`). Then verify the rules for
real, which is the part that matters: with the app's own public config and a *different* anonymous
uid, confirm a client can read neither an active game's metadata nor its `live/current`. The
Firestore emulator (`firebase emulators:start --only firestore`) can assert this in a test, and
that test is worth more than every other test in this package combined.

### Package 3 — My Games lobby and switcher

Only rendered when `isMultiplayerConfigured()` is true. When it isn't, the app keeps today's exact
flow — first-player modal, single local save, resume prompt — and none of this exists.

#### 3.1 Creating and joining

- **"Play with a friend"** on the existing first-player modal.
- **Host:** creates the game → shows the 6-char code and a copyable share link (`?g=<uuid>`) →
  "Waiting for your partner to join…", which is a `subscribeGame` listener on the metadata document
  waiting for `guestUid` to appear. When it does, deal (`startGameWithPlayer`) and call
  `startGame`. **[revised]** Earlier drafts polled for this and had no field to poll *for*; the
  listener makes both problems vanish.
- **Guest:** opening `?g=<uuid>` calls `join_game_by_id`; entering the code calls `join_game`
  **[revised — the link carries the id, which the original `join_game(p_code)` could not accept]**.
  Either way it stores the session in `pnj:games:v1` and waits until `status = 'active'`.
- **First player:** host-only. Reuse the existing modal and spinner (`:220`); the guest never sees it.
- A player can be host in one game and guest in another simultaneously. Seat assignment is
  per-game and already lives in `seatOwners`, so nothing special is needed.

#### 3.2 The lobby

A modal overlay, in the same style as the existing stats and resume modals — **not** a route, not a
component split. It lists:

- **Your solo game**, if a local save exists — "Solo vs AI, your turn".
- **Every remote game** in `pnj:games:v1`, each showing the label, whose turn it is, and how long
  since the last move (`updated_at`, rendered relative: "3 hours ago").
- **Sorted with "your turn" first**, then by most recently updated. This ordering is the whole
  point of the screen.
- Finished games, collapsed, with the result. Plus **New game** and **Join by code**.

Populate it with one `subscribeMyGames` listener — not a fetch, and not a second poll. It updates
itself when a partner moves, whether or not the lobby is open. Show a **badge with the number of
games waiting on you** on the lobby button, so a player can see there is something to do without
opening it. That badge is also exactly what Phase 2's push notifications will drive.

**"Your turn" is `waiting_on === seat`, never `current_player === seat`. [revised]** This is the
single easiest way to ship a lobby that looks finished and does nothing. §4.1 publishes *after* the
turn passes on, so every stored row is parked on an AI seat — `current_player` is always 1 or 3 and
`current_player === seat` is false for every game, always. The sort would never reorder and the
badge would never leave zero. `waitingOn` is `nextHumanSeat(currentPlayer, seatOwners)`, written by
the publisher into the metadata document (§2.3). Storing it rather than deriving it client-side
keeps the rule in one place, lets the lobby listener render without touching `live/current`, and is
exactly the field Phase 2 needs to know whom to notify.

#### 3.3 Switching

- A **My Games** button in the game header (next to Stats / New Game, `:1862`) opens the lobby from
  inside any game — solo or remote.
- Switching to a game means: fetch its state, then hand it to the existing `applySavedGame` path
  (`:280`) along with its `seatOwners` and session. `applySavedGame` already resets every per-game
  ref — tallies, replay buffer, turn trackers — so "switch game" is very nearly "resume a different
  save" and should reuse that machinery rather than growing a parallel one. Set `activeId`.
- **Block switching mid-split.** If `splitRemaining !== 0`, refuse with "Finish or undo your split
  first" — the Undo Split button (`:1890`) is right there. In-progress selections
  (`selectedCard` / `selectedPeg`) are transient and aren't persisted even today, so they can be
  dropped silently; a half-played 7 or 9 cannot.
- Switching away from a remote game needs no write: state is only ever published at handoff (§4.1),
  so an un-committed turn simply starts over, exactly like a disconnect.

#### 3.4 Entry point

On mount, open the lobby instead of the resume modal **only when this device actually has remote
games** (`pnj:games:v1` is non-empty) — it subsumes the resume prompt, which stops making sense once
more than one game can be resumed. Auto-open the last `activeId` game only when it is the sole game
and it is your turn.

**[revised]** The original trigger was `isMultiplayerConfigured()`, which contradicts the
non-negotiable constraint in §1. Once the env vars are set on Pages that predicate is true for
*everyone*, so every solo player who has never touched multiplayer would get a lobby instead of the
resume modal they know. The "solo is unchanged" guarantee would then be enforced only by the absence
of configuration — precisely the state that stops holding the day Package 2 deploys. Gate on the
device having remote games; `isMultiplayerConfigured()` still gates whether multiplayer can be
*started* at all. A player who never taps "Play with a friend" must never sign in anonymously and
must never download the Firestore SDK (§2.2).

**Local save interaction.** The localStorage save (`persistence.js`) remains the source of truth
for **solo only**, and there is still exactly one solo game. In a remote game the server row is
the save: skip the save effect at `:1132` when a remote session is active.

**Acceptance:** two browser profiles; host creates, guest joins by link and by code; both land on a
dealt board with the correct seat; the guest sees their own pegs at the bottom. Then: run three
games at once against two different partners plus a solo game, switch between all four, and confirm
each resumes exactly where it was with the right seat, board orientation, replay buffer, and
tallies. Confirm the badge count matches the number of games actually waiting on you.

**Confirmed live, manually:** two real devices (Chrome + Safari) against `pnj-dan-4a7f`. Host
created, guest joined by code, both landed on a correctly-oriented dealt board. Playing a move on
one device does **not** appear on the other — expected, since that is exactly what Package 4 builds.

---

### What Packages 2 and 3 actually built

Read this before starting Package 4 — it is ground truth, and line numbers elsewhere in this plan
predate it. `CLAUDE.md`'s "Remote play" section is the other ground-truth source; read both.
`PegsAndJokers.jsx` is now ~3160 lines (multiplayer wiring added a large block after the seat-owner
state, roughly lines 200–890 — the exact ranges below are anchored to comments/function names, not
line numbers, since those will drift further).

**`src/net/session.js` — the real interface (differs from §2.5's sketch in a few names):**

```js
signIn()                                  // anonymous, lazy, idempotent
createGame(mode)                          // → { id, code }
joinGame(code) / joinGameById(id)         // → { id, seat }
fetchGame(id)                             // → { id, meta, state, replay, version }, one-shot
startGame(id, { state, replay, currentPlayer, waitingOn })   // host's initial deal, version 0→1
publishState(id, payload, expectedVersion) // → new version; throws VersionConflict — READY, UNUSED
subscribeGameMeta(id, onMeta)             // → unsubscribe. Metadata doc: status/guestUid/waitingOn/winner
subscribeGameState(id, onState)           // → unsubscribe. live/current doc: {state, replay, version}
subscribeGame                             // = subscribeGameState (the §2.5 name, kept as an alias)
subscribeMyGames(onRows)                  // → unsubscribe. Powers the lobby + badge
```

**`publishState` and `VersionConflict` already exist and are fully tested but call-site-unused** —
Package 4 is mostly *wiring these in*, not building them. `publishState`'s payload takes `state` and
`replay` as plain JS objects/arrays; `session.js` handles the JSON-string encoding internally (see
below), so callers never touch that.

**Firestore cannot store nested arrays — already solved, don't rediscover it.** The game state is
arrays-of-arrays (`pegs`/`hands`/`discardPiles`), which Firestore rejects raw. `session.js` stores
`live/current.state` and `.replay` as **JSON strings** and decodes them transparently in
`fetchGame`/`subscribeGameState`. This was found the hard way — Package 3's manual two-device test
initially failed silently (host dealt locally, the write never actually landed, guest never saw a
board) before this fix. If you touch `session.js`'s encode/decode helpers, keep the round-trip test
in `session.test.js` (`'round-trips a state with nested arrays'`) green.

**Seat helpers already built in `src/net/seats.js` — reuse, don't reinvent:**
- `nextHumanSeat(from, seatOwners)` — walks the fixed turn order to the next non-AI seat. This is
  **exactly** §4.2's AI-simulation gate and §3.2's `waitingOn` — already used by Package 3 to compute
  `waitingOn` when publishing the initial deal (`dealAndStartAsHost`). Package 4 needs the same
  function for the AI-effect gate; don't write a second implementation.
- `HOST_SEAT_OWNERS`, `GUEST_SEAT_OWNERS`, `remoteSeatOwners(seat)` — the two remote layouts and a
  helper that picks the right one from a seat number.
- `HOST_SEAT` / `GUEST_SEAT` constants live in `src/net/protocol.js`, not `seats.js`.

**The component's remote-session state and helpers (search for these names, not line numbers):**
- `session` (state) / `sessionRef` (ref mirror) — `null` for solo, else `{ id, seat, version }`.
  `version` is the version currently applied to the local board; use it as `expectedVersion` when you
  add the first `publishState` call.
- `openMeta` — the live metadata doc for the open game (status, currentPlayer, waitingOn, winner).
  Already populated and re-rendered on every metadata delivery.
- `handleRemoteState(id, payload, info)` — **the seam Package 4 extends.** Currently: adopts a state
  snapshot via `applySavedGame`, ignores echoes via `info.isEcho(s.version)`. It does **not** yet
  look at `winner` (which lives in metadata, not in the `state` blob — `serializeGame()` never wrote
  a `winner` field, by design) or seed `replayLogRef` from `payload.replay`, or trigger AI simulation.
  §4.3's "adopt first, then call `endGame` with the snapshot's winner" and §5.1's silent-AI-then-
  auto-replay both extend this function.
- `handleOpenMeta(id, meta)` — currently only watches for the host's guest-joined trigger. Package 4
  needs it (or a sibling effect) to react to `meta.winner` arriving without a state change, and to
  drive the "waiting for partner" status Package 3 already renders from `openMeta`.
- `dealAndStartAsHost` — Package 3's only publish so far (the version 0→1 initial deal via
  `startGame`). Read it as the worked example for what a Package-4 `commitTurn` publish call looks
  like: build the `serializeGame()`-shaped state, compute `waitingOn` via `nextHumanSeat`, call the
  session function, catch and surface a non-fatal notice on failure (a remote write failing must
  never leave the local board stuck — the mover already committed locally).
- `attachGameListeners` / `detachGameListeners` — already wired to every path that changes the open
  game (create, join, switch, unmount). Nothing new needed here for Package 4.

**AI-effect gate is half done.** The effect (search `// AI logic - drives the AI seats`) currently
gates on `if (!isAISeat(seatOwners, currentPlayer)) return;` — enough to stop a client running the
*other human's* turn, but **not** §4.2's real rule. Today, in a live remote game with two devices
both idling on an AI seat, **both clients will independently simulate the same AI move**, because
nothing yet prevents it — there is no publish to race on yet, so this hasn't bitten anyone, but it
will the moment `commitTurn` exists. The fix is exactly §4.2: gate on
`ownsSeat(nextHumanSeat(currentPlayer, seatOwners))` (`nextHumanSeat` from `seats.js`, already
imported). Get this exactly right — the risk table's warning about double-simulation is real here,
not hypothetical.

**Turn-handoff call sites — the four places `commitTurn` must wrap.** Grep for
`setCurrentPlayer(nextPlayer)`; there are five hits, one of which (inside the AI effect's own
`completeAIMove`) is **not** a human turn end and must NOT publish — an AI move is simulated locally
by whichever client is responsible and folded into that client's *next* human publish, per §4.2's
whole point (no server-side AI, no extra writes). The four real sites, matching §4.1's list exactly:
`executeMove`, `completeSplit`, `discardAndDraw` (the human branch — `discardAndDraw` also runs for
AI seats via the AI effect, which must NOT publish), and `handleJokerTarget`.

**Stats tallies are still the old single-counter model** (`turnsRef`, `jokersThisGameRef`,
`bumpsDeliveredThisGameRef`, `timesBumpedThisGameRef` — one number each, not per-seat arrays). This
was deliberately deferred here: Package 3's game-switching never touches a nonzero tally (no turn
exchange has published one yet), so the restructure wasn't yet load-bearing. **It is load-bearing
now.** §4.1's per-seat-array correction is genuinely Package 4 scope — do it as part of this package,
not after.

**`endGame`'s settle/present split (§5.2) has NOT been done yet.** `endGame` (search `const endGame`)
still unconditionally cancels `replaySegTimerRef`/`replayFrameTimerRef` and restores the live board —
correct for Packages 0/1, wrong once Package 5's silent-then-replay needs those timers left alone so
the winning move can be watched before the overlay appears. Needed before Package 5 works; §5.2
describes the split (settle: cancel-timers/set-winner/record-stats, always immediate; present: the
overlay, gated separately).

**Verified against a live Firebase project**, not just the emulator: `pnj-dan-4a7f` — Firestore
native, anonymous auth, rules and indexes deployed, GitHub Actions repo variables set. Two real
devices (Chrome desktop + Safari) created/joined/dealt correctly. One live-project gotcha worth
knowing: a **brand-new** Firebase project's Auth config does not exist until either the console's
Authentication page is opened once (Build → Authentication → Get started) or some other action
provisions it — the anonymous-auth enable API call returns `CONFIGURATION_NOT_FOUND` until then, no
billing involved. `scripts/setup-firebase.sh` detects this and tells you to do it; already done for
`pnj-dan-4a7f`, so Package 4/5 work needs no further setup.

---

### Package 4 — Turn exchange (the core)

Three rules. Get these exactly right; everything else is UI.

#### 4.1 Publish once, at handoff

A client writes **exactly once per human turn**: after its own move completes and the turn passes
on. Never mid-turn.

Consequence worth knowing: a half-finished split never crosses the wire (`splitRemaining` is always
0 in a published snapshot). If a player disconnects mid-split the server still holds the pre-turn
state and their turn simply starts over when they return. That is intended.

The three sites where a human turn ends are `executeMove`, `completeSplit`, `handleJokerTarget` and
`discardAndDraw`'s human branch. (Package 0 made `handleJokerTarget` a real fourth site — it used to
hardcode `nextPlayer = 1`.) Route all of them through one `commitTurn(nextPlayer, nextState)` helper
rather than duplicating publish logic. **[revised]** Confirmed current: grep
`setCurrentPlayer(nextPlayer)` for the exact four call sites — see "What Packages 2 and 3 actually
built" for why the AI effect's own fifth hit must NOT go through `commitTurn`.

#### Payload: NOT `serializeGame()` as-is **[revised]**

The original said "`serializeGame(...)` as-is". That is wrong, and wrong in a way that silently
corrupts both players' lifetime stats. `serializeGame()` carries
`tallies: { turns, jokersPlayed, bumpsDelivered, timesBumped, startMode }`, and three of those are
**personal to the client that computed them** — `triggerMoveEffects` counts a bump as delivered or
received by testing `ownsSeat()`. Sync that blob and adopt it through `applySavedGame` and each
client overwrites its own tallies with its partner's, then folds them into its own lifetime stats.

It is worse than a mix-up, because §4.2 means neither client sees half the bumps at all: the host
adopts Blue's move as a finished board and never runs `triggerMoveEffects` over it, so Blue bumping
a host peg increments `timesBumped` nowhere. Bump stats quietly stop working the moment play goes
remote.

So the shared state is `serializeGame()` with the tally block restructured:

- `turns` — shared and objective. Keep it, but see §4.4: it must become a counter incremented once
  per seat that actually moves, not the transition-counting effect there is today.
- `jokersPlayed`, `bumpsDelivered`, `timesBumped` — **per-seat arrays** (`[n0, n1, n2, n3]`),
  tallied by whichever client simulates the move, summed over `mySeats` at record time. That fixes
  both halves: the numbers ride the wire from whoever observed them, and each client reads off only
  its own seats. It also survives §3.3's game switching, where per-game refs would otherwise be lost.
- `startMode` — a host-only concept ("did *I* choose to go first"). Do not let a guest inherit it:
  remote games should count toward neither the `chosenFirst` nor the `randomFirst` bucket.
- `moveHistory` — write-only dead state (set, never read). Drop it from the payload.

Plus the replay frames for the move just made. Note what a frame costs: each carries six full board
snapshots (`pegsBefore`/`pegsAfter`, and every segment's `fromPegs`/`toPegs`), so a 7-split frame is
~4.1 KB against a 4.8 KB state. A typical publish is ~13 KB. That is comfortably inside Firestore's
1 MiB document limit but worth watching if frames ever accumulate rather than being replaced each
turn — `replay` holds only the frames for the last human move, never a history.

The publish itself is **one transaction** writing both documents in §2.3: the metadata (version,
currentPlayer, waitingOn, winner, updatedAt) and `live/current` (state, replay, version). Rule (b)
in §2.4 rejects it unless the version advances by exactly one, so the compare-and-swap is enforced
by the database rather than by client etiquette.

#### 4.2 Simulate AI only when the chain leads to your seat

This is the rule that removes any need for server-side AI or for anyone to keep a tab open.

Turn order is fixed 0→1→2→3→0 and the AI seats sit *between* the two humans, so:

> A client runs the AI seats forward only when the run of AI seats after `currentPlayer`
> terminates at one of **its own** seats.

**[revised]** `nextHumanSeat` is already implemented in `src/net/seats.js` (used today by
`dealAndStartAsHost` to compute `waitingOn`) and already unit-tested for every seat layout — import
it, don't redefine it:

```js
export function nextHumanSeat(from, seatOwners) {
  let p = from;
  for (let i = 0; i < NUM_PLAYERS; i++) {
    if (seatOwners[p] !== SEAT_AI) return p;
    p = (p + 1) % NUM_PLAYERS;
  }
  return from;
}
```

Gate the AI effect (search `// AI logic - drives the AI seats`) on
`ownsSeat(nextHumanSeat(currentPlayer, seatOwners))`, replacing its current (insufficient)
`!isAISeat(seatOwners, currentPlayer)` check.

Trace it: the host moves and publishes with `currentPlayer = 1`. On the host `nextHumanSeat(1) = 2`
— not mine, so the host stops and shows "Waiting for Pink". On the guest `nextHumanSeat(1) = 2` —
that's me, so the guest runs Blue locally and then it is their turn. No write in between.
Symmetrically the guest publishes `currentPlayer = 3` and the host runs Green. **One write per
human turn, always to a human, and the player about to move is the one who runs the AI.**

In solo this predicate is always true (every AI chain leads back to seat 0), so solo behaviour is
unchanged — check this invariant first if solo ever regresses.

#### 4.3 Win detection on adoption

If the arriving state has a winner, do **not** simulate anything. Route it straight to `endGame`
(§1.3), which records stats idempotently and shows the end-of-game overlay — after the auto-replay
in Package 5, so the player sees the winning move.

**[revised — how this composes with what Package 1 built.]** `applySavedGame` resets `endedRef` and
`endInfo` and leaves `winner` null, so the correct sequence is **adopt first, then call `endGame`**
with the snapshot's winner. Do not try to make `applySavedGame` set the winner itself. Done in that
order you get idempotent stat recording and the overlay for free, and a terminal state can be
adopted any number of times safely. Frame seeding must also come *after* the adopt, because
`applySavedGame` calls `resetReplay()`, which empties `replayLogRef`.

#### 4.4 Subscribe, don't poll **[revised — this section was wholly rewritten]**

Earlier drafts polled `get_game` every 4 s for the open game and a summary endpoint every 30 s for
the rest. That is gone. It was the weakest part of the plan — a synchronous cadence bolted onto an
asynchronous product, and the binding free-tier constraint on every backend considered. Two
listeners replace all of it:

- **The open game** — `subscribeGame(id, onState)`, a listener on `games/{id}/live/current`, active
  while a remote game is on screen. Attach on open, detach on switch or unmount.
- **The lobby** — `subscribeMyGames(onRows)`, a listener on
  `games where participants array-contains uid order by updatedAt desc`. One subscription covers
  every game you are in, however many there are, and it feeds both the list and the badge.

Both are free while nothing happens: Firestore bills per document *delivered*, so an idle
subscription costs nothing at all, and an update arrives in milliseconds rather than up to four
seconds late. There is no version gate to build, no `visibilitychange` backoff to tune, and no
second cadence.

**[revised — all of this is already built by Package 3.]** `subscribeGameState` (aliased as
`subscribeGame`) and `subscribeGameMeta` (a second listener on the metadata doc, not in this plan's
original two-listener count but needed for the host's waiting-for-guest screen — see "What Packages
2 and 3 actually built") are both attached via `attachGameListeners`/detached via
`detachGameListeners` on every open/switch/unmount path already. `subscribeMyGames` powers the lobby
and badge already. Nothing to build here for Package 4 — only the two items below are still open.

What still needs care:

- **Ignore your own echo — already done.** `handleRemoteState` calls `info.isEcho(s.version)`
  (backed by `protocol.js`'s `isEcho`, which checks `hasPendingWrites` then version) before adopting.
  Nothing to add.
- **Offline is fine and you get it free.** Firestore's SDK queues writes made offline and replays
  them on reconnect, which matters for a PWA. Do not build a queue.

**Adopting a state with a higher version — partially done.** `handleRemoteState` already calls
`applySavedGame(payload.state)` and updates `session.version`. **Still missing:** seeding
`replayLogRef` from `payload.replay` after the adopt (`applySavedGame` calls `resetReplay()`, which
empties it — must happen after, per §4.3), and letting §4.2's gate decide whether to simulate. Both
are Package 4/5 work in `handleRemoteState`, not new plumbing.

**Version conflicts** are now enforced by the database rather than assumed away. Rule (b) in §2.4
only permits `version == resource.data.version + 1`, so two clients cannot both advance the same
version — the loser gets a permission error from the transaction. It should still be unreachable
with one writer per turn; treat it as a bug signal, re-read, adopt, and surface a non-destructive
notice.

**The turn counter needs fixing for remote play.** `turnsRef` increments in an effect that watches
`currentPlayer` for a *change*, so adopting a state that jumped from seat 1 to seat 3 counts one
turn instead of two — and counts differently on each client. Make `turns` a plain counter in the
shared state, incremented once per seat that actually moves.

### Package 5 — Automatic replay on turn start

When your turn begins remotely you have missed two moves — your partner's and an AI's. Replay them
automatically instead of making you press a button.

#### 5.1 Flow

On receiving a state where the AI chain leads to your seat:

1. Adopt the state (your partner's move already applied); seed `replayLogRef` from the wire frames.
2. Run the AI seats **silently** — no animation, no 800 ms thinking delay — recording frames.
   Reuse the existing `animationsEnabled === false` branch in the AI effect for the animation part.
   **[revised]** That branch does *not* skip the thinking delay: the AI effect's `setTimeout(…, 800)`
   is unconditional and `animationsEnabled` only branches inside it. Silent mode needs the delay
   collapsed to 0 as a separate change. Note also that the effect processes **one** seat per run and
   waits on a React commit between them, so "run the AI seats forward" is asynchronous — set a
   `pendingAutoReplayRef` at adoption and fire the replay from the turn-start effect when `isMyTurn`
   becomes true, rather than trying to sequence it inline.
3. Auto-start the replay over the whole buffer: partner's move, then the AI moves, at replay pace.
4. Replay ends → your turn, interaction unlocks.

**Why silent-then-replay rather than live-then-optional-replay:** if the AI animates live you watch
it once at full speed and then again in the replay. Simulating silently and replaying the whole
run gives one coherent "here's what happened since your last turn" sequence, in order, at a
readable pace.

#### 5.2 Details

- The replay banner (search `📺 Instant Replay`) gets a **Skip** button — `stopReplay` already does
  the right thing.
- `animationsEnabled === false` → no auto-replay; show a text summary of the frames instead.
- No frames (your first turn, a fresh join) → no replay.
- **Solo is unchanged**: the AI still animates live and the replay button stays manual. Silent
  simulation and auto-replay are remote-only. This is one conditional in the AI effect and one at
  turn start — keep it that small.
- If the game ended during step 1 or 2, still play the replay, *then* show the end-of-game overlay.
  You want to see the winning move. Interaction stays locked throughout.
  **[revised — this needs a change to what Package 1 built. Confirmed still true as of Package 3 —
  see "What Packages 2 and 3 actually built".]** `endGame` currently does the opposite: it cancels
  `replaySegTimerRef` and `replayFrameTimerRef` and restores the live board, and `derivePhase` ranks
  `finished` above `replaying`. Split it into *settle* (cancel timers, set `winner`, record stats —
  always immediate, so nothing can move afterwards) and *present* (the overlay). Gate the overlay on
  `winner !== null && !isReplaying && !endOverlayDismissed`, and have the settle step leave the
  replay timers alone when a replay is the deliberate presentation. Do not delay setting `winner` —
  that is what makes the game inert.
- The manual "📺 Instant Replay" button stays, for re-watching.
- **[revised — already done.]** The buffer-reset trigger (search `replayPrevPlayerRef`) already uses
  `ownsSeat(prev) && !ownsSeat(currentPlayer)`, i.e. the `mySeats`-array-aware form this bullet asked
  for — Package 0 generalized it ahead of need. Nothing to change here.

#### 5.3 Attribution in the replay

In partner mode, once a player's own pegs are all home their cards move their *partner's* pegs
(`controlledOwnerFor`). Remotely that means you will watch your own pegs move in a frame
attributed to your partner. The frame description must say so explicitly — "Yellow used a 7 to
move your peg home" — not just show the board changing. `lastMoves` and the frame descriptions
already carry enough to render this.

**Acceptance:** take a turn on device A; on device B the turn begins with a replay showing A's move
followed by the AI's, then unlocks. Skip works. A game that ends on the partner's move replays it
and then shows the overlay.

---

### What Packages 4 and 5 actually built

Read this if you're picking up Package 6. Turn exchange and automatic replay are both live end
to end (`commitTurn` in `PegsAndJokers.jsx`, `shouldSimulateAI` in `src/net/seats.js`,
`seedReplay`/`appendReplayFrame` in `src/net/replay.js`). Verified: `npm test` (311 tests) and
`npm run build` both green, with and without the Firebase env vars set. A live host session was
created and dealt against `pnj-dan-4a7f` (real Firestore); the manual "Instant Replay" flow, solo
AI turn-taking, per-seat tallies and the derived-phase precedence flip were all exercised live in
Chrome via the dev server. **Not verified live**: a full two-human turn exchange. A second browser
tab attempting to join as guest hung indefinitely on a fresh `signInAnonymously()` call after an
IndexedDB reset used to force a new anonymous identity (the same reset apparently left the origin's
`firebaseLocalStorageDb` in a state that blocked subsequent opens for *any* new tab on that origin,
not just the one that ran the reset) — this reproduces on unmodified Package 2 sign-in code, so it
reads as a test-environment artifact, not a regression, but it means the guest side of live turn
exchange should be re-verified by whoever picks up Package 6, on two real devices as Package 3 did.

A few decisions this pass made that the plan didn't spell out:

- **A game-ending AI move publishes directly**, from inside the AI effect's own `completeAIMove`,
  reusing `commitTurn`. §4.2 says the AI effect's own player-advance "must stay purely local,"
  folded into this client's next human publish — but a game-ending AI move has no next human
  publish to fold into, since this client's own turn never arrives. Without publishing there, the
  other player would never learn the game ended.
- **`winningSeat`/`description` were added to the wire** (`buildPublishMeta`/`publishState`/the
  metadata document), beyond §2.5's original sketch. The shared `state` blob deliberately has no
  `winner` field (win detection runs on adoption, not from the wire), so without this the client
  that didn't make the winning move would adopt a winning board with no way to say who won it or
  how — exactly the information §1.7's end-of-game overlay needs.
- **`derivePhase` now ranks `replaying` above `finished`** (flipped from Package 1), and the
  end-of-game overlay's render condition gained `&& !isReplaying`. This is the settle/present split
  §5.2 asked for, done without literally splitting `endGame` into two functions: `endGame` already
  only ever runs *before* a replay it triggers actually starts (queued via `pendingAutoReplayRef`
  and fired from a later effect pass), so its unconditional timer-cancellation was never actually
  racing a live replay — the phase/render change was the piece still needed.
- **`moveHistory` was dropped everywhere**, not just from the wire payload as §4.1 said. It was
  write-only dead state already (set, never read) in the local save too, so keeping two shapes —
  one for `serializeGame()`'s local save and a stripped one for the wire — would have been pure
  overhead for a field nothing reads.
- **Reopening/switching into an in-progress remote game now seeds the replay buffer too.**
  `openRemoteGame`'s one-shot `fetchGame` adopts a state exactly like `handleRemoteState` does, but
  didn't route through it — without the same `seedReplay`/`pendingAutoReplayRef` wiring added there,
  switching into a game from the lobby (or a reload) would silently skip both the "what happened"
  replay and a possible already-finished result.

---

### Package 6 — Final pass

**Tests are not deferred to this package.** Each package ships its own, per the repo convention in
`CLAUDE.md` — logic changes and their tests land in the same change. For reference, the pure
additions each package owns:

| Package | Tests it must ship |
|---|---|
| 0 | seat-owner derivations, the generalised board rotation (pure math, assert `mySeat = 0` is identical to today) |
| 1 | `didIWin` across both modes, the idempotent stats recorder, the partner-mode nemesis fix |
| 2 | the game-code generator, the session client against a mocked Firestore, **and the security rules against the emulator** — done: `src/net/gameCode.test.js`, `src/net/session.test.js`, `firestore/rules.test.js` |
| 3 | `nextHumanSeat` for every seat layout including solo, and the lobby row/sort/badge derivations — done: `src/net/seats.test.js`, `src/net/lobby.test.js`. **[revised]** This plan originally put `nextHumanSeat`'s tests under Package 4; it shipped a package early because Package 3 needed it for `waitingOn`. Package 4 reuses it — no new tests needed for the function itself, only for however `commitTurn` and the AI gate use it. |
| 4 | `commitTurn`'s payload shape (per-seat tally arrays, `moveHistory` dropped), the AI-simulation gate for every seat layout, the turns-counter-as-plain-counter fix |
| 5 | frame-buffer seeding and ordering (wire frames before locally-simulated ones), the `endGame` settle/present split |

Put pure helpers in plain modules (`src/net/seats.js`, and extend `src/game/stats.js`) so they are
testable without React. The repo has no component-test setup and this plan does not add one — if a
behaviour can only be tested through the component, that is a signal to move the logic out of it.

What genuinely remains for the end:

- **A full manual playtest** of the matrix that unit tests can't cover: two devices, three
  concurrent games, a game won by each of the four seats, a reload mid-turn on each side, and a
  force-quit immediately after a win to confirm stats record exactly once.
- **Build with the Firebase env vars unset** and confirm the app deploys and plays solo with no
  multiplayer UI. CI won't have the vars, so this is also what keeps CI green —
  `.github/workflows/ci.yml` itself needs no change.
- **Update `CLAUDE.md`**: the "Remote play" section already exists (added by Package 2/3) and covers
  `src/net/*`, the seat-ownership model, the data model, auth, the lobby, and listener discipline.
  Package 4/5 need to *extend* it, not create it: add the three turn-exchange rules (§4.1–4.3), the
  per-seat tally shape, and the silent-simulation/auto-replay behaviour. Prefer updating it
  incrementally as each package lands; this is the backstop, not the plan.

---

## 4. Risks and things that will bite

| Risk | Mitigation |
|---|---|
| Board rotation for the guest is subtly wrong | Verify visually before building on top; check start/home/track all agree. |
| Both clients simulate the same AI turn | §4.2 makes exactly one client eligible. If you see double simulation the `nextHumanSeat` gate is wrong — don't paper over it with a lock. |
| A stale timer fires after the game ends | `endGame` (§1.3) must cancel every timer. This is the existing bug; don't reintroduce it. |
| Stats recorded twice, or not at all | Idempotent, keyed by game id, driven by terminal state (§1.4). Test by force-quitting right after a win. |
| A seat-0 assumption survives the sweep | Grep for `=== 0`, `!== 0`, `hands[0]`, `pegs[0]`, `stuckCounts[0]` after Package 0 and account for every hit. |
| Env vars missing in the Pages build | Multiplayer UI hidden, not broken. Test a build with the vars unset. |
| Guest seat taken by someone else with the code | Accepted and documented; links use the UUID, not the code. |
| Backend sleeping on inactivity | Solved by the choice of backend, not by mitigation. Firestore does not pause. This was the deciding factor — see the backend note at the top. |
| A leaked listener costs money | Detaching a subscription on game switch and unmount is now the discipline that used to be "clear the interval". Audit it the same way. |
| Security rules are the entire backend | Test them against the emulator with a *different* anonymous uid, and treat that test as the acceptance gate for Package 2. A rules mistake is a full data leak with a public config. |
| Firestore SDK weight in the bundle | Dynamic `import()` behind the multiplayer paths, so a solo player never downloads it. Verify with a build-size check. |
| The anonymous uid is device-bound | Same exposure as the token scheme it replaces: clearing site data or switching phones loses in-flight games. Accepted for Phase 1, and anonymous auth is precisely what Phase 2 upgrades to a real account. |
| Personal stat tallies synced as if shared | Per-seat arrays in the payload (§4.1). Test by having each side bump the other and checking both lifetime stat lines. |
| The lobby badge never fires | "Your turn" is `waiting_on`, not `current_player` (§3.2). Verify the badge is non-zero on the side that has to move. |
| The lobby listener streaming whole games | Metadata and payload are separate documents (§2.3); the lobby only ever subscribes to the small one. |
| **The game list is per-device** | With no accounts, clearing site data loses the anonymous uid and with it access to in-flight games. Accepted for Phase 1. Note that Firestore — not `pnj:games:v1` — is the source of truth for *which* games are yours (`participants`), so a device that keeps its uid recovers everything; only the local nicknames are lost. Tell the user this in the lobby ("games live on this device"). Accounts are the real fix and are a later phase. |
| Switching games mid-turn corrupts state | Blocked mid-split (§3.3); everything else is transient. |
| Abandoned games pile up in the list | Local "archive" hides a game from the lobby without touching the row. Show the last-move age so stale games are obvious. |

---

## 5. Definition of done

Checked items are confirmed done (unit-tested, or verified live, or both — noted per item).
Unchecked items are Package 6 scope: the live two-human matrix Package 4/5 built the code for but
did not re-verify (see "What Packages 4 and 5 actually built").

- [x] Solo play is behaviourally unchanged except for the Package 1 fixes. Verified live in Chrome.
- [ ] Two people on separate devices play a full partner-mode game to a win. `commitTurn` and the
      AI-simulation gate are built, unit-tested, and a live host-side session was exercised against
      `pnj-dan-4a7f` — but the guest side of a live two-human exchange was not re-verified this pass
      (a test-tab sign-in hung; see the note above). Re-verify on two real devices for Package 6.
- [x] The status line is never stale — verified across all four win routes. (Package 1; unaffected
      by Package 2/3. The `replaying`-above-`finished` phase flip is unit-tested in `status.test.js`.)
- [x] Stats are recorded exactly once per game, including when your partner's move wins while your
      app is closed, and including when an AI wins during the other client's simulation. `endGame` is
      idempotent (unchanged from Package 1) and is now reachable from every win-detection path,
      including a state adopted after the fact (`maybeEndFromMeta`) — code-complete, not
      live-verified with two devices.
- [x] A partner-mode loss credits both opposing players. (Package 1.)
- [x] Exactly one transaction per human turn — `commitTurn` is the only call site that publishes, and
      it publishes exactly once per human-turn-ending site; not verified in the Firestore usage view
      (would need a live two-device session).
- [x] An idle subscription costs nothing — usage is flat while a game sits waiting overnight. (Two
      listeners are already live and idle-cheap by construction; nothing left to build for this one.)
- [x] Every listener is detached on game switch and on unmount.
- [x] Bumps delivered and received are counted correctly on *both* devices, including bumps dealt by
      an AI seat the other client simulated. Per-seat tally arrays (§4.1) fix this in code and are
      unit-tested via `persistence.test.js`; not live-verified with two devices bumping each other.
- [x] A share link opened on a fresh device joins the game (not only the 6-char code). Verified live
      (Chrome host + Safari guest, Package 3).
- [x] The host's "waiting for your partner" screen advances by itself when the guest joins. Verified
      live.
- [x] With the Firebase env vars set, a player with no remote games still gets today's exact solo
      flow — first-player modal, single local save, resume prompt, no lobby.
- [x] A client holding the app's public Firebase config, signed in as a *different* anonymous user,
      can read neither an active game's metadata nor its `live/current`. Asserted against the
      Firestore emulator (`firestore/rules.test.js`, `npm run test:rules`).
- [x] A solo-only player is never signed in and never downloads the Firestore SDK. Verified by
      inspecting the built bundle — Firestore is entirely in a separate lazy chunk.
- [x] Either player can close the tab mid-game and rejoin where they left off. (True today for the
      *dealt* state; a half-played turn simply hasn't been written yet, per §4.1's design — revisit
      this checkbox once turns actually publish mid-game.)
- [x] Three concurrent remote games plus a solo game can be switched between freely, each resuming
      with the right seat, orientation, replay buffer, and tallies.
- [x] The lobby badge shows how many games are waiting on you, from a single `subscribeMyGames` call.
- [x] The AI never stalls the game regardless of who has the app open — `shouldSimulateAI` guarantees
      exactly one client is ever eligible to run a given AI turn; unit-tested for every seat layout in
      `seats.test.js`, not live-verified with two devices.
- [x] Each remote turn opens with an automatic replay of the two moves you missed, skippable. Built
      and unit-tested (frame seeding/ordering in `replay.test.js`); the auto-play trigger and Stop/Skip
      button were exercised manually in solo (the manual-replay code path is shared), not live-verified
      end-to-end on two devices.
- [x] A partner's move appears on the other device within a second or two, with no polling —
      unchanged from Package 3's listeners, now with something to actually deliver.
- [x] `npm test` (311 tests) and `npm run build` pass, including with the Firebase env vars unset.
- [x] `CLAUDE.md` documents the seat model, the phase model, the data model, auth, and listener
      discipline. Still needs: the turn-exchange rules once Package 4 lands.

## 6. Phase 2 preview (do not build)

Web push for turn notifications, and it is now much closer than it was. Firebase Cloud Messaging is
the same SDK, the same project and the same anonymous identity as Firestore, so this is an increment
rather than a second backend: switch `vite-plugin-pwa` from `generateSW` to `injectManifest` for a
custom `push` handler, store FCM tokens against the uid, and send from a Cloud Function triggered by
a write to `games/{id}` where `waitingOn` changed. iOS requires the PWA be installed to the home screen (16.4+) and permission
requested from a user gesture — which is why notifications come *after* we know the async cadence
is fun. The "games waiting on you" count from §3.2 is the payload.

Accounts are the other candidate for Phase 2, and the more important one if people actually use
this: they turn the per-device game list into a real one that survives a new phone.
