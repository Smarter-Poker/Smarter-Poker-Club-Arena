# Diamond Arena Phase 10: the three unaddressed lines, audited line by line, 2026-09-21

An audit, not a plan. Item 6 of [the remaining-work audit of September 20](DIAMOND-LAUNCH-REMAINING-WORK-2026-09-20.md) left three Phase 10 lines unaddressed and said they were a smaller job than the checkbox count suggests, because the history, replay, statement and reconciliation readers already exist. Nobody had compared the lines with what is built. This does, against `origin/main` at `e1382a4e67` and against production (project `kuklfnapbkmacvwxktbh`).

How it was read. Every database fact below was read with `supabase db query --linked` inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` on 2026-09-21 between 22:20 and 22:55 UTC. Where a read is described as taken "as an ordinary player", the same read-only transaction set `request.jwt.claims` to one account that is neither staff nor a horse and ran `SET LOCAL ROLE authenticated`. Nothing was written, no switch was touched and no migration was written, rehearsed or applied. Incident and profile counts move every hour; the ones quoted are from a single read at 22:49 UTC unless another time is given. Anything inferred from source rather than read or run says so where it appears.

## The short answer

For these three lines item 6 is half right. The reconciliation readers are built, installed and scheduled, and the one count the arena shows today, ACTIVE, is already a real measurement with a real "could not tell" state. What is missing is not readers. It is doors and surfaces:

- Nobody, staff included, can edit, close, pause, kick from, or remove a player from a Diamond game through any door a signed-in person can reach. The Diamond creation doors exist and are staff-only, but no screen calls them and none records who used it.
- Nobody can read or close a Diamond incident without SQL. 6,994 warnings are open, 6,969 of them older than a week, and no Diamond incident has ever been closed by a person.
- Almost nothing that goes wrong in the Diamond books reaches a phone. The one exception, an unexplained movement of more than 5,000 diamonds of player supply, arrives worded in chips.
- The arena's Players door opens a page that tells every Diamond player the roster is for approved members only, because the roster read does not know the Diamond entitlement.
- Nothing locks the arena automatically, which is what the line asks for. Nothing pins that either.

Nine pieces close the three lines, the first of them a pull request that already exists; they are listed in order under [Ordered build list](#ordered-build-list). One piece waits on a decision from Dan, and where the new counts appear is a second decision of his.

## What moved since September 20

- The four owner migrations are applied. `supabase_migrations.schema_migrations` holds `20260919223032 the_health_watch_resolves_what_it_filed`, `20260919223115 the_transfer_door_is_named_and_dr16_has_a_consumer`, `20260918232558 mixed_f06_custody_transfer_retains_original_operations` and `20260920172727 unresolved_f06_custody_retains_its_lease_evidence`.
- `ca_diamond_incidents` has its `resolution` column, and 0 of its rows are open at critical. The 45 `DR0:health_critical` rows and the 8 open `DR11:trial_balance_break` rows were closed by the watches at 2026-09-20 14:10:11 UTC, each with an `auto:` resolution naming what it read. I did not re-read the release gate's other two conditions.
- `fn_ca_diamond_unreachable_money()` reads ok: "No diamonds are stranded where nothing can reach them."
- The repository has not caught up. The migration files for the first two live only on PR #4969, which is OPEN and BLOCKED with five failing checks (Client Unit Tests shard 4, Client Unit Tests (vitest), Accounting transactions (PostgreSQL 17), Server Engine (typecheck + tests), What this run verified). So `origin/main` has no migration that creates `ca_diamond_incidents.resolution`, although production has the column.

## Scope

Phase 10 of [the programme](POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md) has six lines. The three audited here, in the programme's words and order:

| Line | Text                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- |
| 3    | Show real member/online/seated/table counts with meaningful zero/error states.           |
| 4    | Add staff-only game configuration, incident review and audited adjustments.              |
| 5    | Integrate financial push alerts and reconciliation without arena-wide automatic lockout. |

The phase exit reads: "every displayed metric and management action has an authoritative, tested source." Below, the lines are taken in the order 4, 3, 5. Lines 1, 2 and 6 were not audited; two facts about them turned up on the way and are recorded at the end.

## Line 4: staff-only game configuration, incident review and audited adjustments

### Who staff is

`fn_is_platform_admin()` is the estate's answer: `profiles.role IN ('admin','superadmin','god')`. Three accounts qualify, two `admin` and one `god`. The named-role operator tables (`ca_operator_roles`, `ca_operator_grants`, `ca_operator_policy`) are installed but not in force: `enforce_named_roles` is false and no grant is active, so in practice staff means `profiles.role`. Every Diamond door built so far asks `fn_is_platform_admin()`.

Two facts shape everything below. `fn_poker_arena_context` answers `role: player` for every account in the Diamond Arena; its Diamond branch sets that unconditionally, so staff are players there too. And the arena boundary (`src/components/arena/ArenaAccessBoundary.tsx` with `diamondArenaRoutes.ts`) opens only the lobby, tournaments, messages and members under `/clubs/diamond-arena` and renders the safe shell on every operator route for everybody, staff included. A staff surface for the arena therefore has to live outside the arena's own path, as `/financial-incidents` and `/financial-alerts` already do.

### Game configuration

**Built and installed.** Five doors, each `SECURITY DEFINER`, granted to `authenticated`, each refusing any caller for whom `fn_is_platform_admin()` is false:

| Door                                                                                                                    | What it does                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `fn_poker_diamond_open_cash_table`                                                                                      | opens a plain Diamond cash table and proves the new row is one the engine will admit |
| `fn_poker_diamond_set_table_straddle`, `fn_poker_diamond_set_table_run_it_twice`, `fn_poker_diamond_set_table_bomb_pot` | turn the three supported table features on or off                                    |
| `fn_poker_diamond_create_tournament`                                                                                    | creates a Diamond event                                                              |

Behind them sits a row-level guard. `fn_poker_guard_arena_structure`, attached to `clubs`, `club_members`, `tables`, `tournaments` and `union_clubs`, refuses any change to a Diamond table's or event's structure by a signed-in caller who is not platform staff, a player's own play-state columns excepted. So "staff-only" is enforced on the row as well as at the door. A cancellation door exists too: `fn_poker_diamond_tournament_cancel` returns every entry from custody and writes the immutable cancellation receipt, which names the actor.

**Half-built.**

- No screen calls any of them. `src/`, `server/src/`, and World Hub's `pages/` and `src/` (World Hub `origin/main` `3ce46d45cb`) contain no call to the five doors; the one mention in `server/src/tournament/tournamentUnit.ts` is a comment. The 17 Diamond cash tables that exist, all `waiting` and all created on 2026-09-11, were opened outside any UI.
- None of them records who used it. `created_by` is NULL on 17 of 17 Diamond tables, none of the five doors writes an audit row, and `admin_audit_log` holds no Diamond row. A staff configuration change today leaves no trace of who made it.
- The cancellation door is reachable by the service role only. `fn_poker_diamond_tournament_cancel` grants EXECUTE to `postgres` alone, and the one route to it is `atomic_cancel_tournament` (service role), which sends a Diamond event there ahead of its chip gate. The client's own cancel path, `fn_execute_managed_game_command` with action `close`, refuses a Diamond event before it gets that far (next section).

**Does not exist.** A door to edit a live Diamond table (name, stakes, buy-ins, seats), a door to close or retire one, and a door to remove a player from a Diamond event. Each has a chip door, and every one of those refuses the Diamond club by design, which is the next section.

### The staff-door problem, characterised

The known case is exact. `fn_admin_remove_tournament_player(p_tournament_id, p_user_id)` checks for a live session, reads the event's club and returns `{ok: false, reason: 'not_authorized'}` unless `fn_can_create_games(club, caller)` is true. `fn_can_create_games(uuid, uuid)` opens with

```sql
IF EXISTS (SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='diamonds') THEN RETURN false; END IF;
```

a line that comes from `20260908152822_poker_arena_identity_and_access.sql`, Phase 2's "no ordinary club grants". The removal door never asks `fn_is_platform_admin()`, so it answers `not_authorized` to every caller on every Diamond event, staff included. The refund core it would have called, `fn_ca_unregister_tournament_player_exact`, has routed a Diamond event to `fn_poker_diamond_tournament_unregister` since Phase 8, so the gate is the only thing in the way. `is_club_admin(uuid, uuid)` opens with the identical line, and no other function in production does. 20 functions call `fn_can_create_games`.

Every door with the same shape, an operator action whose only authority is a club role the Diamond club cannot have:

| Operation on a Diamond game                                 | Door (who may call it)                                                                                                                                                                                                                  | Refused by                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove a registered player with a refund                    | `fn_admin_remove_tournament_player` (authenticated)                                                                                                                                                                                     | `fn_can_create_games`                                                                                                                       |
| Edit a live table or event                                  | `fn_execute_managed_game_command` action `update` (authenticated); `fn_update_managed_game` (service role)                                                                                                                              | `fn_can_create_games`, in both                                                                                                              |
| Close a table, cancel an event                              | `fn_execute_managed_game_command` action `close` (authenticated); `fn_close_managed_game` (service role, and it raises without a signed-in caller); `fn_schedule_managed_game_close`, `fn_cancel_managed_game_schedule` (authenticated) | `fn_can_create_games`                                                                                                                       |
| Start an event now                                          | `fn_owner_start_tournament_now` (authenticated)                                                                                                                                                                                         | `fn_can_create_games`                                                                                                                       |
| Change mystery-bounty configuration after creation          | `fn_apply_mystery_bounty_config` (authenticated)                                                                                                                                                                                        | `fn_can_create_games` and `is_club_admin`                                                                                                   |
| Read a game's governed contract, history and receipts       | `fn_get_managed_game_contracts`, `fn_get_managed_game_contract_history`, `fn_get_managed_game_command_receipts` (authenticated)                                                                                                         | `fn_can_create_games`                                                                                                                       |
| Manage recurring event schedules                            | `fn_can_manage_tournament_schedule` (authenticated)                                                                                                                                                                                     | `is_club_admin`                                                                                                                             |
| Post a lobby announcement, set the tagline or lobby message | `fn_manage_club_announcement_versioned` (authenticated); `fn_save_club_identity_messages` (service role)                                                                                                                                | `fn_can_create_games`                                                                                                                       |
| Pause, resume or kick at a table                            | engine `POST /admin/pause`, `/admin/resume`, `/admin/kick`, `/admin/kick-occupancy` (`server/src/handlers/admin.ts`, `authorizeTableAdmin`)                                                                                             | a `club_members` role of owner, co_owner, admin or super_agent in the table's club; the arena's only row is `role player, status automatic` |

The other callers of `fn_can_create_games` are not gaps. `fn_cash_game_create` and `fn_create_tournament` are the chip creation doors, which the Diamond creation doors replace on purpose; `fn_game_creation_access` answers "may I create games here", which is correctly false in the arena; `fn_cash_game_create_impl_20260905`, `fn_create_tournament_governed_legacy` and `fn_manage_club_announcement` are internal or legacy. The twentieth is `atomic_cancel_tournament`, the one chip door that already does the right thing: it asks `fn_poker_diamond_tournament(p_tournament_id)` first and hands a Diamond event to the Diamond door ahead of its chip gate. That is the pattern to copy.

The mirror image exists too, and matters before anyone widens a gate. `fn_request_manual_bomb_pot` and `fn_update_table_bomb_settings` authorize through `clubs.owner_id` or a club role and have no Diamond branch. The arena's `owner_id` is the `smarterpoker` account, role `god`, so for a Diamond table these two chip doors admit exactly one of the three staff accounts and refuse the other two, and that one account could change a Diamond table's bomb settings without the checks in `fn_poker_diamond_set_table_bomb_pot`. The row guard still stops anyone who is not staff. I did not test what the engine would then do with such a table.

### Incident review

**Built and installed.**

- The Diamond incident store, `ca_diamond_incidents`: `id, occurred_at, rule, severity, user_id, amount, writer, db_role, app_name, detail, resolved_at, resolution`. Its one filer, `fn_ca_diamond_incident`, files a non-critical row about a certification fixture at info.
- Automatic closure for three rule families. `fn_ca_diamond_health_watch` closes a `DR0:health_critical` row once every area it names reads something other than critical or unknown. `fn_ca_diamond_trial_balance_watch` closes `DR11:trial_balance_break` when its account reads 0 and `DR12:suspense_nonzero` when suspense reads 0, and it closes every info row older than seven days.
- The chip estate's review system, which is the model to copy: `ca_drift_incidents` with an append-only `ca_incident_events` trail, `fn_ca_incident_dashboard` and `fn_ca_incident_action` (acknowledge, assign, comment, reconciling, resolve with root cause and correction reference, reopen), an escalation tick every minute, and the `/financial-incidents` page (`DriftIncidentsPage` behind `FinancialAdminGate`). It reads `ca_drift_incidents` only.

**Half-built.** The Diamond store has no reader a person can reach. Row security is on with no policy, only the service role holds grants, no trigger is attached, and none of the nine functions that touch the table can be called by a signed-in account. There is no review door at all: nothing records who looked at a row, why it was closed, or by whom.

**What that leaves, read at 22:49 UTC.** 55,293 rows. Open: 0 critical, 6,994 warning, 14,485 info. 6,969 of the open warnings are older than seven days, and the oldest is from 2026-09-03. No row has ever been closed with a resolution a person wrote. The open warnings by rule:

| Rule                                | Open warnings | Last filed (UTC)                         |
| ----------------------------------- | ------------- | ---------------------------------------- |
| `DR7:user_over_daily_cap`           | 4,554         | 2026-09-19 00:26                         |
| `DR2:balance_born_outside_the_mint` | 1,349         | 2026-09-07 22:01                         |
| `DR5:deleted_with_balance`          | 739           | 2026-09-08 02:22                         |
| `DR7:engine_over_budget`            | 297           | 2026-09-08 11:24                         |
| `CH3:horse_claim_failed`            | 34            | 2026-09-21 02:20, 9 in the last 24 hours |
| `DR13:concentration_or_velocity`    | 20            | 2026-09-20 06:25                         |
| `DR2:signup_grant_refused`          | 1             | 2026-09-08 18:31                         |

None of these is critical, and the health report's horse-claims area reads ok, so the `CH3` rows are not losses today. The point is that nobody would be told if they became losses.

**Does not exist.** A staff reader for Diamond incidents, a review door, and a reviewer or reason on any closed row. One constraint for the build: `fn_ca_incident_dashboard` answers any active incident recipient, any club owner and any union owner as well as platform staff (three accounts in all today), so pouring Diamond incidents into it unfiltered would not be staff-only.

### Audited adjustments

**Built and installed.**

- `fn_ca_mint` and `fn_ca_burn` take asset `diamonds` to or from a player or the house, keep the register whole, and are capped by `ca_mint_policy` at 1,000,000 diamonds per operation and 2,000,000 per rolling 24 hours. Service role only.
- World Hub's operator route `pages/api/horses/mint.js` issues and retires diamonds for an individual player only (its `ALLOWED_TARGETS` for diamonds is `['player']`), runs `requireApproval` before the mint and files an `admin_audit_log` row through `auditOperatorAction`.
- `ca_manual_adjustments`, a four-eyes register. `fn_ca_propose_manual_adjustment` accepts the target kinds `diamond_wallet` and `diamond_house` (asset `diamonds`, whole numbers only), a check constraint forbids an approver approving their own proposal, and the reason must be at least 20 characters.

**Half-built.**

- An approved Diamond adjustment has nowhere to go. The only code that settles a `ca_manual_adjustments` row is `fn_settle_tournament_obligation_before_atomic_batch_gate`, and it requires asset `chips` and target `player_wallet`. The register holds 10 rows, all chips: 6 settled, 3 proposed, 1 approved. Propose, approve and reject are service-role only and no screen calls them.
- There is no record of the audited mint route being used. `ca_operator_policy.approvals_enabled` is false with every threshold at 0, so it asks for no second person; `ca_operator_approvals` is empty; `admin_audit_log` holds 17 rows, the newest from 2026-09-04, none of them a mint or burn. The diamond mints filed with origin `operator` in `ca_mint_ledger` are overwhelmingly signup grants (2,525) and certification fixtures (260) with no `performed_by_label`.

**Does not exist.** An adjustment of Diamond Arena game money. No door a signed-in person can call moves a custody row (`poker_diamond_custody`, 0 rows today), a tournament's banks in `poker_diamond_tournament_ledger`, or the house: the doors that move them are the engine's service-role doors or `postgres`-only. That does not bite until a switch opens. The day it does, returning a stranded seat or entry with a reason on record has no door.

## Line 3: real member, online, seated and table counts with meaningful zero and error states

**Built and installed.**

- ACTIVE, the players seated in the arena now, on the home card (`DiamondArenaCard`) and the lobby rail (`ClubIdentityCard` with `arenaStats`), from `get_club_players_playing`, a security-invoker function granted to `anon` and `authenticated` that counts distinct live seats and never joins `club_members` (#4955). As an ordinary player it returns 0, which is true: no Diamond seat is occupied.
- A count has three answers (`src/lib/countFigure.ts`): a number; not yet asked, printed `0`; asked and could not tell, printed `Unavailable`. Pinned by `tests/a-diamond-figure-is-real-or-it-is-unknown.law.test.ts` (#4955).
- The freeroll clock prints `None Scheduled`, `Unavailable` or the countdown instead of `0:00` (#4945).
- The lobby lists the 17 Diamond tables with the seats filled at each, and labels seats and registration `Not Open Yet` while the switches are off (`ClubHomePage`; from source, not rendered).

**Half-built.**

- The Players door leads to a refusal. `DiamondBottomNav` (#4954) sends Players to `/clubs/diamond-arena/members`, which renders `ClubMembersPage`. Its summary read, `ca_club_members_summary`, looks the viewer up in `club_members` with status active or approved; the arena's single row has status `automatic`, so it returns NULL. As an ordinary player it returned NULL. The page treats NULL as a refusal and prints "This Roster Is Available Only To Approved Club Members." (from source; I did not render it in a browser). Even answered, the page is the chip roster, with My Downline, Agents, Admins, Fees 100+ and Wallet Balance among its filters, sorts and columns.
- Three chip readers answer a structural zero for the arena: `fn_batch_club_realtime_member_counts` returns 0 and `fn_batch_club_realtime_active_counts` returns 0 (both read as an ordinary player), and `clubs.member_count` is 0. `HomePage` no longer uses them for the arena; they still answer 0 to anyone who asks.

**Does not exist.**

- A Diamond member count. No reader exists. The population the entitlement defines, read at 22:49 UTC: 1,200 profiles, of which 51 are certification fixtures ("Fixture accounts are not players; horses are", `docs/DIAMOND-RULINGS.md`). Of the other 1,149, 1,000 are horses, which count under CLAUDE.md 10.5, and 149 are human accounts. The fixture count moves as the certification harness creates and removes accounts (54 at 22:40).
- A Diamond online count. The roster's own rule, seated or `profiles.is_online` with `last_seen` inside five minutes, gave 0 at 22:49 UTC and 3 human accounts at an earlier read the same evening. No reader applies it to the arena.
- A Diamond table count. 17 tables exist, all `waiting`, none `running`; no figure anywhere says so.

Where these three figures should appear is not settled. See [the decisions](#decisions-for-dan).

## Line 5: financial push alerts and reconciliation without arena-wide automatic lockout

**Built and installed: reconciliation.**

- Scheduled readers, all active in `cron.job`: `ca-diamond-snapshot-hourly` (`fn_ca_diamond_snapshot`, minute 10), `ca-diamond-trial-balance-hourly` (`fn_ca_diamond_trial_balance_watch`, minute 20), `ca-diamond-health-watch-hourly` (`fn_ca_diamond_health_watch`, minute 35), `ca-diamond-economy-watch-daily` (06:25), `ca-diamond-prune-history-daily` (06:40) and `ca-diamond-rule-flip-daily` (06:50).
- Read now: `fn_ca_diamond_register_vs_supply().difference` is 0, and `fn_ca_diamond_health()` returns 14 areas, 11 ok and 3 attention (rules overdue, per-user caps, budget plans), its trial-balance area reading "Every reconciling account balances against the journal."
- For a player: `fn_diamond_arena_reconciliation`, granted to `authenticated`, behind `DiamondArenaStatement` in the wallet, with `fn_diamond_flow_by_kind` and `fn_diamond_wallet_summary`. The migrations `the_diamond_ledger_sums_itself`, `the_wallet_learns_the_diamond_arena`, `the_wallet_knows_the_cheapest_seat_in_the_diamond_arena`, `the_diamond_arena_reconciles` and `where_the_diamonds_go` are all in `schema_migrations`.

**Built and installed: push.** The chip estate's pipe is live: `financial_alerts`, then `fn_ca_financial_alert_to_incident`, then `ca_drift_incidents`, then `fn_ca_incident_notify`, then a `financial_incident` notification and the push outbox. It created 8 `financial_incident` notifications in the last seven days, the latest at 06:40 UTC today, and withheld 106 under Dan's rule of 2026-09-06; one recipient is active, at platform scope. I did not check delivery to a device. Two Diamond things already feed it:

- `fn_ca_diamond_snapshot` raises a drift incident when player supply moves more than 50 diamonds beyond what the register explains, critical above 5,000. Eight have been filed; all are resolved.
- The engine's `server/src/services/DiamondCustody.ts` raises critical alerts `DiamondCustody.reserve_unverified` and `DiamondCustody.release_unverified`, tagged `asset: diamonds`.

**Built and installed: no lockout.** Nothing locks the arena automatically, and this was checked rather than assumed.

- The switches live in `ca_arena_settings` (both false, last changed 2026-09-08 11:28 UTC). Only the service role holds grants on it. No function in any schema and no `cron.job` command writes it, and outside isolated test fixtures nothing in the repository does either. The engine reads the switches (`server/src/services/cashTablePlayEligibility.ts`, `server/src/services/supabase/tables.ts`) and never writes them.
- I found no function that refuses play because an incident is open. The only function that both reads `ca_drift_incidents` and raises on a critical is `fn_ca_alarm_drill`, a drill, and the nine functions that touch `ca_diamond_incidents` refuse nothing except the arming of a rule.
- The Diamond rules refuse one movement at a time. `DR16` refuses one deposit, in either mode. `DR15`'s trigger, `fn_ca_arena_seat_is_same_asset`, never refuses a seat; arming it only raises the severity of what it files.

**Half-built.**

- The engine's Diamond criticals page nobody (from source, not executed). `DiamondCustody`'s alert context carries no `discrepancy` or `amount`, so the drift incident it becomes has discrepancy 0, classification `unknown` and no club, and `fn_ca_incident_notify` withholds it as "nothing is unaccounted for (0.00)". That is Dan's rule working as written; the alert simply does not say how much is in doubt.
- The pipe speaks chips. `fn_ca_incident_notify` prints "drift N chips" for every incident with an amount, and `fn_ca_raise_drift_incident` has no currency parameter, so `ca_drift_incidents.currency` takes its default `club_chips`. All 6,252 rows carry that value, the eight Diamond snapshot incidents included.
- `ca_diamond_incidents` never pages. It has no trigger, and none of the nine functions that touch it reaches `notifications`, `financial_alerts` or `fn_ca_incident_notify`. This becomes live tomorrow. At the 06:50 UTC run on 2026-09-22, `DR15:cross_asset_seat` and `DR16:deposit_inside_settlement_window` arm unless another gate stops them: in a dry run of `fn_ca_diamond_rule_flip_due(true)` this evening each was blocked only by "may not arm before 2026-09-22", and neither rule has ever filed a row, so the clean-days gate will not stop them. Armed, `DR15` files each cross-asset seat as a critical row, which nobody is told about and which would unmeet the release gate's "no open critical" condition.
- No staff surface shows Diamond reconciliation. The Diamond readers are service-role only. `/financial-health`, `/financial-incidents` and `/financial-alerts` read chip sources. `fn_ca_daily_attestation`, `fn_ca_incident_escalation_tick` and the estate digest (`.github/scripts/estate-digest.mjs`) have no Diamond section, and no rule under `infra/monitoring/` mentions Diamond.

**Does not exist.** A push for a critical Diamond incident, Diamond wording in the push, a staff view of Diamond health, trial balance, register and open incidents, and a test that keeps the no-lockout property true.

**Not verified.** Whether the chip conservation sweeps misread a Diamond event. `fn_tournament_money_conservation` (hourly) and `fn_ca_tournament_conservation_confirm` (every ten minutes) read chip tables (`wallet_transactions`, `rake_records`, `chip_ledger`) and name no asset, while `fn_payout_guarantee_check` and `fn_ca_tournament_escrow` are Diamond-aware. No funded Diamond event has ever run, so I cannot say. The worst case visible in source is a warning in `financial_alerts`, which does not become an incident and locks nothing; it belongs to Phase 11 or to a rehearsal. I also did not trace what the engine does to one table after a refused Diamond hand; that is per-table machinery shared with chips.

## Ordered build list

The smallest set that closes the three lines, one pull request each, in order of what an open arena would miss first. Items 2, 3, 4, 6 and 7 carry a migration, so under the estate's rules each is rehearsed, applied by the owner, then pushed.

1. **Land PR #4969.** Not new work, but blocking: it carries the applied migrations that created `ca_diamond_incidents.resolution`, and items 2 and 3 change that table.
2. **Diamond alerts reach a phone.** A critical `ca_diamond_incidents` row raises a drift incident recorded in diamonds, with its amount as the discrepancy and a dedupe key stable per rule, so a condition that is re-filed every hour pages once and the existing recipient registry, dedupe, escalation and push carry it. `fn_ca_raise_drift_incident` learns a currency and `fn_ca_incident_notify` prints it instead of "chips". `DiamondCustody`'s alerts carry the amount in doubt. `fn_ca_incident_dashboard` shows a Diamond incident to platform staff and recipients only. Law: a critical Diamond row produces exactly one notification to the registry, and a warning produces none.
3. **Diamond incident review.** A platform-staff reader over `ca_diamond_incidents` by status, rule and severity, and a review door (acknowledge, comment, resolve with a written reason, reopen) that records the reviewer, with an append-only trail in the shape of `ca_incident_events`. Closing a whole rule family in one act with one reason belongs in it; that is how the 6,969 week-old warnings get a person's answer.
4. **Diamond staff doors, audited.** New platform-staff doors in the `fn_poker_diamond_*` family: edit an empty Diamond cash table (name, stakes, buy-ins, seats), re-proved by `fn_poker_diamond_plain_cash_table`; close a Diamond cash table, refused while any seat holds custody; remove a player from a Diamond event through `fn_ca_unregister_tournament_player_exact`, which already sends a Diamond entry home; and a staff door onto the existing cancellation. Widening `fn_can_create_games` instead would hand Diamond games to club roles and undo Phase 2, and the chip doors in the table above need no Diamond branch if the staff surface calls these doors directly; if a chip screen ever has to work for staff on a Diamond game, the `atomic_cancel_tournament` branch is the pattern, applied by asserted substitution against the pins in the appendix. Every Diamond configuration door, the five that exist included, records its actor and files one audit row with the state before and after. A home for it exists: `table_settings_changes` (`table_id`, `club_id`, `changed_by`, `before`, `after`) holds 0 rows and is written today only by the chip door `fn_update_table_bomb_settings`; `admin_audit_log` is what the operator console writes.
5. **Engine staff authority at a Diamond table.** `authorizeTableAdmin` in `server/src/handlers/admin.ts` admits platform staff at a Diamond table, so pause, resume and kick work in the arena. Server only.
6. **Diamond counts and roster.** One reader that returns members, online, seated and tables for the arena, each NULL when it cannot tell, using the population rule above (fixtures out, horses in). A Diamond branch in `ca_club_members_summary` and `ca_club_members_page`, or a Diamond roster reader, so the Players door lists arena players with no hierarchy, fee or chip-wallet fields.
7. **Diamond adjustment executor.** One platform-staff door that settles an approved `diamond_wallet` or `diamond_house` row of `ca_manual_adjustments` exactly once, through the register and the journal, and marks it settled; platform-staff wrappers for propose, approve and reject. Waits on decision 2 below.
8. **The staff surface.** One platform-staff route behind `PlatformStaffGuard`, linked from `FinancialAdminHub`: Diamond tables and events with open, edit, close, cancel and remove-player; the incident board with review; the health, trial balance and register figures; the adjustments queue. The Players page gets its Diamond variant, and the counts go where Dan puts them. Depends on items 3, 4, 6 and 7.
9. **A law that only a person moves the switches.** A test that fails if a migration defines a function that writes `cash_games_enabled` or `tournaments_enabled`, or if `server/src` writes `ca_arena_settings`. It pins what is true today.

## Decisions for Dan

These are not builds. Each is his to make, and the build list says where it waits.

1. **Where the arena shows its counts.** On 2026-09-11 he set the lobby rail to "JUST 'ACTIVE' AND THE NUMBER UNDER IT. AND THE FREE ROLL STARTS CLOCK." The programme line asks for member, online, seated and table counts. The build list assumes members, online and at-tables go on the Players page and the rail stays as he set it. If he wants them on the card or the rail, item 8 needs to know.
2. **What pays for a Diamond correction.** A credit to a player can come from the Diamond house, whose balance is 0 today and would have to be funded first, or be minted as new diamonds recorded as an adjustment. CLAUDE.md 10.9's "absorbed by the house" was written for chips. Item 7 waits on this.
3. **Whether a Diamond adjustment needs a second person.** `ca_manual_adjustments` already forbids approving your own proposal; the console's mint path runs with approvals off. Three staff accounts exist, so a second approver is possible. Turning `approvals_enabled` on is his call.
4. **Whether staff may post in the Diamond lobby.** Announcements, the tagline and the lobby message are refused for the arena today, and no Diamond door exists. Leave it off, or add it to item 4.
5. **Who reviews Diamond incidents.** One recipient is active today, at platform scope. Once item 3 exists somebody owns the 6,994 open warnings, including whether the week-old `DR2`, `DR5` and `DR7` families are closed in one act with one reason.

## Observed in passing, for lines 1, 2 and 6

- Line 1, statistics scoped to Diamond. The migration that gives a Diamond hand its own statistics, `20260920065728_a_diamond_hand_keeps_its_own_statistics.sql`, exists only on the local branch `agent/cw-diamond-stats/needs-apply/a-diamond-hand-keeps-its-own-statistics` (commit `989b20503a`) in the canonical clone. The branch is not on `origin` and the migration is not in `schema_migrations`. PR #4955 describes it and pins the client half against it.
- Line 6, no agent panels. The Players page the arena now links to carries the chip roster's Agents, Admins and My Downline views; items 6 and 8 remove them for Diamond.

## Appendix: pins read 2026-09-21

md5 of `pg_get_functiondef` for the functions a builder would edit or wrap, read during this audit. They change whenever anyone redefines the function; read them again before relying on them.

| Function                                        | md5                                |
| ----------------------------------------------- | ---------------------------------- |
| `fn_can_create_games(uuid, uuid)`               | `a79e8264252e7f05bc2103a6ee8718f1` |
| `is_club_admin(uuid, uuid)`                     | `eb0b2e9bae84dbf1075f8d995c336e56` |
| `fn_admin_remove_tournament_player(uuid, uuid)` | `c3ee54a17e11826cc4e7c013899a0fed` |
| `fn_execute_managed_game_command`               | `5a98aec56bdd4815393ab20cc202d4ae` |
| `fn_update_managed_game`                        | `8616bc6b7c535f0f6eebb97fb0204ad4` |
| `fn_close_managed_game`                         | `59ba6d93b5ae52e4dc38dc0599a287de` |
| `fn_owner_start_tournament_now`                 | `36679aa9611f43d09eda38f5b145a1bb` |
| `atomic_cancel_tournament`                      | `53ab3f9da34ec84247b35426147f2515` |
| `fn_poker_diamond_open_cash_table`              | `f45465677a693da31100898b465b8210` |
| `fn_poker_diamond_set_table_straddle`           | `ce002ad2be7891a84f489d58a1db24f9` |
| `fn_poker_diamond_set_table_run_it_twice`       | `6ff7bcb1b51da39d7f1f998605b56ebe` |
| `fn_poker_diamond_set_table_bomb_pot`           | `c1ebcba27664f73cec418400f33d22c1` |
| `fn_poker_diamond_create_tournament`            | `6d82bede82370a9cc15d71b5ce1699f5` |
| `fn_poker_diamond_tournament_cancel`            | `ee91eac08d166e096ca5faa8c52ff296` |
| `fn_poker_guard_arena_structure`                | `f17675dd0b647abda7b0b9d8772c9c0e` |
| `fn_ca_diamond_incident`                        | `184127186e82dcfecd7d0dac92310fab` |
| `fn_ca_diamond_health_watch`                    | `8189230a24fa058a634bee6f4130b12c` |
| `fn_ca_diamond_trial_balance_watch`             | `a8aa11f601f50b9a1bebbab66e777081` |
| `fn_ca_diamond_snapshot`                        | `95b4c77768db15b19a088c5642ad47c8` |
| `fn_ca_incident_dashboard`                      | `bc12882b4aaa9c4a96e1192de6a92d48` |
| `fn_ca_incident_action`                         | `1017987e76a8327b7d379d795a317401` |
| `fn_ca_incident_notify`                         | `ad9a51b31ec9d8f52a416e5e77a033a2` |
| `fn_ca_financial_alert_to_incident`             | `00a43ae03ab12cec9505e2bfed71d937` |
| `fn_ca_raise_drift_incident`                    | `a6df5f2eef07aa3f606db79d93944590` |
| `fn_ca_propose_manual_adjustment`               | `da73a86110bccc223923e61fc67f12c8` |
| `fn_ca_approve_manual_adjustment`               | `87c480eddf6aa3f9b0c0a6c51b9b78ef` |
| `fn_ca_reject_manual_adjustment`                | `7e9450272c980feb7681144696d75c42` |
| `fn_ca_mint`                                    | `da9429ce6483c47c7d536582433a1edd` |
| `fn_ca_burn`                                    | `01892d172b17e45bc8a47f76d3e5a564` |
| `ca_club_members_summary`                       | `784a8511f0d5f60838ba9ddf35beadc5` |
| `ca_club_members_page`                          | `7d79a33da2d276056ca06f75d4130b2b` |
| `get_club_players_playing`                      | `d0deada158658ba9e1f88cbfba85c6ae` |
| `fn_is_platform_admin`                          | `ed89787c7b832e76a886734e16a27c3d` |
