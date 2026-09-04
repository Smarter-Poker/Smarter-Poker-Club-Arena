# MILITARY GRADE HANDOFF — Operation Table Stakes, Gate 4 (Gates 0-3 shipped)

**Written 2026-09-04 20:00 UTC by the agent that shipped Gates 0-2; updated 2026-09-05 (Gate 3 shipped, PR #3008). Read this
file first, then `docs/OPORD-1.4-AMENDMENT.md`, then `CLAUDE.md`. Everything
below is verified against production or against the repo on the date shown; a
sentence with no evidence behind it is marked UNVERIFIED.**

---

## 1. WHERE YOU ARE

Operation Table Stakes converts every cash game on the platform from "a host
configures a table" to "a host creates a GAME and the platform runs its
tables". The order of work is Gates 0-7. **Gates 0, 1 and 2 are done, live in
production, and published. You are starting Gate 3.**

| Gate | Slice                                                  | State                                                                           |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 0    | Recon                                                  | DONE, recorded in OPORD 1.4 section 0                                           |
| 1    | Slice 0 — chip continuity                              | **LIVE** (PR #2959, merged 12:37 UTC, engine deployed, verified on real tables) |
| 2    | Slice 1 — a host creates a GAME                        | **LIVE** (PR #2990, merged 19:17 UTC, published)                                |
| 2.5  | Slice 1 hardening + R9 + cards                         | **LIVE** (PR #2999, merged 20:40 UTC)                                           |
| 3    | Slice 2 cluster runtime + Slice 6 autonomous lifecycle | **PR #3008** (pushed 22:35 UTC; both migrations already applied to prod)        |
| 4    | One lobby card per game + the cluster waitlist client  | **YOURS** (component built, `cash_game_waitlist` table exists, neither is fed)  |
| 5    | Rules engine                                           | Not started                                                                     |
| 6    | Chrome                                                 | Not started                                                                     |
| 7    | Cutover                                                | Not started                                                                     |

### The first thing you do

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/3008 \
  | python3 -c "import sys,json;p=json.load(sys.stdin);print(p['state'],p['merged'])"
```

If it is merged, start. If it is open and red, read the check and fix it
forward — **its migration is ALREADY APPLIED to production**, so the branch is
the record catching up with the database, not the other way round. Do not
revert it; a revert would leave prod ahead of the repo.

---

## 2. WHAT IS LIVE RIGHT NOW (do not rebuild it)

### 2.1 Slice 0 — chip continuity (LIVE since 13:00 UTC)

A player cannot take chips off a seat, and cannot leave while ahead until a
stay clock expires. Objects:

- `cash_player_session` — baseline, `stay_clock_ms`, `rejoin_window_ms`,
  `stay_remaining_ms`, `stay_running`, `stay_last_tick_at`.
- `cash_rejoin_constraints` — key (player, club, variant, sb, bb); the floor
  a player must re-buy at after leaving ahead.
- `atomic_seat_cashout_locked(user, table, seat, leave_mode)` — 'voluntary'
  is enforced for the engine; the admin kick sets the transaction-local GUC
  `app.cash_exit_authority='club_admin'` (R7: a kick is a SYSTEM exit).
- `fn_cash_session_open/close/add_baseline`, `fn_cash_session_evaluate`,
  `fn_cash_leave_check`, `fn_cash_rejoin_floor`, `fn_cash_effective_buyin`.
- Errors the client knows: `BUYIN_BELOW_FLOOR`, `BUYIN_ABOVE_MAX`,
  `LEAVE_LOCKED:<ms>`.
- Engine: `server/src/engine/ChipContinuity.ts`,
  `services/supabase/cashSessions.ts`, `leaveTable(userId, {forced?})`
  returns `{success,error,immediate,code,stay_remaining_ms}`.
- Client: `src/lib/chipContinuity.ts` (`leaveAvailableLabel` → "Leave
  Available In M:SS"), floor re-read when the buy-in modal opens.
- `atomic_table_withdraw` is DROPPED. There is no partial cash-out anywhere.

Changelog: `docs/changelog/2026-09-04-chip-continuity-slice-0.md`.

### 2.2 Slice 1 — a host creates a GAME (LIVE since 19:17 UTC)

- `public.cash_games` — THE CLUSTER ROW. Columns: id, club_id, union_id,
  name, template_name (classic|action|madness), variant (the nine the engine
  deals), sb, bb, handedness, `ruleset_snapshot jsonb`, enabled, state
  (live|dormant), cap_mains 8, allow_second_feeder, created_by, timestamps,
  **must_move**, closed_at, closed_by.
- `public.tables` gained `cluster_id` (FK cash_games), `role` (main|feeder),
  `main_index`, `lifecycle` (opening|live|breaking|closed).
- `fn_cash_template_defaults(template, variant)` — the section 8 defaults.
- `fn_cash_game_create(club, template, variant, sb, bb, handedness,
overrides, name, must_move)` — **9 arguments**; the 8-arg version is
  dropped. It creates the game AND its Main 1 `tables` row.
- `fn_cash_stakes_label(sb, bb, variant)` — 3 args; bet sizes for flh/flo8.
- `fn_cash_money_text`, `fn_cash_override_int`, `fn_cash_override_bool`.
- `fn_cash_session_open` re-created: a session inherits the game's clocks
  from the snapshot (raise only; floors 10 min / 120 min stand).
- `fn_close_managed_game` re-created: closing Main 1 disables its game.
- `fn_table_lifecycle_pass` re-created: it does not reopen a disabled game's
  table.
- Client: `src/components/cash/CashGameCreateFlow.tsx` (7 steps),
  `src/config/cashGames.ts`, `src/components/table-config/controls.tsx`,
  `src/components/cash/CashGameCard.tsx` + `.css` +
  `public/images/cash-cards/{classic,action,madness}.webp`.
- `TableConfigPage`'s Regular tab renders the flow. **`buildTableData` is
  gone; no browser code inserts a cash `tables` row.**

Changelogs: `docs/changelog/2026-09-04-cash-games-slice-1.md` and
`...-slice-1-hardening.md`.

### 2.3 Migrations on production (all recorded in `supabase_migrations.schema_migrations`)

| version        | name                              | applied                                      |
| -------------- | --------------------------------- | -------------------------------------------- |
| 20260904120000 | chip_continuity_slice_0           | 11:38 UTC                                    |
| 20260904140000 | chip_continuity_slice_0_hardening | 12:10 UTC                                    |
| 20260904160500 | cash_games_slice_1                | 18:45 UTC (see the warning in its changelog) |
| 20260904230000 | cash_games_slice_1_hardening      | 19:16 UTC                                    |
| 20260905010000 | cluster_columns_slice_2           | 21:47 UTC (three lock-timed transactions)    |
| 20260905010500 | cluster_controller_slice_2        | 22:20 UTC                                    |

---

## 3. THE RULINGS (binding; do not re-litigate)

R1-R5 are in OPORD 1.4 section 1. R6-R8 were made at Gate 1, R9 by Dan at
Gate 2. The ones that will bite you at Gate 3:

- **R1** PLO family is locked at 6 seats. The seat law in
  `src/config/tableSeating.ts` still says plo5=7 / plo4,plo8=8 for the rest
  of the platform; the CREATE path enforces 6. Changing the global seat law
  is the Slice 6 cutover, not now.
- **R2** No straddles on any cash game. `fn_cash_game_create` writes all
  three straddle columns false.
- **R3** Main 1 is ALWAYS ON for a must-move game. Since Gate 3 the
  controller is the keep-alive (RECONCILE reopens a closed Main 1 every
  tick); the two row flags are false on every cluster table. Do not put
  them back.
- **R4** money is `numeric` chips, never `_cents`.
- **R5** repo variant names: `plo8`, `short_deck`, `flo8`, never `plo8o`.
- **R6** a leave refused at settlement is HELD by the clock and released at
  zero; the engine never answers before the DB rules.
- **R7** an admin kick is a system exit.
- **R8** sit-out eviction stays a system exit with the floor written.
- **R9 (NEW, Dan 2026-09-04)** a game has a TABLE MODE:
  `must_move=true` is the cluster (one per stakes per club, Main 1 always on,
  feeders self-managing); `must_move=false` is one table the host runs by
  hand (closes when it empties, any number at one key, never grows).
  **Your controller must only manage `must_move = true` games.** A manual
  game's table is nobody's business but the host's.

---

## 4. GATE 3 — SHIPPED (PR #3008). READ THE CHANGELOG, THEN THIS

`docs/changelog/2026-09-05-cluster-controller-slice-2.md` is the record.
The short form: `server/src/cluster/ClusterController.ts` ticks every 5 s
on the leader; `fn_cash_cluster_tick(game, eligible_horses)` locks the
`cash_games` row and does RECONCILE / MUST-MOVE / OPEN / PROMOTE / BREAK /
ROLES / WAKE-SLEEP from rows; `fn_cash_seat_move_execute` moves a chair
with its chips and its chip-continuity session in one transaction (no
wallet); the engine announces a move at hand start (`seat_move_pending`,
"Seat Open On Main 2. Moving After This Hand.") and executes it at hand end
and on the idle tick (`seat_moved`); `TablePage` follows the hero. Probe:
`scripts/dev/probe-cluster-controller.sql`, 23/23.

### Verify it LIVE before Gate 4 (nobody has yet - do this first)

There were ZERO `cash_games` rows on production when Gate 3 was pushed, so
the controller has had nothing to tick. After the engine deploys (the :55
break after #3008 merges):

1. As the owner, create ONE must-move game through the New Cash Game flow
   (Midway Union, an unusual key such as NLH 3/6 6-max so it collides with
   nothing). Or in psql with the owner's JWT claims set, exactly as the
   probes do.
2. Within 10 s: `SELECT kind, payload, at FROM cash_cluster_events ORDER BY
at DESC LIMIT 20` should show `main_opened` and `game_woken` or
   `game_dormant`; `cash_games.last_tick_at` should be moving.
3. The fleet seeds Main 1 (horses are buyers). When Main 1 fills and the
   fleet still has eligible horses: `feeder_opened`, then `feeder_live`.
4. Cash a horse out of Main 1 (or wait for one to leave): `move_planned`,
   then `seat_moved` at the next hand boundary, and the felt total across
   the cluster unchanged. The engine log says `[ClusterController] <game>
[...]` and `[ServerTableEngine:<from>] <player> moved to <to> seat N`.
5. If any of that does NOT happen, the most likely causes in order: the
   engine is not on #3008 yet (`/health` version); the game is
   `must_move=false`; `fn_cash_clusters_to_tick()` returns nothing (check
   `enabled`); the controller threw (Sentry `ClusterController.*`).

### Gate 3 leftovers (small, named, not blocking Gate 4)

| Item  | What                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A6.11 | `HorseSessionRotator` still sheds a horse from a cluster table regardless of the balance floor. One rule to add (18.3, last para).                                                             |
| 18.3  | The break window is 5 minutes only; "2 completed orbits" needs an orbit counter the engine does not persist.                                                                                   |
| 18.4  | `eligibleHorseCount` is the fleet's last-cycle count (30 s stale at worst).                                                                                                                    |
| H12   | `src/services/HorseOrchestrator.ts` browser-side table insert is dead code (zero callers); retire at the Gate 7 cutover.                                                                       |
| H13   | A union operator who is not a club member: Start wakes no engine (`authorizeTableViewer`). The controller now wakes Main 1 at the first seat, so this only delays the dealer to the first sit. |

## 4b. GATE 4 — WHAT YOU ARE BUILDING

OPORD 1.3 section 12 / OPORD 1.4 s2: ONE lobby card per GAME, never per
table. Everything the card needs exists:

- `CashGameCard` (`src/components/cash/CashGameCard.tsx`) paints Dan's
  artwork with dynamic stakes, variant, RUNNING/WAITING/DORMANT, MUST
  MOVE/MANUAL, TYPE/STAKES/PLAYERS/TABLES and the rules strip. It is
  rendered today only as the preview inside the create flow.
- Data: `cash_games` (name, template_name, variant, sb, bb, handedness,
  ruleset_snapshot, state, must_move, enabled) joined to `tables WHERE
cluster_id = game.id AND lifecycle <> 'closed'` for PLAYERS (sum of live
  seats) and TABLES (count). `status`: `state='dormant'` -> DORMANT; any
  table `status='running'` -> RUNNING; else WAITING. `rulesLineFor(snapshot)`
  gives the strip. Write ONE RPC, `fn_cash_games_board(club_id)`, that
  returns all of it in one round trip (the lobby already avoids N+1), and
  subscribe to `cash_cluster_events` (or poll `last_tick_at`) for liveness.
- Where: `src/pages/ClubHomePage.tsx` builds `lobbyEntries` (~line 3604)
  and renders `GameLobbyPanel`. A cash-games board goes ABOVE the table
  list; the cluster's individual `tables` rows must then be HIDDEN from the
  per-table list (filter `cluster_id IS NOT NULL` out of the cash entries)
  or the game shows twice.
- JOIN GAME: seat the player through section 9.4 auto-seat - shortest live
  Main with an unreserved open seat first, then the feeder; if none, insert
  a `cash_game_waitlist` row (`status='waiting'`) and show "Next table
  opens when one more player sits" while `cash_games.opening_hold_since` is
  set. A waitlist row is a BUYER for the open rule; the controller counts it
  already. Seating itself stays `atomic_table_buyin` from the browser (the
  only browser money door) - pick the table and seat, then call it.
- VIEW GAME: a game page listing its tables (role, main_index, seated) with
  the same card at the top. Route it under the club.
- Must-move UX (section 9.5) is already in `TablePage`; nothing to build.
- Tests: a law test that the lobby renders one card per game and none for
  a cluster's tables; a render test for the board RPC mapping; the
  `orphanModuleRatchet` baseline drops by one when `CashGameCard` gets a
  second importer (leave it, it is a ratchet, not a target).

## 5. HOW TO WORK HERE (the environment, exactly)

**You are on Dan's Mac in Cowork. `mcp__counselors__host_terminal` is your
shell.** CLAUDE.md section 11.0 is the rule; these are the details that cost
me time:

- **node is not on the default PATH:**
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`
- **psql is not either:** `export PATH="/opt/homebrew/bin:$PATH"`.
- **host_terminal calls die at ~60 s** ("Connection closed"). Launch anything
  slow as `(nohup cmd > /tmp/x.log 2>&1 < /dev/null &)` and poll the log.
  `setsid` and `timeout` are NOT installed. `gh` is NOT installed — use
  `curl` with `GITHUB_TOKEN` from `~/Documents/club-arena/.env`.
- **The sandbox shell (`mcp__workspace__bash`) ran out of disk** at 19:05 and
  never recovered. Assume it is unavailable; use host_terminal for reads too.
- **Worktree:** `~/Documents/club-arena/.cowork-trees/claude-tablestakes`,
  branch `fix/cash-games-slice-1-hardening`. Claim your OWN worktree
  (AGENT-PLAYBOOK) rather than reusing mine.
- **Never rebase main** (CLAUDE.md 12). `git merge origin/main`.
- **Push, then stop.** `agent-open-pr.yml` opens the PR, autopilot merges on
  green, `publish-club-arena.yml` publishes. Check once at the end; never sit
  in a loop (CLAUDE.md 10.8.3).
- **Verify a publish by reading:**
  `curl -s https://smarter.poker/hub/club-arena/build-info.json` — `ca_sha`
  must equal the squash commit on main.

### Production psql

```bash
cd ~/Documents/club-arena && set -a && source .env && set +a
export PATH="/opt/homebrew/bin:$PATH"
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -h db.kuklfnapbkmacvwxktbh.supabase.co \
  -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -f file.sql
```

The poolers reject this login; the direct host works. Record every applied
migration by hand:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)
VALUES ('<version>', '<name>', ARRAY[$q$<body without BEGIN/COMMIT>$q$], 'claude-cowork');
```

### The probe pattern (CLAUDE.md 11.5 — BINDING)

`scripts/dev/probe-cash-games.sql` is the working example: ONE `DO $probe$`
block that `EXECUTE`s the migration body (`$mig$`-quoted, BEGIN/COMMIT
stripped), runs every scenario, and `RAISE`s the report so the whole thing
rolls back. Browser simulation inside it:

```sql
INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (sid, uid, now(), now());
PERFORM set_config('request.jwt.claims',
  json_build_object('sub',uid,'role','authenticated','session_id',sid)::text, true);
EXECUTE 'SET LOCAL ROLE authenticated';
```

**Traps I paid for:**

- The generator substituted `__MIGRATION__` into the probe's HEADER COMMENT
  as well as the DO block, which put the whole migration at top level where
  `psql -f` ran it in AUTOCOMMIT. That is how `20260904160500` reached
  production twenty statements at a time. The header no longer contains the
  token; **substitute only inside the DO block and refuse if the token
  appears more than once.**
- `fn_close_managed_game`, `fn_table_lifecycle_pass` and
  `managed_game_contract_versions` are **service_role only**. Inside a probe
  running `SET LOCAL ROLE authenticated`, `RESET ROLE` around those calls.
- Never call `fn_thaw_platform` in a probe — it deadlocked against live
  tournament rows.
- The pre-push hook's `check-definer-authorization` reads the FILE, not the
  catalogue: any `CREATE OR REPLACE` of a SECURITY DEFINER writer must
  re-state its REVOKE/GRANT in the same migration even when the ACL is
  already correct in production. It blocked me twice.
- Test accounts I used: owner `47965354-0e56-43ef-931c-ddaab82af765`, club
  `fade0000-0000-0000-0000-000000000001`, a member without create rights
  `2a8c045e-cc0d-404f-896b-7e441a3c495a`. An "outsider" must be picked
  dynamically — that member IS in the club. A member's wallet resolves for
  a Midway Union table only if they also belong to a club IN the union
  (`clubs.union_id = fade...`); the cluster probe filters for that.
- **`ALTER TABLE public.tables` can deadlock against realtime** (it wants
  an exclusive lock on realtime's `subscription` relation while a realtime
  worker holds it and waits on `tables`). Put table ALTERs in their own
  small transactions with `SET LOCAL lock_timeout = '3s'`, apply with a
  retry loop, and NEVER inside a probe's DO block: the probe would hold
  `ACCESS EXCLUSIVE` on `tables` for its whole run. Functions-only
  migrations are safe to probe.
- **Long commands from host_terminal die with the call.** `nohup ... &`
  is not enough when the call itself times out; use
  `python3 -c "import subprocess; subprocess.Popen([...], start_new_session=True, ...)"`
  and poll the log in later calls.
- **A PL/pgSQL `IF` condition ends at the first `THEN`** - a `CASE WHEN ...
THEN` inside one is a syntax error "at end of input". Compute it into a
  variable first.
- **`fn_capture_managed_game_contract` fires on EVERY `tables` UPDATE** and
  hashes the whole row minus an exclusion list. If you add a column the
  controller churns, add it to `fn_managed_game_contract_document`'s
  exclusion list or every tick mints a contract version.

### The Silent Revert Guard

It reads COMMITS, not the tree. My first Slice 1 branch descended from the
Slice 0 branch and the guard read those commits as undoing #2927; the PR was
blocked and needed a human label. **Cut your branch from `origin/main` and
squash your work onto it** rather than branching off a feature branch.

---

## 6. FILE MAP FOR THIS OPERATION

```
docs/OPORD-1.4-AMENDMENT.md            the spec. Sections 2.6, 18, 19, R1-R9.
docs/changelog/2026-09-04-chip-continuity-slice-0.md
docs/changelog/2026-09-04-cash-games-slice-1.md
docs/changelog/2026-09-04-cash-games-slice-1-hardening.md
docs/LAWS.md                           every *.law.test.* needs a row here

supabase/migrations/20260904120000_chip_continuity_slice_0.sql
supabase/migrations/20260904140000_chip_continuity_slice_0_hardening.sql
supabase/migrations/20260904160500_cash_games_slice_1.sql
supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql
scripts/dev/probe-chip-continuity.sql
scripts/dev/probe-cash-games.sql       26 scenarios, all PASS
scripts/ci/schema-manifest.d/chip-continuity-slice-0.json
scripts/ci/schema-manifest.d/cash-games-slice-1.json

src/config/cashGames.ts                templates, the nine variants, refusal copy
src/components/cash/CashGameCreateFlow.tsx|.css    the 7-step create flow
src/components/cash/CashGameCard.tsx|.css          the lobby card (Gate 4 feeds it)
src/components/table-config/controls.tsx           Toggle / Slider / NumberField
public/images/cash-cards/*.webp                    Dan's artwork, values lifted out
src/pages/TableConfigPage.tsx                      Regular tab renders the flow
src/lib/chipContinuity.ts                          leave label + lock helpers

server/src/engine/ChipContinuity.ts                the stay-clock mirror
server/src/services/supabase/cashSessions.ts
server/src/services/HorseFleetManager.ts           <- Slice 6 replaces its table logic
server/src/services/HorseOrchestrator.ts           <- H12, dead browser writer (zero callers)
server/src/cluster/ClusterController.ts            the clock (5 s, leader)
server/src/services/supabase/seatMoves.ts          the engine's half of must-move
supabase/migrations/20260905010000_cluster_columns_slice_2.sql
supabase/migrations/20260905010500_cluster_controller_slice_2.sql
scripts/dev/probe-cluster-controller.sql           23 scenarios, all PASS
scripts/ci/schema-manifest.d/cluster-controller-slice-2.json
server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts

tests/cash-games-are-created-from-a-template.law.test.tsx
tests/chip-continuity-is-house-law.law.test.ts
tests/unit/cashGameCard.test.tsx
tests/unit/cashGamesVocabulary.test.ts
```

---

## 7. THE GAME CARDS (Dan's artwork) — what exists and what is left

Dan supplied three finished cards. I lifted every changing value out of the
JPGs (filling from the surrounding panel) and kept the frame, emblem, title,
row labels and button faces:

- `public/images/cash-cards/{classic,action,madness}.webp` (~120 KB each).
- `CashGameCard` paints stakes, variant, RUNNING/WAITING/DORMANT,
  MUST MOVE/MANUAL, the four row values and the rules strip over it. Zones
  are percentages of the 784x1168 frame (`ZONES` in the component); type is
  in container-query units; long labels shrink via `--cgc-fit`. VIEW GAME and
  JOIN GAME are real buttons over the painted faces.
- `rulesLineFor(snapshot)` builds the strip in the artwork's wording.
- It is rendered TODAY as a live preview inside the create flow.

**Gate 4 is to feed it from data:** one card per `cash_games` row, `players`
= seats across `tables WHERE cluster_id = game.id`, `tables` = that count,
`status` from `state` + whether any table is dealing. `src/pages/ClubHomePage.tsx`
builds `lobbyEntries` (line ~3604) and renders `GameLobbyPanel`; that is
where a cash-games board goes. **If the artwork changes, re-measure `ZONES` —
they are the contract between the picture and the text.**

---

## 8. OPEN ITEMS, HONESTLY STATED

1. **PR #3008 must land, and the controller must be SEEN ticking a real game**
   (section 4, "Verify it LIVE"). Nobody has yet; there were no must-move
   games on production when it was pushed.
2. **Must-move is implemented for cluster tables** (Slice 2 + 6). A6.11
   (rotator floor) and orbit-based hysteresis are the named leftovers.
3. **H12** `HorseOrchestrator` still inserts cash tables from the browser.
4. **H13** the union-operator Start path wakes no engine.
5. **The lobby does not know about `cash_games`.** It lists the `tables` rows,
   so a game appears as one ordinary table per cluster table today. Gate 4
   (section 4b).
6. **`cash_games.state`** is derived by the controller every tick (18.4).
7. **The pre-Slice-1 cash fields on `TableConfig`/`DEFAULT_CONFIG`** are kept
   only so an old `table_templates` row restores. They are dead weight and
   can go at the Slice 7 cutover.
8. **UNVERIFIED:** the section 8 numbers (VPIP floors, buy-in bands, bomb
   antes) are asserted only by the migration's own DO block — OPORD 1.3's
   text is not in this repo, so I could not diff them against the source. If
   Dan's 1.3 disagrees with `fn_cash_template_defaults`, 1.3 wins.

---

## 9. THE ONE-PARAGRAPH VERSION

A cash game is now a row in `cash_games` with a resolved `ruleset_snapshot`,
created by `fn_cash_game_create` (9 args, SECURITY DEFINER, every refusal
named) which also opens Main 1 with `cluster_id`/`role`/`main_index`/
`lifecycle` set. The browser writes nothing. A player cannot take chips off a
seat and cannot leave while ahead until the stay clock runs out. Your job is
the controller that makes those cluster columns mean something: open, feed,
must-move, break, dormant — with no human anywhere in it, and only for games
where `must_move = true`.
