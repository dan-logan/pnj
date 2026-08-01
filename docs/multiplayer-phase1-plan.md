# Multiplayer Phase 1 — Implementation Plan

**Status:** approved design, not yet implemented
**Branch:** `claude/multiplayer-remote-play-ecx61a`
**Audience:** the agent implementing this. Assume no memory of the design discussion — everything needed is here.

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
| Supabase Realtime subscriptions | Polling instead — see §4.4 for the reason. |
| Changing `NUM_PLAYERS`, board geometry, or any game rule | The engine is correct. Do not touch the rules in `src/game/engine.js`. |

### Non-negotiable constraint

**Solo play must be behaviourally unchanged.** Same feel, same offline PWA behaviour, same
localStorage save/resume, same stats. If the Supabase env vars are absent the app must build,
deploy, and play solo with no multiplayer UI visible. The deployed GitHub Pages site must never
break because a backend is missing or down.

The one deliberate exception is Package 1, which fixes real solo bugs in win handling and stats.
Those changes are visible in solo play and that is intended.

---

## 2. Why this shape (context you need to not re-litigate)

- **The rules engine is already pure.** `src/game/engine.js` and `src/game/ai.js` take state and
  return new state. Nothing there needs to change.
- **`serializeGame()` (`src/game/persistence.js:25`) is already the network payload.** A complete,
  plain-JSON snapshot — pegs, hands, deck, discards, current player, split state, tallies. A few KB.
  Sync the whole blob; no deltas, no CRDTs.
- **Turn-based and slow.** No realtime netcode needed. Polling is a legitimate transport.
- **`findBestAIMove` is deterministic** (no `Math.random` in `ai.js`; the only RNG is the deck
  shuffle in `deck.js:7` and the first-player spinner). The design doesn't depend on this, but it
  means a re-simulation can't diverge.
- **Partner mode is the right first mode.** Teammates share a win condition, which is why hidden
  hands can be skipped honestly rather than deferred as debt. The AI already plays partner mode
  properly.

---

## 3. Work packages

Ship in this order. Packages 0 and 1 need no backend and are independently verifiable.

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

- Every game gets an id — `crypto.randomUUID()` for solo, the Supabase row id for remote.
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

### Package 2 — Supabase backend

Create a Supabase project (free tier is sufficient). Add `@supabase/supabase-js`.

#### 2.1 The access model, in plain terms

The goal: **you can only read a game if you know its secret.** No secret, nothing — not even the
knowledge that the game exists.

Postgres gates table reads with row-level security (RLS): rules deciding which rows a caller may
see. The awkward part is that our clients have no login, so there is no per-user identity to
filter on, and the only easy policy is "anyone may read" — which would let anyone holding the
public anon key list every game in the table.

The mechanism that gives us what we want is a **`SECURITY DEFINER` function**: a database function
that runs with the *table owner's* permissions instead of the caller's. So we revoke all direct
table access from the client and expose only functions like `get_game(id, token)`. The function
checks the token itself and returns the row only if it matches. The client cannot read anything
without supplying the right secret. That is a real server-side check, not obscurity — the data is
genuinely unreachable otherwise.

Two secrets, which is roughly the code-plus-passcode shape we want:

- **Game code** — 6 typable characters, used *once* to join. Gets you a seat.
- **Seat token** — a random UUID minted when you take a seat, stored on your device, required on
  every read and every write from then on. This is the ongoing credential.

Share links carry the UUID id, not the short code, so a link isn't guessable. The one exposure:
anyone who sees the code before your partner joins could take the guest seat. The host sees that
happened (the game starts with the wrong person) and can start over. Accepted for Phase 1.

#### 2.2 Config

`.env` (gitignored) plus a committed `.env.example`:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

The anon key is public by design — it ships in the client bundle. That is safe precisely *because*
the schema below grants it no direct table access. Add both as GitHub Actions repository variables
and wire them into the build step in `.github/workflows/deploy.yml`, since the Pages build is
static and bakes them in.

#### 2.3 Schema

Keep the SQL in the repo at `supabase/schema.sql` so it is reviewable and re-runnable.

```sql
create table games (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  mode        text not null default 'partners',
  status      text not null default 'lobby',   -- lobby | active | finished
  host_token  uuid not null default gen_random_uuid(),
  guest_token uuid,
  state       jsonb,          -- serializeGame() output
  replay      jsonb not null default '[]',     -- frames for the last human move
  version     int  not null default 0,
  winner      int,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table games enable row level security;
-- deliberately no policies: the anon role reaches this table only through the
-- security-definer functions below.
```

#### 2.4 RPCs

All `SECURITY DEFINER`, granted to `anon`:

- `create_game(p_mode text) → (id, code, host_token)`
  Generates a 6-char code from an unambiguous alphabet (no `0/O/1/I`), retrying on unique violation.
- `join_game(p_code text) → (id, seat, guest_token, mode, status, state, version)`
  If `guest_token` is null, mint one and return seat 2. If already set, return the existing token
  so a reload rejoins.
- `get_game(p_id uuid, p_token uuid) → (state, replay, version, status, winner, mode)`
  Token must match `host_token` or `guest_token`.
- `publish_state(p_id uuid, p_token uuid, p_state jsonb, p_replay jsonb, p_version int, p_winner int) → int`
  Compare-and-swap: update only `where id = p_id and version = p_version`; set `version = version + 1`,
  `updated_at = now()`, and `status = 'finished'` when `p_winner` is not null. If no row is updated,
  raise a distinguishable error (`errcode 'P0001'`, message `version_conflict`) so the client can
  re-read and adopt.
- `start_game(p_id uuid, p_token uuid, p_state jsonb) → int`
  Host-only. Sets the initial dealt state, `status = 'active'`, `version = 1`.

#### 2.5 Client module

`src/net/session.js`, plain JS, no React:

```js
export function isMultiplayerConfigured()   // both env vars present
export async function createGame(mode)
export async function joinGame(code)
export async function fetchGame(id, token)
export async function publishState(id, token, payload)  // throws VersionConflict
export async function startGame(id, token, state)
```

Plus `src/net/localSession.js` — the active remote game's `{ id, token, seat, code }` in
localStorage under `pnj:remoteGame:v1`, so a reload rejoins without re-entering anything.

**Acceptance:** unit tests for the code generator and the client module against a mocked
`supabase-js` (follow the injectable-backend pattern in `stats.js` / `persistence.js`). Manually
confirm that a client holding the anon key but no token can read nothing.

---

### Package 3 — Lobby UI

Small and deliberately boring. Only rendered when `isMultiplayerConfigured()` is true.

- **"Play with a friend"** on the existing first-player modal.
- **Host:** creates the game → shows the 6-char code and a copyable share link (`?g=<uuid>`) →
  "Waiting for your partner to join…". Polls `get_game` every 3 s until `guest_token` is set, then
  deals (`startGameWithPlayer`) and calls `start_game`.
- **Guest:** opening `?g=<uuid>` (or entering the code) calls `join_game`, stores the session
  locally, and waits until `status = 'active'`.
- **First player:** host-only. Reuse the existing modal and spinner (`:220`); the guest never sees it.
- **Rejoin:** on mount, if `pnj:remoteGame:v1` exists and its game isn't `finished`, resume the
  remote game instead of offering the local save.

**Local save interaction.** The localStorage save (`persistence.js`) remains the source of truth
for **solo only**. In a remote game the server row is the save: skip the save effect at `:1132`
when a remote session is active, and don't offer the local resume modal over a remote game.

**Acceptance:** two browser profiles; host creates, guest joins by link and by code; both land on a
dealt board with the correct seat; the guest sees their own pegs at the bottom.

---

### Package 4 — Turn exchange (the core)

Three rules. Get these exactly right; everything else is UI.

#### 4.1 Publish once, at handoff

A client writes **exactly once per human turn**: after its own move completes and the turn passes
on. Never mid-turn.

Consequence worth knowing: a half-finished split never crosses the wire (`splitRemaining` is always
0 in a published snapshot). If a player disconnects mid-split the server still holds the pre-turn
state and their turn simply starts over when they return. That is intended.

The three sites where a human turn ends are `executeMove` (`:699`), `completeSplit` (`:780`), and
`discardAndDraw`'s human branch (`:894`). Route all three through one `commitTurn(nextPlayer,
nextState)` helper rather than duplicating publish logic three times.

Payload: `serializeGame(...)` as-is, plus the replay frames for the move just made.

#### 4.2 Simulate AI only when the chain leads to your seat

This is the rule that removes any need for server-side AI or for anyone to keep a tab open.

Turn order is fixed 0→1→2→3→0 and the AI seats sit *between* the two humans, so:

> A client runs the AI seats forward only when the run of AI seats after `currentPlayer`
> terminates at one of **its own** seats.

```js
// The next non-AI seat at or after `from`, walking the fixed turn order.
function nextHumanSeat(from, seatOwners) {
  let p = from;
  for (let i = 0; i < 4; i++) {
    if (seatOwners[p] !== 'ai') return p;
    p = (p + 1) % 4;
  }
  return from;
}
```

Gate the AI effect (`:918`) on `mySeats.includes(nextHumanSeat(currentPlayer, seatOwners))`.

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

#### 4.4 Poll while waiting

While it is not your turn and a remote session is active, poll `get_game` every 4 s, plus on
`visibilitychange` and `focus` (mobile players will background the tab). Stop once the state
arrives with your seat to move, or the game is finished.

On a state with a **higher version**: adopt it wholesale via the existing `applySavedGame` path
(`:280`) — note that `applySavedGame` currently forces `setWinner(null)` at `:288`, which must
become "apply the snapshot's winner" — then seed `replayLogRef` from the received `replay` frames
and let §4.2 decide whether to simulate.

On a **version conflict** when publishing: re-read, adopt, and surface a non-destructive notice.
With one writer per turn this should be unreachable; treat it as a bug signal, not a routine path.

**Acceptance:** a complete two-device partner game start to finish, including a joker bump, a 7/9
split, a stuck discard, and a browser reload mid-game on each side.

---

### Package 5 — Automatic replay on turn start

When your turn begins remotely you have missed two moves — your partner's and an AI's. Replay them
automatically instead of making you press a button.

#### 5.1 Flow

On receiving a state where the AI chain leads to your seat:

1. Adopt the state (your partner's move already applied); seed `replayLogRef` from the wire frames.
2. Run the AI seats **silently** — no animation, no 800 ms thinking delay — recording frames.
   Reuse the existing `animationsEnabled === false` branch in the AI effect (`:1035`).
3. Auto-start the replay over the whole buffer: partner's move, then the AI moves, at replay pace.
4. Replay ends → your turn, interaction unlocks.

**Why silent-then-replay rather than live-then-optional-replay:** if the AI animates live you watch
it once at full speed and then again in the replay. Simulating silently and replaying the whole
run gives one coherent "here's what happened since your last turn" sequence, in order, at a
readable pace.

#### 5.2 Details

- The replay banner (`:1911`) gets a **Skip** button — `stopReplay` already does the right thing.
- `animationsEnabled === false` → no auto-replay; show a text summary of the frames instead.
- No frames (your first turn, a fresh join) → no replay.
- **Solo is unchanged**: the AI still animates live and the replay button stays manual. Silent
  simulation and auto-replay are remote-only. This is one conditional in the AI effect and one at
  turn start — keep it that small.
- If the game ended during step 1 or 2, still play the replay, *then* show the end-of-game overlay.
  You want to see the winning move. Interaction stays locked throughout.
- The manual "📺 Instant Replay" button (`:1902`) stays, for re-watching.
- Update the buffer-reset trigger at `:405` from `prev === 0` to `prev === mySeat`.

#### 5.3 Attribution in the replay

In partner mode, once a player's own pegs are all home their cards move their *partner's* pegs
(`controlledOwnerFor`, `:151`). Remotely that means you will watch your own pegs move in a frame
attributed to your partner. The frame description must say so explicitly — "Yellow used a 7 to
move your peg home" — not just show the board changing. `lastMoves` and the frame descriptions
already carry enough to render this.

**Acceptance:** take a turn on device A; on device B the turn begins with a replay showing A's move
followed by the AI's, then unlocks. Skip works. A game that ends on the partner's move replays it
and then shows the overlay.

---

### Package 6 — Tests, docs, CI

- Unit-test the pure additions next to their modules, per repo convention: `nextHumanSeat`, the
  seat-owner derivations, `didIWin`, the idempotent stats recorder, the partner-mode nemesis fix,
  the game-code generator, the session client against a mocked backend. Put the seat helpers in a
  plain module (`src/net/seats.js`) so they are testable without React — the repo has no
  component-test setup and this plan does not add one.
- CI (`.github/workflows/ci.yml`) needs no change; it runs `npm test` and the build. Ensure the
  build passes **without** the Supabase env vars, since CI won't have them.
- Update `CLAUDE.md`: a "Remote play" section covering `src/net/*`, the seat-ownership model, the
  three turn-exchange rules, the derived-phase/status model, and the fact that solo is the
  `['me','ai','ai','ai']` special case.

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
| Supabase free tier pausing on inactivity | Fail soft — keep the board readable and show a reconnect notice. |

---

## 5. Definition of done

- [ ] Solo play is behaviourally unchanged except for the Package 1 fixes.
- [ ] Two people on separate devices play a full partner-mode game to a win.
- [ ] The status line is never stale — verified across all four win routes.
- [ ] Stats are recorded exactly once per game, including when your partner's move wins while your
      app is closed, and including when an AI wins during the other client's simulation.
- [ ] A partner-mode loss credits both opposing players.
- [ ] Exactly one write per human turn (verify in the Supabase logs).
- [ ] A client holding the anon key but no seat token can read nothing.
- [ ] Either player can close the tab mid-game and rejoin where they left off.
- [ ] The AI never stalls the game regardless of who has the app open.
- [ ] Each remote turn opens with an automatic replay of the two moves you missed, skippable.
- [ ] `npm test` and `npm run build` pass, including with the Supabase env vars unset.
- [ ] `CLAUDE.md` documents the seat model, the phase model, and the turn-exchange rules.

## 6. Phase 2 preview (do not build)

Web push for turn notifications: switch `vite-plugin-pwa` from `generateSW` to `injectManifest` for
a custom `push` handler, store subscriptions per seat, send from a Supabase Edge Function with
VAPID on turn change. iOS requires the PWA be installed to the home screen (16.4+) and permission
requested from a user gesture — which is why notifications come *after* we know the async cadence
is fun.
