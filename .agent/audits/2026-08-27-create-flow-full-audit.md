# Create Table / Create Game — Full Audit (2026-08-27)

Scope: every path that creates a cash table, MTT, SNG, heads-up game or spin —
UI (CreateTablePage, TableConfigPage, CreateTableModal, CreateTournamentModal,
lobby entry points) → services (TableService, TournamentService,
tournamentFromTableConfig) → RPCs and RLS (fn_create_tournament,
fn_can_create_games, tables INSERT policy, tournament_schedules) → engine
(GameServer discovery, TournamentManager, ServerTableEngine) → production DB
(verified live via Supabase MCP, not from migration files).

Shipped this session: **PR #1408** (client fixes + pinned-test updates) and
migration **create_flow_p0_fixes** (applied to production via Supabase MCP,
assertions passed).

---

## 1. WHAT WAS ACTUALLY BROKEN (fixed in PR #1408)

### 1.1 Start created tables no engine would ever run — the core "nothing works"

`TableConfigPage.handleStart` inserted `status: 'active'`.
`cash_tables_needing_engine` (the engine's only cash-table discovery query)
matches `status IN ('waiting','running')`. 'active' is a legal column value
nothing matches: the table rendered in the lobby, accepted seats, and no
engine ever adopted it — every socket closed 4404 and no hand was ever dealt.
Fix: client writes 'waiting'; the RPC now also tolerates 'active'
(defense while the bundle propagates); the one stranded production row was
repaired.

### 1.2 Save was a lie in both directions

`handleSave` inserted a full `tables` row flagged `is_template: true` and
toasted "Table template saved!". Nothing in src reads `is_template`; the
template dropdown reads `table_templates` (written by the separate
"Save as Template" button), so the saved "template" never appeared there —
and because no lobby query filters the flag, it DID appear in the lobby as a
joinable table. Worse, `handleSave` had no gameMode branch: saving an SNG or
MTT config inserted a CASH table. Fix: Save on Regular creates the real lobby
table; Save on SNG/MTT creates the tournament (same as Start, minus
navigating to the felt). Production had 0 `is_template` rows, so nothing
needed repair.

### 1.3 The Cap toggle capped nothing

`cap_enabled` was written with no `cap_bb`. The engine
(ServerTableEngineTurns) computes the ceiling as `cap_bb * big_blind` and
treats `cap_bb <= 0` as uncapped — its own comment records that the toggle
existed since February "with NO AMOUNT COLUMN ANYWHERE IN THE SCHEMA".
The column was added 2026-08-25; the page never caught up. Fix: Cap Amount
slider (10–200 BB, default 50), `cap_bb` written, forced 0 when off.

### 1.4 The Fee label misstated the house cut

The SNG/MTT tabs showed a hard-coded "10% Of Buy-In". The live
`fn_create_tournament` charges **5% on SNGs**, 10% on MTTs, **0 on Spins**.
Label is now per-mode.

### 1.5 Every SNG was announced as "Heads Up"

Including 3-handed Spins. The success toast now names what was built
(Spin / Heads Up / Sit and Go / Tournament).

### 1.6 A Create button that 404'd

TournamentLobbyPage's empty state linked to `/clubs/:id/create-tournament`,
a route that has never existed. It points at the real create-table picker now.

---

## 2. VERIFIED WORKING (checked against live production, not docs)

- `tables` INSERT RLS: exactly one policy live
  (`tables_insert_owner_or_admin`); the three older permissive policies the
  migration history suggested might survive were confirmed **dropped**.
- `fn_create_tournament`: whole-buy-in refusal, trunc-to-cents fee (the
  round()-past-the-CHECK bug was already fixed on origin/main by
  `20260827_tournament_rake_attribution_and_creation_caps.sql` — my local
  clone was 27 commits behind, which briefly made it look live), payout sum
  validation, bounty ≤ prize-half, satellite target/seat validation, union
  stamping, private-game branch.
- Tournament engine honours: blind structures + level minutes, payout
  choices, late-reg levels, rebuys (max_rebuys enforced in SQL), add-on
  windows, KO/PKO/mystery bounty attribution, big-blind ante, synchronized
  breaks, all-in-or-fold, accelerated MTT, bubble protection, final-table
  deal, early-bird chips, satellite seat awards, guarantees.
- Spins are fully real server-side: seat-first (`fn_take_seat_and_buy_in`,
  gated to `variant='spin' OR max_players<=2`), paid-entry gate before start,
  reserve-pool-gated multiplier draw (`fn_spin_draw_multiplier`), settlement
  via `fn_spin_settle_game`, tier availability view.
- Heads-up: correctly classified seat-first (`sng && max_players <= 2`),
  `requiredField` floor of 2 (the 17-stuck-games fix), button/SB rules in
  HandController.
- Weekly recurrence: `fn_upsert_tournament_schedule` + engine-side spawner
  with spawn-key idempotency.

---

## 3. STILL BROKEN, DEAD, OR DISHONEST (Phase 2 — proposed, not yet done)

### Dead controls still on the create form (each a switch that lies)

| Control      | Reality                                                             |
| ------------ | ------------------------------------------------------------------- |
| Triple Board | `triple_board` has zero readers anywhere (engine, SQL, lobby)       |
| Calltime     | `calltime_enabled` has zero readers                                 |
| Game Length  | `game_length_hours` has zero readers                                |
| Bomb Pot     | works, but frequency/ante are hard-coded 10 hands / 2xBB — no knobs |

House precedent (security switches, multi-day MTT): remove until built, or
build. Recommend: remove Triple Board + Calltime + Game Length from the form
(columns stay); add Bomb Pot frequency/ante knobs.

### Dead code to delete

- `CreateTableModal` — zero imports; and with it `TableService.createTable`
  (its only caller). This is the "older path" several comments still call
  the working one; it is unreachable.
- `LegacyCreateTournamentModal` (TournamentPage:1760) — defined, never
  rendered, still contains a live createTournament call.
- `QuickActionsPanel` — zero imports AND navigates to `/create-table`, a
  route that does not exist.
- `TournamentService.createSpin` — zero callers.
- CreateTablePage "Table Template" button — no onClick since the page was
  built.

### Real defects

- **Zombie-reaper mismatch**: GameServer `readyIds` uses `player_count >= 2`
  but the engine deals at `max(2, auto_start_players)`. A table with
  auto_start_players = 5 and 2–4 seats gets its engine torn down and rebuilt
  every 180 s forever.
- **Raw SQL errors reach users**: `createTournament` rethrows PostgrestError
  verbatim (a CHECK violation toasts as `new row for relation "tournaments"
violates…`). Map 23514/0A000 etc. to human text.
- **Dead tournament config written but never read**: `late_reg_mins`,
  `addon_break_minutes` (no add-on break is ever taken), `max_reentries`
  (written, unenforced — unlike max_rebuys), custom blind-structure break
  rows (explicitly skipped; only the :55 global break exists), `spin_type
'hyper'` (same ladder as standard).
- **Untracked production schema**: `fn_can_create_games` and
  `fn_game_creation_access` exist only in production — no migration file in
  any repo. Snapshot them into a migration so a rebuild cannot lose them.
- **Client startTournament path** (TournamentPage:561 →
  `TournamentService.startTournament`) bulk-creates tournament tables
  client-side with hardcoded 9-max NLH — duplicates and disagrees with the
  engine's seating. Retire it.
- **Canonical clone is bare**: `~/Documents/club-arena` has
  `core.bare = true` — `git status`/`checkout` fail there ("must be run in a
  work tree"). Possibly a deliberate shared-clone guard; if not, it should
  be repaired. Either way it should be documented.

### UX questions for Dan (deliberately NOT changed)

- ClubHomePage's "+ Create" button shows only when `club.is_union === true`
  — pinned by `lobbyUnionCreateControls.test.ts` as deliberate ("creation
  only to staff on the union row itself"). Standalone-club owners create
  from ClubDashboard / ClubDetailPage instead. If you want the button in
  every club lobby, that is a one-line change plus the test.
- Save vs Start now both create; the only difference on Regular is where
  you land (lobby vs felt). If you would rather Save mean "save as
  template", say so and it becomes an alias for that button instead.

---

## 4. PHASE 3 — ENHANCEMENT / OPTIMIZATION (proposed)

1. **One creation surface.** CreateTournamentModal and TableConfigPage's
   SNG/MTT tabs are parallel builders with different capabilities (the modal
   alone offers mystery bounty, XMTT, multi-day, hyper spins; the page alone
   offers weekly schedules and heads-up presets). Converge on one component
   so features stop shipping to one door only.
2. **Template system unification.** `table_templates` exists, has RLS, a
   use_count column, a launch RPC (`fn_launch_table_from_template`) — and
   zero rows ever written by a user. Surface templates properly: save from
   the form, list with usage, one-tap launch.
3. **Truthful live preview.** Show the computed buy-in split (total → prize
   - fee at the real rate), the rake schedule row for the chosen stake, and
     the payout table before creation.
4. **Discovery latency.** Cash + tournament discovery is 5 s polling; a
   realtime INSERT subscription on `tables`/`tournaments` would make Start →
   first hand near-instant. Low priority; polling works.
5. **Creation-error taxonomy.** Extend TOURNAMENT_CREATE_ERRORS to cover
   every code fn_create_tournament can return, plus SQL error codes.

---

## 5. VERIFICATION RECORD

- `npx tsc --noEmit` — clean (exit 0).
- `npx vitest run tests/` — **7,281 passed, 0 failed** (includes the updated
  `oneTableWriter.test.ts`, which previously pinned the broken Save/Start
  and now pins the fix).
- Migration `create_flow_p0_fixes` applied to production; post-apply
  assertions passed (0 stranded rows, RPC tolerates 'active').
- Production checks: single INSERT policy on `tables`; fee formula is
  trunc-to-cents; `cap_bb` exists (numeric); 0 `is_template` rows;
  1 stranded 'active' row repaired.
- PR #1408 opened on branch `agent/cowork-create-audit/fix/create-flow-p0`;
  Autopilot merges on green. Publish path: merge → build-for-world-hub →
  World Hub → Vercel.

---

## 6. PHASE 2 — EXECUTED (same day)

Shipped in the follow-up PR (branch `agent/cowork-create-audit/fix/create-flow-phase2`):

- **Dead switches removed from the create form**: Triple Board, Calltime,
  Game Length (columns stay; each wrote a column with zero readers).
- **Bomb Pot got its knobs**: frequency (5-50 hands) and ante (1-10 BB)
  sliders, wired to bomb_pot_frequency / bomb_pot_ante_multiplier — the
  numbers were hard-coded 10 / 2 since FIX-D10.
- **Dead code deleted**: CreateTableModal (+css) and TableService.createTable
  (unreachable modal path), QuickActionsPanel (+css, zero imports and a
  broken route), LegacyCreateTournamentModal, TournamentService.createSpin,
  the inert Table Template footer button on CreateTablePage. Pinned tests
  updated in the same commit (oneTableWriter, tableCreationRealities,
  tableLifecycleSwitches).
- **Zombie reaper fixed** (server): "should be dealing" now measures each
  cash table against its own dealThreshold() (= minPlayersToDeal) instead of
  a hard-coded 2, ending the 180s engine rebuild loop for tables with
  auto_start_players > 2. New public accessor on ServerTableEngineBase.
- **Creation errors humanized**: createTournament maps 23514 / 0A000 / 42501
  to plain language instead of rethrowing raw Postgres text; raw error still
  reported.
- **Fee previews tell the per-format truth**: 5% SNG / 0 Spin / 10% MTT in
  CreateTournamentModal (label, split preview, bounty validation) and
  tournamentFromTableConfig — both assumed a flat 10%.
- **Untracked authorization spine snapshotted**: fn_club_union_context,
  fn_can_create_games, fn_game_creation_access entered version control
  (migration `20260827_snapshot_game_creation_access_functions.sql`, applied
  to production; one deliberate change — anon/PUBLIC EXECUTE revoked on the
  two helpers the 2026-08-25 sweep missed; both fail closed for anon).
- **Corrections to the Phase-1 findings**: max_reentries IS enforced
  (`20260826_tournament_rake_settlement_integrity.sql`), and the
  fee-formula/CHECK conflict was already fixed on origin/main
  (`20260827_tournament_rake_attribution_and_creation_caps.sql`) — the local
  clone was 27 commits behind when the audit read it.

Verification: client tsc clean; client suite green (7,286 tests — two
git-ls-files pins resolve at commit time when the deletions stage); server
tsc clean; server suite 1,913 passed. Migration applied with passing
assertions before push.

Still open for Phase 3 (unchanged from section 4): one creation surface,
template unification, live buy-in/rake/payout preview, realtime discovery,
full creation-error taxonomy, add-on break implementation or removal,
late_reg_mins retirement, spin 'hyper' type (cosmetic today).
