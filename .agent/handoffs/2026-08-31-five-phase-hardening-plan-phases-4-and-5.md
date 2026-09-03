# HANDOFF — SMARTER.POKER FIVE-PHASE HARDENING

## Phases 1-3 SHIPPED AND VERIFIED LIVE · Phases 4-5 OPEN

**Author:** cowork-claude · **Written:** 2026-08-31 12:15 UTC · **Rewritten in full:** 12:40 UTC
**Repos:** `club-arena` (all work to date). Phase 5 also touches `Smarter-Poker-World-Hub`.
**Read before this:** `AGENT-PLAYBOOK.md`, then this repo's `CLAUDE.md` — in
particular §4 (fix-first), §10.5 (HORSES ARE PLAYERS), §11.5 (never spend real
chips to test a rule), §12 (never rebase main). This document assumes both and
does not repeat them.

> **If you read only one thing:** phases 1-3 are done, merged and verified in the
> served production bundle. **Phase 4 as originally scoped has been largely
> solved by ANOTHER AGENT while I was in phase 3 (PR #2115).** Run the queries
> in §5.4 before building anything. Phase 5 is the highest-value remaining work
> and I recommend proposing it first.

---

## TABLE OF CONTENTS

0. Thirty-second orientation
1. How this started, and the plan's shape
2. PHASE 1 — the seat-truth contract (DONE)
3. PHASE 2 — the silent-client canary (DONE)
4. PHASE 3 — definer exposure (DONE)
5. PHASE 4 — reconciliation: **the premise has MOVED, re-scope first**
6. PHASE 5 — pipeline and queue health (recommend doing FIRST)
7. Everything else I found and did not action
8. Exact live state, and how to verify publication without the GitHub API
9. Operating rules for this estate that cost me time to learn
10. Your first hour

---

## 0. THIRTY-SECOND ORIENTATION

Dan reported a bug at 08:00 UTC: he sat at a table, the felt said _"Seat
Reserved, You'll Be Dealt In Next Hand"_ forever, then _"Sitting Out. Seat At
Risk"_, then he was evicted after five minutes. Root-causing it opened a
five-phase hardening plan he has been driving one phase at a time.

**Phases 1, 2 and 3 are complete, merged, and verified live in production.
Phases 4 and 5 remain.** Everything below is evidence-backed. Where I could not
verify something, it says so explicitly.

---

## 1. HOW THIS STARTED, AND THE PLAN'S SHAPE

| Phase | Scope                                                                    | State                         |
| ----- | ------------------------------------------------------------------------ | ----------------------------- |
| 1     | Seat-truth contract — engine publishes capacity, client stops guessing   | **DONE** (5 PRs)              |
| 2     | Silent-client canary — distinguish an absent player from a broken client | **DONE** (2 PRs)              |
| 3     | Definer exposure — 852 Supabase security lints                           | **DONE** (1 PR, 2 migrations) |
| 4     | Reconciliation that can be trusted                                       | **OPEN — RE-SCOPE, see §5**   |
| 5     | Pipeline + queue health                                                  | **OPEN — recommend first**    |

**Dan's required reporting format** at the end of each phase:

```
PHASE N OF 5 IS DONE
<summary>
READY TO START PHASE N+1 OF 5
```

**Dan's standing expectations**, learned the hard way across this session:

- Verify against reality. Never claim success before you can _see_ it in production.
- **A merged PR is not a shipped feature.** Pull the served bundle and grep it.
- Fix a red `main` before your own work — a red `main` blocks publishing platform-wide.
- **Audit the previous phase before starting the next.** Every audit today found
  a real defect in the phase before it, **including two of my own**.
- Handoffs are BOTH committed to `.agent/handoffs/` AND pasted into the chat (RULE 0).

---

## 2. PHASE 1 — THE SEAT-TRUTH CONTRACT (DONE)

### 2.1 What actually happened to Dan, minute by minute

**The engine was never broken.** `hand_history` proves it did everything right
for table `08746c1a-eb99-403a-ad98-63e9739ef4e9`, seat 7, 2026-08-31:

| Time (UTC) | Event                                                                                                                                                                     | Evidence                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 00:27:13   | He takes seat 7                                                                                                                                                           | `table_seats.joined_at`                                      |
| 00:27:36   | Hand **#3769181** — wait-for-BB hold released because the big blind reached his seat. Action log `7:bb:5` then `7:return:3`. **He posted his big blind and WON the pot.** | `hand_history.action_log`, `winners`                         |
| 00:28:58   | Hand **#3769234** — dealt in, folded by timeout                                                                                                                           | `dealt_seats` contains 7                                     |
| 00:30:19   | Hand **#3769289** — dealt in, folded by timeout                                                                                                                           | `dealt_seats` contains 7                                     |
| ~00:32:5x  | Three strikes → forced sit-out                                                                                                                                            | From **#3769389** onward, `dealt_seats` no longer contains 7 |
| 00:37:50   | Seat evicted                                                                                                                                                              | `table_seats.left_at`                                        |

**His client never rendered a frame of it.** `tableState.maxPlayers` is seeded
to **6** in `TablePage.tsx` and corrected only when the client's own `tables`
row query lands. `mapEngineSnapshot` then dropped every seat above that number:

```ts
const idx = p.seat - 1;
if (idx < 0 || idx >= maxSeats) continue; // seat 7 on a 9-max table = the hero
```

So the hero row was absent from `players[]`: no hole cards, no action bar, and
the footer fell through to "Seat Reserved, You'll Be Dealt In Next Hand". The
engine offered him turns nobody could see.

### 2.2 The type lie that disarmed the compiler

`TableState.maxPlayers` was typed `6 | 9`. The estate holds **102,664 tables**,
and **43,226 of them are 2, 3, 7 or 8-max** — a third of the platform outside
the type that claimed to describe it. Every assignment carried `as 6 | 9`, so at
each site the one tool that could have caught this was explicitly told to look
away. Widened to `number` in #2049.

### 2.3 The five seat-drop sites (all fixed)

| #   | Location                                             | Why it mattered                                                                                                                    |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/utils/mapEngineSnapshot.ts`                     | The main snapshot mapper — the incident itself                                                                                     |
| 2   | `applySeats` in `TablePage.tsx` (~L1990)             | REST prefetch that paints the felt in the 3-5s before the websocket connects — **exactly when `maxPlayers` is still the seeded 6** |
| 3   | Realtime seat merge, `TablePage.tsx` (~L11080)       | Its own comment calls it "the source of truth for seated players"                                                                  |
| 4   | Seat-first roster rebuild, `TablePage.tsx` (~L16060) | Runs on a table that has not dealt yet, so the guess is at its least reliable                                                      |
| 5   | `GAME_START` resync path (~L12240)                   | Full-state resync after a websocket sequence gap                                                                                   |

### 2.4 The three payloads that now carry `max_seats`

In `server/src/engine/ServerTableEngine.ts`, each reading
`Number(this.tableInfo?.max_players) || 0` — the table row, never the roster:

1. **`broadcastCurrentState()`** (~L439) — the live payload.
2. **`publishIdleState()`** (~L634) — between hands. **A seat-first joiner at a
   quiet table sees ONLY this one**, so publishing on the live payload alone
   would leave the hole exactly where a new player is looking.
3. **`getTableState()`** — answers `GET /state/:id`, which is what
   `TableWebSocket.resync()` fetches on a **sequence gap** and dispatches as
   `GAME_START`. **I missed this in the first cut and it is the one that matters
   most:** a client that just lost frames is precisely the one whose local view
   may be wrong, and its fallback infers width from the **hand roster**, which
   omits anybody not dealt in — a player waiting for the big blind. So the
   inference can land _below_ the truth. That is the original bug's own starting
   position, reached through the recovery path. Added in #2102.

### 2.5 The mapper's resolution order (read this before touching it)

```
published max_seats  >  highest occupied seat  >  caller's maxPlayers
```

with one absolute clamp: **a published capacity may never drop a seat that
holds a player.** A ghost seat is cosmetic. An erased hero costs somebody their
stack. The shipped code:

```ts
const highestSeat = (s.players ?? []).reduce((m, p) => Math.max(m, p.seat ?? 0), 0);
const publishedMaxSeats = Number((s as unknown as { max_seats?: number }).max_seats ?? 0);
const effectiveMaxSeats =
  Number.isFinite(publishedMaxSeats) && publishedMaxSeats > 0
    ? Math.max(publishedMaxSeats, highestSeat)
    : Math.max(maxSeats, highestSeat);
```

Live minified proof from the served bundle:
`c=Number(i.max_seats??0),u=Number.isFinite(c)&&c>0?Math.max(c,l):Math.max(s,l)`

### 2.6 The PRs

| PR        | Merge SHA    | Contents                                                                                                                                                                             |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#2020** | `8ce3847fb7` | Mapper can never drop a published seat; both TablePage merge paths grow; `persistEntryHold` writes chained per user                                                                  |
| **#2049** | `8ce3847fb7` | Engine publishes `max_seats`; `maxPlayers` widened `6\|9` → `number`; mirror invariant; `SeatCountIsPublished.test.ts` (72 lines) + `snapshotNeverDropsASeat.law.test.ts` (64 lines) |
| **#2068** | `bc8dda0700` | **My infinite loop**, the prefetch drop site, and main's red tests. Adds `src/lib/heroSeatReconcile.ts` (104 lines) + test (112 lines)                                               |
| **#2085** | `8b28876d19` | Seat-drop sites 3 and 4                                                                                                                                                              |
| **#2102** | `728b2c49ed` | Seat bound derived from `SEAT_LAYOUTS`; `max_seats` on the third payload                                                                                                             |

_(#2020 and #2049 share a squash SHA in my notes; treat #2049 as the canonical phase-1 commit.)_

### 2.7 THREE MISTAKES I MADE — the most useful part of this document

#### (a) I wrote an infinite render loop into the rescue path (#2049, fixed in #2068)

The new "engine seats you, client renders nothing" invariant healed like this:

```ts
setTableState((prev) => {
  if (prev.players[seat - 1]?.id === userId) return prev;  // CAN NEVER BE TRUE
  const players = [...prev.players];
  while (players.length < seat) players.push(null);        // pushes NULLs only
  return { ...prev, players, ... };                        // always a NEW object
});
```

The heal grows the array with **null** rows — it cannot place the hero row,
because it holds a seat _number_, not a player. So the guard could never become
true, every pass produced a fresh `players` identity, the effect's dependency
array changed, and it ran again. **An infinite render loop, armed on precisely
the code path that fires when a player is stranded.** The bug was in the rescue.

Fixed by **shape, not by a smarter guard** — `reconcileHeroSeatFromEngine()` is
a pure function that returns `null` when nothing needs changing, so idempotence
becomes a property a test can pin rather than a comment asking you to trust an
inline reducer inside a 20,000-line component:

```ts
export function reconcileHeroSeatFromEngine(
  prev: HeroSeatReconcileInput, engineSeat: number, userId: string
): HeroSeatReconcilePatch | null {
  if (!userId || !Number.isInteger(engineSeat)) return null;
  if (engineSeat < 1 || engineSeat > MAX_SUPPORTED_SEATS) return null;
  if (prev.players[engineSeat - 1]?.id === userId) return null;
  const needsRows  = prev.players.length < engineSeat;
  const needsSeats = prev.maxPlayers    < engineSeat;
  const needsHero  = prev.heroSeat     <= 0;
  if (!needsRows && !needsSeats && !needsHero) return null;   // <- TERMINATES
  ...
}
export { MAX_SUPPORTED_SEATS } from './tableSeatGeometry';
```

Live minified: `function jx(n,t,s){...if(!i&&!l&&!c)return null;...}`
The regression test drives it to a fixed point, then hammers it 50 more times.

> **Generalisable lesson: an inline reducer whose early-return guard depends on
> a state it cannot itself produce will not terminate.**

#### (b) I planted a trap while fixing that (#2068, fixed in #2102)

`heroSeatReconcile` declared `MAX_SUPPORTED_SEATS = 10` "for headroom", while
`SEAT_LAYOUTS` defines rings for 2-9 and `seatLayoutFor` clamped to 9. A
ten-seat table would then have grown **ten rows of state against nine drawable
positions** — seat 10 existing in state and rendering nowhere. _That is the
exact bug this phase exists to kill, reintroduced by its own fix._ Not reachable
today (largest table is 9-max), which is why it would have lain in wait for
whoever adds a 10-max table. Now **derived**, so the two cannot drift:

```ts
export const MAX_SUPPORTED_SEATS = Object.keys(SEAT_LAYOUTS).reduce(
  (max, k) => Math.max(max, Number(k)),
  2
);
export function seatLayoutFor(maxPlayers: number) {
  return SEAT_LAYOUTS[
    Math.min(MAX_SUPPORTED_SEATS, Math.max(2, maxPlayers || MAX_SUPPORTED_SEATS))
  ];
}
```

#### (c) I clobbered 188 lines of another agent's work

See §9.1. This is the single most important operational lesson in this document.

### 2.8 Tests added in phase 1, and what breaks them

- **`tests/unit/snapshotNeverDropsASeat.law.test.ts`** — a hero in seat 7
  survives a stale `maxSeats` of 6; published `max_seats` beats the caller and
  may shrink an over-guess; **but may never drop a seat that holds a player**;
  fallback when the field is absent; array-length coherence. (8 cases)
- **`tests/unit/heroSeatReconcile.test.ts`** — **the regression test IS the
  loop**: asserts a fixed point, then 50 more iterations. Also: never trims;
  does not fight an existing seat claim; refuses garbage seats (0, -1, 1.5, NaN,
  1e9, cap+1); refuses without a user id; **and that the bound equals the
  largest drawable ring.** (8 cases)
- **`server/src/engine/SeatCountIsPublished.test.ts`** — live payload, idle
  payload, **resync payload**, and that the value comes from `tableInfo` and
  never from the roster. (4 cases)

Every one verified **red before green**: I reintroduced the defect, watched the
test fail, restored the fix, watched it pass.

---

## 3. PHASE 2 — THE SILENT-CLIENT CANARY (DONE)

### 3.1 The problem

The engine cannot see a browser. A heartbeat proves the app is running and the
network is up — **nothing** about whether the player can _see_ anything. Dan's
beats landed perfectly every five seconds throughout his ordeal. From the server
side he was indistinguishable from somebody who had walked away.

### 3.2 The fingerprint

```
connected  +  turns offered  +  never once acted, EVER, at this table
```

Somebody who plays and then wanders off has acted at least once. Somebody whose
client cannot show them the action never does. That is the whole discrimination.

### 3.3 Implementation — `server/src/engine/DisconnectEngine.ts`

- `PlayerConnectionState` gains `everActed?: boolean`, `turnsOffered?: number`,
  `lastTurnRenderedAt?: number | null`
- `recordPlayerActed()` sets `everActed = true` — **never unset while the seat
  is held**, because a player who plays and _then_ goes AFK is an ordinary AFK
- `onPlayerTurn()` increments `turnsOffered` **after** the sitting-out branch (a
  sat-out seat is auto-folded, not offered anything)
- `noteTurnRendered()` records the optional client ack

```ts
reportSuspectedSilentClient(tableId, playerId, state: PlayerConnectionState)
  : { suspected: boolean; reason: string } {
  if (!state.isConnected) return { suspected: false, reason: 'disconnected — ordinary timeout ladder' };
  if (state.everActed)    return { suspected: false, reason: 'has acted here before — ordinary AFK' };
  if ((state.turnsOffered ?? 0) < config.maxConsecutiveTimeouts)
                          return { suspected: false, reason: 'not enough turns offered to judge' };
  if (state.lastTurnRenderedAt)
                          return { suspected: false, reason: 'client confirmed it rendered the turn — AFK' };
  reportError(new Error(`[silent-client] ${detail}`), 'DisconnectEngine.SuspectedSilentClient',
              { tableId, playerId });
  EngineMetrics.metricsRegistry
    .counter('poker_suspected_silent_client_total', ...).inc(1, { table_id: tableId });
  return { suspected: true, reason: detail };
}
```

**Diagnosis only.** The sit-out and the eviction are unchanged. Letting this
alter the outcome would let a broken client hold a seat forever — worse than the
bug it reports. A test pins that the player is still sat out afterwards.

### 3.4 The optional ack

`turnRendered` rides the **existing** heartbeat rather than getting a route of
its own — the heartbeat already runs on a timer, is authenticated, and resolves
the engine.

```
TablePage heartbeat effect
  → sendHeartbeat(tableId, { turnRendered: heroActionRenderedRef.current })
  → POST /heartbeat  (server/src/handlers/heartbeat.ts)
  → engine.heartbeat(userId, { turnRendered: turnRendered === true })
  → disconnectEngine.noteTurnRendered()
```

**The flag is written by the ActionPanel's own render arm** (`TablePage.tsx`,
inside the `? (() => {` immediately after the full gate) — _not_ re-derived
beside the heartbeat. A second copy of that condition would drift, and a false
"the player can see this" silences the canary for exactly the player it exists
to catch. Cleared when the turn ends, in the time-bank effect, so a stale yes
cannot carry into a later hand. Live minified: `await rg(o,{turnRendered:un.current})`

Optional by design: old clients omit it and fall back to the weaker signal, so
they are treated exactly as every client is treated today.

### 3.5 HORSES — DO NOT ADD AN `is_horse` BRANCH

There is none, and none is needed. A horse acts through the **same
`performAction` path** as a human (HorseLogic → `scheduleHorseAction` →
`performAction` → `recordPlayerActed`), so it sets `everActed` on its first
decision and can never trip the canary. The signal is **behavioural, not an
identity test** — which is why CLAUDE.md §10.5 needs no exemption here. A horse
is measured by the same yardstick as a human and passes it for the same reason.

`SilentClientCanary.test.ts` asserts the **absence** of any `is_horse` branch
specifically so a future agent does not "fix" it by adding one:

```ts
const canary = src.slice(src.indexOf('reportSuspectedSilentClient('));
expect(canary).not.toMatch(/is_horse|isHorse/);
```

### 3.6 The phase-2 audit found the canary watching ONE DOOR OF TWO (#2135)

A player can be force-sat-out from **two** places:
`recordConnectedTimeout()` (the connected AFK ladder) **and**
`executeAutoAction(reason:'timeout')` (the disconnect countdown). I wired the
first and stopped — so it reported nothing through the second while claiming to
watch every forced sit-out. The test now splits the engine source on every
`sitOut(tableId, playerId, 'forced')` and requires the canary call in the 400
characters immediately before each, so a third sentencing path cannot be added
without one:

```ts
const parts = src.split("this.sitOut(tableId, playerId, 'forced')");
expect(parts.length).toBeGreaterThanOrEqual(3); // 2 call sites -> 3 fragments
for (let i = 0; i < parts.length - 1; i++) {
  expect(parts[i].slice(-400)).toMatch(/reportSuspectedSilentClient\(tableId, playerId, state\)/);
}
```

**PRs: #2122 (`4c35ba2880`), #2135 (`2b5da8f384`).** Test file:
`server/src/engine/SilentClientCanary.test.ts`, 9 cases.

---

## 4. PHASE 3 — DEFINER EXPOSURE (DONE)

### 4.1 Headline

**852 → 732 lints. Every `security_definer_view` ERROR cleared. One real
information-disclosure hole closed. Nothing broken** — because the money paths
were left alone _deliberately_ rather than by accident.

PR **#2159** (`e574cfda61`). Live in production as migrations
`20260831115405 a_trigger_function_is_not_an_api` and
`20260831115746 every_definer_view_respects_the_caller` (confirmed via
`list_migrations`). Repo copies:
`supabase/migrations/20260831d_a_trigger_function_is_not_an_api.sql` (212 lines)
and `20260831e_every_definer_view_respects_the_caller.sql` (76 lines).

### 4.2 A trigger function is not an API — 173 grants revoked

342 functions in `public` return `trigger`; **175 carried EXECUTE for anon
and/or authenticated**. PostgREST never exposes a function returning `trigger`,
so the grant bought nothing and only widened the surface.

**I tested the assumption that could have broken every trigger on the platform,
before touching it.** A rolled-back probe created a schema, table, trigger
function and trigger; `REVOKE ALL ... FROM PUBLIC`; `SET LOCAL ROLE
authenticated`; inserted a row — **the trigger still fired and set its column**.
Trigger _firing_ does not re-check EXECUTE. Tested, not remembered. Had that
check existed, this migration would have broken every trigger on the platform.

**Verified live after the revoke:** 163 `tables` rows stamped by their BEFORE
UPDATE trigger, and all 58 new seats stamped with `club_id` by
`fn_stamp_seat_club`.

### 4.3 THE TRAP THAT ABORTED MY FIRST RUN — remember this one

**A `REVOKE` issued by `postgres` against a grant `postgres` never made is a
silent no-op with a warning, not an error.** My loop reported success and the
post-apply assertion still found 2 functions exposed, so the whole migration
rolled back. They were `checkauthtrigger` (Supabase auth) and
`postgis_cache_bbox` (PostGIS), both owned by `supabase_admin` — platform
internals, not ours to re-permission.

**Scope every permission change to `p.proowner = 'postgres'::regrole`.** The
assertion is what caught it; that is the entire argument for writing assertions.

### 4.4 The one genuine hole

`fn_union_eco_adjustment(p_union_id, p_start, p_end)` — SECURITY DEFINER, takes
a union id **straight from the caller**, and had **no caller check of any
kind**: no `auth.uid()`, no role test. It is `stable` and writes nothing so it
could not move money, but it handed **any signed-in player another union's
economy figures**. A grep of both repos found **zero call sites**, so the door
was closed rather than fitted with a lock nobody uses. `fn_union_eco_record` was
revoked with it for the same reason.

### 4.5 Three definer views, not two

The advisor reported two; after fixing them a **third** appeared —
`v_spin_unfilled_waits`, created earlier the same morning by
`20260831060000_a_seat_that_waits_forever_gets_its_chips_back.sql`. **Naming
views one at a time loses that race by construction**: this estate gains views
faster than a migration can list them. So `20260831e` sweeps every view we own:

```sql
FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='v' AND c.relowner='postgres'::regrole
           AND coalesce(array_to_string(c.reloptions,','),'') NOT LIKE '%security_invoker=%'
LOOP EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', r.relname);
```

`v_spin_unfilled_waits` is the one that mattered: it carries three grants to
browser roles, so as a DEFINER view it read rows with the **owner's** rights on
behalf of whoever asked. House convention is `security_invoker=true` — 40+ views
already had it; these were the stragglers.

### 4.6 THE REMAINING 568 WARNINGS — DO NOT BLINDLY REVOKE

565 browser-callable definers we own. **397 establish the caller directly**
(`auth.uid()` / `auth.role()` / JWT). Of the 168 that do not, most are thin
wrappers that delegate to one that does. I read every high-risk one:

| Function                           | Verdict                                                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promote_member`                   | Takes `p_promoted_by` as a parameter (alarming) but delegates to `fn_club_set_member_role`, which sets `v_actor := auth.uid()` and trusts a supplied actor **only for `service_role`** |
| `ca_union_record_presettlement`    | Guarded by `ca_can_oversee_union`, raises 42501                                                                                                                                        |
| `fn_save_leaderboard_reward_setup` | Delegates to `fn_publish_leaderboard_reward_program`, which refuses a NULL `auth.uid()`                                                                                                |
| `increment_promotion_claim_count`  | Read-only despite the name — derives a count                                                                                                                                           |
| `recalculate_leaderboard_ranks`    | Writes unguarded, but only recomputes `dense_rank()` from existing scores, so it cannot forge a position                                                                               |

I separately verified **every money mover** checks `auth.uid()`:
`fn_mint_club_chips`, `fn_mint_chips_from_diamonds`, `atomic_chip_transfer`,
`atomic_table_buyin`, `send_wallet_diamond_transfer`, `transfer_club_ownership`,
`fn_wallet_type_transfer`, `fn_apply_credit_payment`, `ca_promo_vault_grant`,
`fn_member_leave_to_treasury`, `fn_resolve_dispute`.

**The doors are exposed and each carries its own lock.** Revoking a live RPC
entry point to satisfy a lint would break the product to fix a warning. The app
calls **564 distinct RPC names**, so the exposed set is largely the legitimate API.

Remaining ERROR: `spatial_ref_sys` without RLS — a PostGIS extension table owned
by `supabase_admin` holding public spatial-reference constants. Not ours, no user
data. The 22 remaining anon-callable definers are deliberate pre-login lookups
(`check_username_available`, `fn_club_name_available`, `find_live_games_nearby`).

### 4.7 The migration pattern that worked — copy this shape

Both migrations follow `supabase/migrations/.template.sql`: pre-flight
assertions, the change, then **post-apply assertions that prove BOTH halves** —
that what we meant to close is closed **and that a known-good money RPC is still
callable** — so a hardening migration cannot quietly break a money path. Plus a
pasted ROLLBACK section, required for Tier 3.

---

## 5. PHASE 4 — RECONCILIATION · **THE PREMISE HAS MOVED. RE-SCOPE FIRST.**

### 5.1 What I originally found and reported to Dan

`ledger_reconcile_log`: **57,730 rows across 98 runs, 21,271 critical
all-time**. The 2026-08-30 run produced **1,053 criticals across 322 entities**.
I characterised this to Dan as _"an alarm that fires a thousand times a night
cannot detect a real theft."_

### 5.2 **That characterisation was wrong and you must not inherit it**

Criticals per run are **bursty, not nightly**:

| Run date       | Criticals | Composition                                                                                                         |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| 2026-08-25     | 575       | `player_wallet` — 48,806,205 drift                                                                                  |
| 2026-08-26     | 575       | `player_wallet` — identical 48,806,205, then GONE                                                                   |
| 2026-08-27     | 4         | `club_treasury` 110,378 · `negative_balance` · `seat_stack_exit` (1 row)                                            |
| 2026-08-28     | 3         | `club_treasury` 5,159,494 · `negative_balance`                                                                      |
| 2026-08-29     | 5         | `club_treasury` 12,482,462 · `bomb_award` · `negative_balance`                                                      |
| 2026-08-30     | 1053      | `seat_stack_exit` 1,033 rows / 431,906 chips · `bomb_award_ledger_gap` 17 rows / 1,418 · `club_treasury` 30,531,027 |
| **2026-08-31** | **0**     | see below                                                                                                           |

Two real signals were hiding inside that noise:

**(a) `club_treasury` drift appeared in EVERY run and was GROWING:**
110,378 → 5,159,494 → 12,482,462 → **30,531,027**. Roughly tripling daily. A
trend, not noise.

**(b) `seat_stack_exit` spiked to 1,033 rows on 08-30** having been 1 the day
before — a discrete event, not a baseline.

### 5.3 **ANOTHER AGENT FIXED (a) WHILE I WAS IN PHASE 3**

The **2026-08-31 run at 11:20:59 UTC** shows:

```
club_treasury         severity=ok    drift=0      (2 entities)
frozen_wallets_pool   severity=ok    drift=0
insurance_bank        severity=ok    drift=0
chip_circulation      severity=ok    (3 rows, 160,741,716 — informational total)
CRITICALS: 0
```

The cause is almost certainly **PR #2115 — "fix(ledger): the treasury had no
ledger, and a trigger was inventing one"**, merged today. Note also that
reconciliation has been **EXPANDED** today: `frozen_wallets_pool`,
`insurance_bank` and `chip_circulation` are new entity types in that run.
`fn_unaccounted_seat_exits()` returned **0** when I checked at 12:00 UTC.

A great deal of other money work landed today from other agents and is worth
skimming before you touch anything: **#2038** (a seat never ends by DELETE),
**#2047** (prize-disbursement audit reads the ledger), **#2059** (restart-orphaned
cash rake heals itself), **#2071** (spin reconciliation views were readable by
anyone on the internet), **#2112**, **#2161**.

### 5.4 What Phase 4 should therefore actually be

**STEP 1 — VERIFY, DO NOT REBUILD.** Run these first:

```sql
select run_date::text, severity, entity_type, count(*),
       round(sum(abs(drift))) as abs_drift, max(run_ts)::text
from ledger_reconcile_log
where run_date >= current_date - 5
group by 1,2,3 order by 1 desc, 4 desc;

select count(*) from fn_unaccounted_seat_exits();   -- was 0 at 12:00 UTC today
select * from fn_club_chip_circulation();
```

If `club_treasury` is still `ok`/0 across several runs, **(a) is genuinely
fixed** and Phase 4 shrinks to the residue.

**STEP 2 — the remaining questions:**

- Was the 08-30 `seat_stack_exit` burst (**1,033 rows / 431,906 chips**) ever
  explained? `fn_unaccounted_seat_exits()` returns 0 now, so it either resolved
  or was reclassified. **Find out which.** 431,906 chips is not nothing.
- `bomb_award_ledger_gap` — 17 rows / 1,418 chips on 08-30. Same question.
- `negative_balance` appeared on 27/28/29 (1 row each, 1,203-7,161 chips) and
  not since. Confirm it is closed rather than merely quiet.
- **The structural issue remains worth checking:** money paths that write
  `club_members.chip_balance` **directly** without touching `chip_ledger`.
  CLAUDE.md §11.5 names `atomic_table_buyin` as one. If any remain,
  reconciliation is still blind to them by construction.
- For scale: `fn_club_chip_circulation()` covers pools reconciliation had never
  looked at before 08-25 — at that time 121,417,782 chips in member wallets and
  1,139,873 on the felt.

**STEP 3 — the durable improvement:** make the alarm _believable_. Either
complete `chip_ledger` coverage so every money path writes it, or scope
`reconcile_ledger_nightly` to the paths it genuinely observes and stop rating
un-instrumented ones "critical". The second is smaller and pays immediately; the
first is correct long-term. Say which you chose and why.

### 5.5 HARD SAFETY RULES FOR THIS PHASE

**CLAUDE.md §11.5 — NEVER SPEND REAL CHIPS TO TEST A RULE.** On 2026-08-25 an
agent verified an `atomic_table_buyin` guard by calling it against production;
two buy-ins succeeded (8.00 and 40.00), the cleanup DELETED the seat rows, and
**48 chips left a member wallet and landed nowhere**. Returned by migration
`20260825_return_agent_probe_chips_to_treasury_v2`.

1. Probe money functions **inside a transaction you ROLL BACK**
   (`scripts/dev/probe-rpc.sql` is the pattern).
2. What you want from a probe is the **error message** — `GET STACKED
DIAGNOSTICS` survives a rollback; the side effects are the part nobody wants.
3. **Never DELETE a `table_seats` row.** It skips the refund and destroys chips.
4. Helper functions go in **`pg_temp`, never `public`** (that incident left
   three `zz_probe*` functions needing a second migration to drop).
5. If you cannot probe without committing, **do not probe** — assert the logic
   in a unit test and say plainly in the PR that the live path was reasoned
   about rather than executed.

**Refund paths differ by seat type** (CLAUDE.md §11.5):

| Seat type            | Refund path                                              | Settles into                                 |
| -------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Tournament           | `fn_leave_seat_and_refund(table_id)`                     | `fn_add_chips` → `club_members.chip_balance` |
| Cash, explicit leave | Hetzner engine cash-out                                  | `club_members.chip_balance`                  |
| Cash, tab close      | `player_leave_table(table_id, user_id)` via `sendBeacon` | `club_members.chip_balance`                  |

**`fn_leave_seat_and_refund` is TOURNAMENT-ONLY.** Called on a cash table it
returns `{"ok":false,"reason":"table_not_found"}`, refunds nothing, and leaves
the seat where it was. `public.wallets` is **not** the live chip pool — frozen
since 2026-08-21 with 732,591,994.33 chips stranded in it. Nothing reads it. A
money path writing to it is a broken money path.

Something does catch a silent chip loss now: migration
`20260825_chips_cannot_leave_the_felt_unnoticed` puts a `BEFORE DELETE OR UPDATE
OF left_at` trigger on `table_seats` that appends every non-zero-stack exit to
`ca_seat_stack_exits` with the DB role and application name that did it. It
never blocks — a guard that can refuse a seat exit can strand a player mid-hand
— so it makes the failure LOUD, not impossible.

---

## 6. PHASE 5 — PIPELINE AND QUEUE HEALTH (RECOMMEND DOING FIRST)

This is now the single thing standing between "merged with green checks" and
"provably live" for every phase. Every finding below is **measured**, not inferred.

### 6.1 The CA → World Hub publish starves

- **16 of 20 sync runs cancelled** in one observed window.
- `main` ran **11 commits ahead** of the last successful sync; at 12:22 UTC the
  published bundle was **16 commits behind** `main`.
- `.github/workflows/build-for-world-hub.yml:41` sets `cancel-in-progress:
false` **deliberately** (it was `true` and deadlocked publishing on
  2026-08-21) — but GitHub still cancels the **pending** run when a newer one
  queues, so on a busy day only the `*/20` catch-up cron ever lands a publish.

### 6.2 A red `main` stops ALL publishing, platform-wide

The sync's gate is literally **"Client tests must pass before the bundle
ships"** (`build-for-world-hub.yml:137`, `npx vitest run tests/`).

On 2026-08-31, **PR #2054** renamed `withTable` → `withJoinableTable` and made
it stricter, but did not move the two test pins that guard it — a direct
violation of house rule 8 ("if you deliberately replace behaviour a test pins,
UPDATE THAT TEST IN THE SAME COMMIT"). Result: **nothing published anywhere for
~40 minutes**, and my phase 1 sat unpublished behind it. I fixed the pins in
#2068; another agent fixed them in parallel and **on conflict I took theirs**,
which was stricter (it also asserts `isJoinableTableRow`).

**This will happen again.** A CI check that fails a PR when it renames a symbol
that still appears inside a `toMatch(/.../)` pin would prevent the whole class.

### 6.3 The engine deploy drain gate never sees zero

`.github/workflows/auto-deploy-hetzner.yml`:

- **L98** `cancel-in-progress: false`
- **L146** `MIN_RESTART_SPACING_SEC=1200` (20 min)
- **L379** `MAX_ENGINE_AGE_SEC=2700  # 45 minutes`

The gate waits for `handsInFlightTotal` to reach **0**. On a 53-table fleet it
sits at **83-101 permanently**. The workflow's own comments admit it: the
45-minute staleness cap _"is not a rare backstop — it is the ONLY way a deploy
ever lands."_ **So the engine runs code up to 45 minutes old by design**, and a
deploy arriving inside the 20-minute spacing window reports success without
recycling the container at all. I watched this consume ~50 minutes waiting for
phase 2's canary to go live.

`workflow_dispatch` exists on this workflow (inputs `force` and `ref_sha`) and
is the manual lever — but a concurrent push will cancel your dispatch.

### 6.4 The rest of phase 5

- **20 open PRs, all BLOCKED/UNKNOWN with auto-merge armed** — issue **#375**
  already names the pattern.
- **The GitHub token lacks `checks:read`.** `gh api .../check-runs` 403s, which
  is _why_ nobody can see which check is blocking a PR. **Cheapest fix on the
  entire list and it unblocks diagnosing the item above.**
- **The token exhausts its rate limit** under this much polling (I hit 403s
  repeatedly). Fall back to `curl` on `build-info.json` and `/health` — neither
  needs the API.
- **Post-Deploy E2E (production) is red and blocks nothing.** club-lobby specs
  time out with _"Target page, context or browser has been closed"_. PR #2036
  attempts it. A gate nobody must satisfy is decoration.

---

## 7. EVERYTHING ELSE I FOUND AND DID NOT ACTION

| Item                                                                       | Where        | Note                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Global footer broken in production                                         | WH **#1064** | Filed today                                                                                                                                  |
| Six VIP entitlement defects behind the benefits page                       | WH **#771**  | Open since 08-27                                                                                                                             |
| Solver v2 stalled since 2026-08-15, **6.6M spots** outstanding             | WH **#820**  |                                                                                                                                              |
| Eight CA flows push to OneSignal, removed 2026-08-19, delivering nothing   | CA **#1498** |                                                                                                                                              |
| Definer exposure (the class)                                               | CA **#1634** | Partly addressed by phase 3; the remaining 568 are analysed in §4.6                                                                          |
| Vestigial `club-arena` Vercel project                                      | CA **#997**  |                                                                                                                                              |
| **An `ANTHROPIC_API_KEY` is visible in a plain `ps` listing on Dan's Mac** | —            | Any local process can read it. I did not record or use it. Worth rotating and passing via a file rather than an env var on the command line. |
| 135 `rls_enabled_no_policy` INFO lints                                     | Supabase     | RLS on with no policies = deny-all, i.e. fail-closed. Low priority.                                                                          |

**Surfaces I did NOT audit at all** — treat as unknown rather than clean: the
Sentry/runtime error stream; horse fleet health and table liveness; tournament
payout correctness end to end; whether all 85 Open Claw dispatcher jobs are
firing; the World Hub training/solver side beyond its issue list; mobile layout.

---

## 8. EXACT LIVE STATE, AND HOW TO VERIFY WITHOUT THE GITHUB API

Verified **2026-08-31 12:23 UTC**:

```
origin/main          cde74ee3f3
client (published)   dbddd0859d      (16 commits behind main — §6.1)
engine (Hetzner)     86c11e19        uptime 17s   handsInFlightTotal 0
```

**All phase 1-3 work is published and verified live.** Not by merge status — by
pulling the served, minified bundle and grepping for the compiled code:

| What                   | Live minified proof                                                              |
| ---------------------- | -------------------------------------------------------------------------------- |
| Mapper seat resolution | `c=Number(i.max_seats??0),u=Number.isFinite(c)&&c>0?Math.max(c,l):Math.max(s,l)` |
| Resync path grows      | `maxPlayers:Math.max(Number(M.max_seats)\|\|0,L.length)\|\|D.maxPlayers`         |
| The loop fix           | `function jx(n,t,s){...if(!i&&!l&&!c)return null;...}`                           |
| The turn-rendered ack  | `await rg(o,{turnRendered:un.current})`                                          |

### Commands

```bash
# what the browser is actually served
curl -s https://smarter.poker/hub/club-arena/build-info.json     # -> ca_sha

# engine version / uptime / hands in flight
curl -s https://engine.smarter.poker/health
#   WARNING: /health is an EXACT-match route (router.ts: url === '/health').
#   Adding ?cachebuster=... returns 404. Use headers to bust cache instead.

# is <sha> live?
cd ~/Documents/club-arena
LIVE=$(curl -s https://smarter.poker/hub/club-arena/build-info.json \
        | sed -n 's/.*"ca_sha": "\([a-f0-9]*\)".*/\1/p')
git merge-base --is-ancestor <your-sha> $LIVE && echo PUBLISHED || echo pending

# find the served chunk so you can grep it. Chunk names skew across deploys —
# take it from the WH commit whose build-info matches $LIVE, not from live HTML.
cd ~/Documents/Smarter-Poker-World-Hub && git fetch origin -q
C=$(git log --format='%H %s' -20 origin/main -- public/hub/club-arena/build-info.json \
     | grep $LIVE | head -1 | cut -d' ' -f1)
git ls-tree $C --name-only public/hub/club-arena/assets/ | grep -E "/TablePage-.*\.js$"
```

---

## 9. OPERATING RULES FOR THIS ESTATE (each cost me time today)

### 9.1 NEVER edit the shared clone and copy files into a worktree

`~/Documents/club-arena` is reset by an Antigravity `git reset --hard
origin/main` loop and is **frequently BEHIND `origin/main`**. I copied whole
files from it into a worktree and **silently deleted 188 lines of another
agent's newer work** in `TablePage.tsx`. The full client suite caught it as a
failing pineapple-discard spec; I proved it was mine (that spec passes on clean
`main`), restored both files with `git checkout origin/main -- <files>`, and
re-applied only my own hunks with a Python script. `+88 −188` became `+56 −1`.

**The check that catches it: `git diff --numstat`.** An additive change shows
`+N −0` or `+N −1`. If you see `−188`, you are destroying somebody's work.

The clone also gets reset **mid-session**: at one point my edit landed in a file
that no longer contained the method I was calling. Re-verify a file's state
against `origin/main` before and after editing it.

### 9.2 Worktree workflow that works

```bash
cd ~/Documents/club-arena && git fetch origin -q
git worktree add ~/Documents/.agent-trees/club-arena/<name> \
  -b agent/<you>/<slug> origin/main
W=~/Documents/.agent-trees/club-arena/<name>
cp -c -R ~/Documents/club-arena/node_modules        $W/node_modules          # APFS clone
cp -c -R ~/Documents/club-arena/server/node_modules $W/server/node_modules
cd $W && git push -u origin HEAD      # plain `git push` FAILS in a worktree
```

Four mounted worktrees already hold other agents' live work
(`cowork-claude-table`, `cowork-claude-tourneys`, `claude-compliance`,
`cowork-claude-wallets`) — **do not reuse them.**

`main` is protected by ruleset **21163380**, `enforcement: active`,
`bypass_actors: []`. Required checks: TypeScript Check · Client Unit Tests
(vitest) · Server Engine (typecheck + tests) · Production Build · CSS Beat E2E ·
Silent Revert Guard. Branch → PR → autopilot squash-merges (`agent-autopilot.yml`,
every 10 minutes). Direct pushes to `main` are refused.

### 9.3 Shell and CI mechanics

- The host terminal tool **times out around 120s**. Keep `sleep` under ~110s and
  poll rather than blocking.
- **Long test runs die with the shell connection.** Launch detached:
  ```bash
  nohup bash -c 'npx vitest run tests/ > /tmp/x.log 2>&1; echo "EXIT=$?" >> /tmp/x.log' \
    >/dev/null 2>&1 & disown
  ```
  then poll `/tmp/x.log`.
- `npm run build` locally is slow (installs sharp). CI's "Production Build" is a
  required check and catches it anyway.
- Expected suite sizes: **client ~718 files / ~10,086 tests**; **server ~271
  files / ~3,081 tests**. Both should be 0 failures.
- The pre-push hook runs house guards (`check-required-columns`,
  `check-definer-authorization`, `check-title-case`, `check-ui-text`, …). **Do
  not `--no-verify`.**
- A stray non-ASCII character will be caught by the guards. One slipped into a
  TablePage comment during this session and I removed it immediately.

### 9.4 GateGuard

Before each Edit/Write it demands: importers of the file, affected public
functions, data files touched, and the user's verbatim instruction. Answer it
and retry the same call. It is not a bug.

### 9.5 Engineering standards this session held to

- **Test the assumption that could break production, in a rolled-back
  transaction, before relying on it.** The trigger/EXECUTE probe is the model.
- **Prove every new test is real:** break the code, watch it go red, restore it,
  watch it go green. Done for the loop pin, the seat-bound pin, the both-doors
  pin and the canary pins.
- **Assertions in a migration must prove BOTH halves:** the thing you meant to
  change changed, _and_ the thing you promised not to break still works.
- Write the _why_ into the code, not the chat. Every fix in this session carries
  a comment naming the incident it prevents.

---

## 10. YOUR FIRST HOUR

1. **Re-verify §8.** Everything there will have moved.
2. **Is `main` green?** A red `main` blocks publishing platform-wide and fixing
   it comes before your own work (CLAUDE.md §4). Make a worktree off
   `origin/main` and run `npx vitest run tests/`.
3. **Re-scope phase 4 before building anything** — run the queries in §5.4 Step
   1. If `club_treasury` is still `ok`/0 across several runs, PR #2115 solved
      the headline and your job is the residue: the 08-30 `seat_stack_exit` burst
      (1,033 rows / 431,906 chips), `bomb_award_ledger_gap`, and any money path
      still writing balances without touching `chip_ledger`.
4. **Consider telling Dan you recommend phase 5 first.** I do, and I told him
   so. It gates proof for everything that follows, and its cheapest item — the
   `checks:read` token scope — is minutes of work that makes 20 stuck PRs
   diagnosable.
5. Report in Dan's format (§1). Audit the previous phase before starting the
   next: it has found a defect every single time, including two of mine.

---

_Written by cowork-claude, 2026-08-31. Every number in this document was
measured, not estimated. Where I could not verify something, it says so._
