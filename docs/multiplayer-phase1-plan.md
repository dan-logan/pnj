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
| Hidden hands / RLS on hands | Partners share a win condition, so there is no incentive to peek. Deliberately out of scope. |
| Server-side AI execution | Not needed — see §4.3. |
| Supabase Realtime subscriptions | Polling instead — see §4.5 for the reason. |
| Changing `NUM_PLAYERS`, board geometry, or any game rule | The engine is correct. Do not touch `src/game/engine.js` rules. |

### Non-negotiable constraint

**Solo play must be byte-for-byte unchanged.** Same feel, same offline PWA behaviour, same
localStorage save/resume, same stats. If the Supabase env vars are absent the app must build,
deploy, and play solo exactly as it does today with no multiplayer UI visible. The deployed
GitHub Pages site must never break because a backend is missing or down.

---

## 2. Why this shape (context you need to not re-litigate)

- **The rules engine is already pure.** `src/game/engine.js` and `src/game/ai.js` take state and
  return new state. Nothing there needs to change.
- **`serializeGame()` (`src/game/persistence.js:25`) is already the network payload.** It is a
  complete, plain-JSON snapshot of a game — pegs, hands, deck, discards, current player, split
  state, tallies. A few KB. Sync the whole blob; no deltas, no CRDTs.
- **Turn-based and slow.** No realtime netcode needed. Polling is a legitimate transport.
- **`findBestAIMove` is deterministic** (no `Math.random` in `ai.js`; the only RNG is deck shuffle
  in `deck.js:7` and the first-player spinner). The design below doesn't depend on this, but it
  means a re-simulation can't diverge.
- **Partner mode is the right first mode.** Teammates share a win condition, which is why hidden
  hands can be skipped honestly rather than deferred as debt. The AI already plays partner mode
  properly (scores by team distance, plays for its partner, values friendly bumps).

---

## 3. Work packages

Ship in this order. Package 0 is the bulk of the work and is independently verifiable with no
backend at all.

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
- `:918` AI effect guard — becomes `if (isMyTurn || winner !== null) return;` **and then gets an
  additional condition in Package 3.**
- `:1081` "your turn" chime — `currentPlayer === mySeat`
- `:1175` `movablePegSet`
- `:1194` `ghostDestinations`
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
- `:1204` `hands[0]` → `hands[mySeat]` (and every other bare `hands[0]`, incl. `:1272`, `:2313`)
- `:2313`/`:2321` `stuckCounts[0]` → `stuckCounts[mySeat]`

*Stats tallies:*
- `:536` `if (mover === 0 && b.player !== 0)` / `if (mover !== 0 && b.player === 0)` — these are
  "bumps I delivered" and "times I was bumped". Use `mySeats.includes(...)`.

*Board rotation — three helpers, one change each:*
- `:1383` `getTrackPosition`: `const visualSide = (side + 2) % 4`
- `:1417` `getStartAreaPosition`: `const visualSide = (player + 2) % 4`
- `:1454` `getHomePosition`: `const visualSide = (player + 2) % 4`

Generalise all three to `(x - mySeat + 2) % 4` (where `x` is `side` or `player`). Check: with
`mySeat = 0` this is identical to today; with `mySeat = 2`, seat 2 maps to visualSide 2 = bottom,
so the guest sees their own pegs at the bottom of the screen exactly as the host does. Verify the
rotation visually for the guest before moving on — it is the single easiest thing to get subtly
wrong, and everything downstream looks fine while being wrong.

*Labels:*
- `:1478` `roleLabel` — `'You (Yellow)'` becomes seat-relative: `mySeats.includes(player)` →
  `` `You (${PLAYER_NAMES[player]})` ``; partner/opponent already derives from `sameTeam(player, 0)`,
  change to `sameTeam(player, mySeat)`. Remote opponents should read `(Partner)` / `(AI)` rather
  than `(AI)` for the human seat — see Package 4.

**Acceptance:** solo play is indistinguishable from `main`. Full game start → win, save/resume,
replay, stats, partner mode, split undo, joker targeting, stuck discard. `npm test` green.
`seatOwners` is still `['me','ai','ai','ai']` everywhere in solo.

---

### Package 1 — Supabase backend

Create a Supabase project (free tier is sufficient). Add `@supabase/supabase-js`.

**Config** — `.env` (gitignored) plus a committed `.env.example`:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

The anon key is public by design — it ships in the client bundle. That is fine *because the schema
below grants anon no direct table access at all.* Add both as GitHub Actions repository variables
and wire them into the build step in `.github/workflows/deploy.yml`, since the Pages build is
static and bakes them in.

**Schema.** RLS on, no policies — anon reaches the table only through `SECURITY DEFINER` functions.
This is what stops anyone with the anon key from enumerating every game in the table.

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
-- deliberately no policies: all access is via the rpcs below
```

**RPCs** (all `SECURITY DEFINER`, granted to `anon`):

- `create_game(p_mode text) → (id, code, host_token)`
  Generates a short human-typable `code` (6 chars, unambiguous alphabet — no `0/O/1/I`), retrying
  on unique violation.
- `join_game(p_code text) → (id, seat, guest_token, mode, status, state, version)`
  If `guest_token` is null, mint one and return seat 2. If already set, return the existing token
  (so a reload rejoins). **Tradeoff, accepted:** anyone holding the code can occupy the guest seat.
  The code is the credential; treat it like the link it is.
- `get_game(p_id uuid, p_token uuid) → (state, replay, version, status, winner, mode)`
  Token must match `host_token` or `guest_token`.
- `publish_state(p_id uuid, p_token uuid, p_state jsonb, p_replay jsonb, p_version int, p_winner int) → int`
  Compare-and-swap: update only `where id = p_id and version = p_version`, set
  `version = version + 1`, `updated_at = now()`, `status = case when p_winner is not null then
  'finished' else 'active' end`. If no row updated, raise a distinguishable error (e.g.
  `errcode 'P0001'`, message `version_conflict`) so the client can re-read and adopt.
- `start_game(p_id uuid, p_token uuid, p_state jsonb) → int`
  Host-only. Sets initial state, `status = 'active'`, `version = 1`.

Keep the SQL in the repo at `supabase/schema.sql` so it is reviewable and re-runnable.

**Client module** — `src/net/session.js`, plain JS, no React:

```js
export function isMultiplayerConfigured()          // both env vars present
export async function createGame(mode)
export async function joinGame(code)
export async function fetchGame(id, token)
export async function publishState(id, token, payload)  // throws VersionConflict
export async function startGame(id, token, state)
```

Plus `src/net/localSession.js` — the active remote game's `{ id, token, seat, code }` in
localStorage under `pnj:remoteGame:v1`, so a reload rejoins without re-entering the code.

**Acceptance:** unit tests for the code generator and for the client module against a mocked
`supabase-js` (follow the injectable-backend pattern already used in `stats.js`/`persistence.js`).
Manual: create a game and join it from a second browser profile via SQL/console, no UI yet.

---

### Package 2 — Lobby UI

Small and deliberately boring.

- On the existing first-player modal, add **"Play with a friend"** — only rendered when
  `isMultiplayerConfigured()` is true.
- **Host flow:** creates the game → shows the 6-char code and a copyable share link
  (`?g=<uuid>` — use the UUID in the link, not the short code, so links aren't guessable) →
  "Waiting for your partner to join…" with a spinner. Poll `get_game` every 3s until
  `guest_token` is set, then deal (`startGameWithPlayer`) and `start_game(...)`.
- **Guest flow:** opening `?g=<uuid>` (or entering the code) calls `join_game`, stores the session
  locally, and shows "Waiting for the host to deal…" until `status = 'active'`.
- **First player:** host-only choice. Reuse the existing modal; the guest never sees it.
  The random spinner (`:220`) stays host-side.
- **Rejoin:** on mount, if `pnj:remoteGame:v1` exists and its game is not `finished`, resume the
  remote game instead of offering the local save.

**Local save interaction.** The localStorage save (`persistence.js`) stays the source of truth for
**solo only**. In a remote game the server row is the save. Skip the save effect at
`src/PegsAndJokers.jsx:1132` when a remote session is active, and don't offer the local resume
modal over a remote game.

**Acceptance:** two browser profiles, host creates, guest joins by link and by code, both land on a
dealt board with the correct seat, guest sees their own pegs at the bottom.

---

### Package 3 — Turn exchange (the core)

Three rules. Get these exactly right; everything else is UI.

#### 3.1 Publish once, at handoff

A client writes **exactly once per human turn**: after its own move completes and the turn passes on.
Never mid-turn.

Consequence worth knowing: a half-finished split never crosses the wire (`splitRemaining` is always
0 in a published snapshot). If a player disconnects mid-split, the server still holds the pre-turn
state and their turn simply starts over when they return. That is intended.

Publish sites are the three places the turn advances after a human move:
`executeMove` (`:699`), `completeSplit` (`:780`), and `discardAndDraw`'s human branch (`:894`).
Route all three through one new `commitTurn(nextPlayer, nextState)` helper rather than duplicating
publish logic three times.

Payload: `serializeGame(...)` (reuse it as-is) plus the replay frames for the move just made.

#### 3.2 Simulate AI only when the chain leads to your seat

This is the rule that removes the need for any server-side AI and for anyone to keep a tab open.

Turn order is fixed 0→1→2→3→0, and the AI seats sit *between* the two humans. So:

> A client runs the AI seats forward only when the run of AI seats after `currentPlayer`
> terminates at one of **its own** seats.

```js
// The next human seat at or after `from`, walking the fixed turn order.
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

Trace it: host moves and publishes with `currentPlayer = 1`. On the host, `nextHumanSeat(1) = 2` —
not mine, so the host stops and shows "Waiting for Pink". On the guest, `nextHumanSeat(1) = 2` —
that's me, so the guest simulates Blue locally, watches the animation, and then it is their turn.
No write in between. Symmetrically the guest publishes `currentPlayer = 3` and the host simulates
Green. **One write per human turn, always to a human, and the player who is about to move is the
one who watches the AI play.**

In solo this predicate is always true (every AI chain leads back to seat 0), so solo behaviour is
unchanged — that is the invariant to check first if solo ever regresses.

#### 3.3 Poll while waiting

While it is not your turn and a remote session is active, poll `get_game` every 4s, and
additionally on `visibilitychange` and `focus` (mobile players will background the tab). Stop
polling once the state arrives with your seat to move, or the game is finished.

On receiving a state with a **higher version**: adopt it wholesale via the existing
`applySavedGame` path (`:280`), seed `replayLogRef` from the received `replay` frames, then let
rule 3.2 decide whether to simulate.

On a **version conflict** when publishing: re-read, adopt the server's state, and surface a
non-destructive message. This should be effectively impossible with one writer per turn — treat it
as a bug signal, not a routine path.

#### 3.4 Win handling

`checkWinner(pegs, mode)` returns a **team index** in partner mode, and both humans are team 0 —
so the existing `winner === 0` checks give the right answer for both clients unchanged. Do not
mistake that for the checks being seat-agnostic; `:536` genuinely is not.

If a win occurs during a client's local AI simulation, that client must publish the final state
(with `p_winner`) so the other player learns the game ended.

**Acceptance:** a complete two-device partner game start to finish, including at least one joker
bump, one 7/9 split, one stuck discard, and one browser reload mid-game on each side.

---

### Package 4 — Feedback and polish

- **Turn indicator.** Extend the "your turn" chime at `:1081` to fire on `mySeat`. While waiting,
  the message area shows "Waiting for Pink…" with a relative timestamp from `updated_at`.
- **Attribution in messages.** In partner mode, once a player's own pegs are all home their cards
  move their *partner's* pegs (`controlledOwnerFor`, `:151`). Remotely, that means the guest sees
  their own pegs move without touching anything. The message must say so explicitly —
  "Yellow used a 7 to move your peg home", not a silently changed board. `lastMoves` and the replay
  frames already carry enough to render this.
- **Replay across the wire.** Frames are plain JSON
  (`{ player, description, pegsBefore, pegsAfter, segments }`, see `:863`). The mover publishes the
  frames for its own move; the receiver seeds `replayLogRef` with them, then the locally-simulated
  AI frames append via the existing `recordReplayFrame` (`:120`). The existing "📺 Instant Replay"
  button then replays *everything since your last turn*, including your partner's move. Update the
  buffer-reset trigger at `:405` from `prev === 0` to `prev === mySeat`.
- **Role labels.** `roleLabel` (`:1478`) should distinguish a human partner from an AI:
  "Pink (Partner)" vs "Blue (AI)".
- **Stats-on-load fix.** Stats are folded in by the effect at `:1108`, which only fires if the
  client is open at the moment of the win. Remotely, your partner may never see that transition.
  Record from the final snapshot on load when a finished remote game is fetched and not yet
  recorded (`gameRecordedRef` equivalent, persisted per game id). Small, and it quietly corrupts
  stats for months if skipped.

---

### Package 5 — Tests, docs, CI

- Unit-test the pure additions next to their modules, per repo convention: `nextHumanSeat`, the
  seat-owner derivations, the game-code generator, the session client against a mocked backend.
  Put the seat helpers in a plain module (e.g. `src/net/seats.js`) so they are testable without
  React — the repo has no component-test setup and this plan does not add one.
- CI (`.github/workflows/ci.yml`) needs no change; it runs `npm test` and the build. Make sure the
  build passes **without** the Supabase env vars set, since CI won't have them.
- Update `CLAUDE.md`: a short "Remote play" section covering `src/net/*`, the seat-ownership model,
  the three rules in §3, and the fact that solo is the `['me','ai','ai','ai']` special case.

---

## 4. Risks and things that will bite

| Risk | Mitigation |
|---|---|
| Board rotation for the guest is subtly wrong | Verify visually before building anything on top; check seat 2 renders at the bottom and that start/home/track all agree. |
| Both clients simulate the same AI turn | Rule 3.2 makes exactly one client eligible. If you see double simulation, the `nextHumanSeat` gate is wrong — don't "fix" it with a lock. |
| A seat-0 assumption survives the sweep | Grep for `=== 0`, `!== 0`, `hands[0]`, `pegs[0]`, `[0]` after Package 0 and account for every hit. |
| Env vars missing in the Pages build | Multiplayer UI must be hidden, not broken. Test a build with the vars unset. |
| Guest seat hijack by anyone with the code | Accepted for Phase 1 and documented. Links use the UUID, not the short code. |
| Supabase free tier pausing on inactivity | Known; a paused project fails the poll. Fail soft — keep the board playable and show a reconnect message. |

---

## 5. Definition of done

- [ ] Solo play is unchanged: full game, save/resume, replay, stats, both modes, offline PWA.
- [ ] Two people on separate devices play a full partner-mode game to a win.
- [ ] Exactly one write per human turn (verify in the Supabase logs).
- [ ] Either player can close the tab mid-game and rejoin where they left off.
- [ ] The AI never stalls the game regardless of who has the app open.
- [ ] Instant Replay on each turn shows the partner's move *and* the AI move that followed.
- [ ] `npm test` and `npm run build` pass, including with the Supabase env vars unset.
- [ ] `CLAUDE.md` documents the seat model and the three turn-exchange rules.

## 6. Phase 2 preview (do not build)

Web push for turn notifications: switch `vite-plugin-pwa` from `generateSW` to `injectManifest` for
a custom `push` handler, store subscriptions per seat, send from a Supabase Edge Function with
VAPID on turn change. iOS requires the PWA be installed to the home screen (16.4+) and permission
requested from a user gesture — which is why notifications come *after* we know the async cadence
is fun.
