# MILITARY GRADE HANDOFF — Operation Table Stakes, Gate 3

**Written 2026-09-04 20:00 UTC by the agent that shipped Gates 0-2. Read this
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
| 2.5  | Slice 1 hardening + R9 + cards                         | **PR #2997 OPEN** (pushed 19:57 UTC; migration already applied to prod)         |
| 3    | Slice 2 cluster runtime + Slice 6 autonomous lifecycle | **YOURS**                                                                       |
| 4    | One lobby card per game                                | Component built, not fed                                                        |
| 5    | Rules engine                                           | Not started                                                                     |
| 6    | Chrome                                                 | Not started                                                                     |
| 7    | Cutover                                                | Not started                                                                     |

### The first thing you do

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/2997 \
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
- **R3** Main 1 is ALWAYS ON for a must-move game. Today that is carried by
  `auto_extension=true` + `auto_restart=true` on the row. **When your
  ClusterController owns the lifecycle, take those two flags off Main 1 and
  make the controller the keep-alive** — two mechanisms fighting is the
  hamburger war shape (CLAUDE.md 10.7).
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

## 4. GATE 3 — WHAT YOU ARE BUILDING

Read OPORD 1.4 section 18 in full. The summary:

One stateless `ClusterController.tick()` derives every table decision from
rows, and replaces the table-lifecycle half of `HorseFleetManager` (horse
SEEDING stays in the fleet). For each enabled `must_move` cash game:

1. **Open** Main 1 if missing; open Main N+1 when every main is at
   `handedness - 1` seats, up to `cap_mains`.
2. **Feeder** rules per section 18: one feeder, `allow_second_feeder` for a
   second.
3. **Must move**: a seat opening on a main pulls the longest-waiting player
   off the feeder. This is the feature the game is named for and there is
   **no implementation of it anywhere today** — `role`, `main_index` and
   `lifecycle` exist as columns and nothing reads them (verified by grep,
   2026-09-04).
4. **Break** a table: `lifecycle='breaking'` stops new seats, the last
   players are moved, then `closed`.
5. **Dormant**: zero seated across the cluster → `state='dormant'`, Main 1
   stays open (R3).

### Things the audit found that Gate 3 must handle

| Item | What                                                                                                                                                                                               | Where                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H12  | `src/services/HorseOrchestrator.ts` still inserts fleet cash tables from the BROWSER, outside any cluster, with `straddle_enabled: true` in settings.                                              | Route it through `fn_cash_game_create` or retire it when the fleet moves to clusters. It is a sanctioned writer in `tests/unit/oneTableWriter.test.ts` — move the pin in the same commit. |
| H13  | A union operator who is not a club member passes `fn_can_create_games` but `authorizeTableViewer` refuses the engine wake, so Start navigates to a felt with no engine until the first seat.       | `server/src/services/TableViewerAccess.ts`. Fixed for free once the controller wakes Main 1 instead of the browser.                                                                       |
| —    | `cash_tables_needing_engine` requires `HAVING count(*) >= 1` on `table_seats`, so a 0-seat Main 1 is NOT adopted by the discovery loop. Start wakes it via `ensureCashTableEngine`; Save does not. | `supabase/migrations/20260827_horses_are_players_law.sql:296`. Your controller should wake its own tables.                                                                                |
| —    | `fn_table_lifecycle_pass`'s AUTO CREATE TABLE clones by NAME PREFIX via `fn_clone_table_row`, and the clone does **not** carry `cluster_id`.                                                       | Never set `auto_create_table` on a cluster table. `fn_cash_game_create` never does.                                                                                                       |

### Acceptance (OPORD 1.4 section 19)

A slice that is not test-green is not done. Probe every SQL path in a
transaction you roll back (CLAUDE.md 11.5), and write the law test in the
same commit as the behaviour.

---

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
  dynamically — that member IS in the club.

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
server/src/services/HorseOrchestrator.ts           <- H12, still a browser writer

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

1. **PR #2997 must land.** Its migration is already on production.
2. **Must-move is not implemented.** `role`, `main_index`, `lifecycle` are
   columns nothing reads. This is the whole of Slice 2.
3. **H12** `HorseOrchestrator` still inserts cash tables from the browser.
4. **H13** the union-operator Start path wakes no engine.
5. **The lobby does not know about `cash_games`.** It lists the `tables` rows,
   so a Slice 1 game appears as an ordinary table today. Gate 4.
6. **`cash_games.state`** is written 'live' on create and 'dormant' on close;
   nothing else moves it. The controller owns it from Gate 3.
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
