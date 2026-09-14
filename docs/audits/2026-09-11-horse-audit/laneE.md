# Lane E - the database side of the horse triggers (audit 2026-09-11, 14:00-15:10 UTC)

No engine TypeScript edited. Output: this file and two migration files under `_audit/laneE-migrations/`
(NOT applied). Everything below was read from `pg_proc.prosrc` on production (read-only SQL), the
Supabase `postgres_logs` stream (24 h window), and the repo's `supabase/migrations/`. Every number is
a measurement taken in the window above unless dated otherwise.

## The two DB defects, up front

1. **P1 - every Midway horse that busts is stood up: the rebuy door debits the UNION ROW's treasury,
   which holds 0.50.** `fn_horse_fund_from_treasury` (both layers) resolves the treasury as
   `tables.club_id`; every Midway cash table's `club_id` is `fade0000-...` (the union's own club row),
   whose `chip_treasury` is 0.50 (JAQK 937,497.23, SHARK 885,816.01). `chip_ledger category =
'horse_funding'`: DSS 449 rows / 53,410 chips in 24 h, and 117-4,683 rows every day since 09-01;
   Midway Union 81 rows / 8,291 chips on 09-02 and NOTHING since (that is the 0.50); JAQK and
   SHARK 0 rows ever. Midway horse cash exits in 24 h: 484 (310 with a zero stack) vs DSS 346 (233) -
   DSS busts reload through the door, Midway busts hit `insufficient club treasury` -> `declined` ->
   `releaseBustedSeat(horse, 'busted_unfunded')`. Migration file 1.
2. **P2 (latent, would strand 38 horses on the next run) - the stake-band assigner projects the
   merit ladder onto the PLATFORM's bands, not the horse's host's.** Migration file 2.

## 1. `atomic_table_buyin` and every trigger on `table_seats` that can refuse a horse

Read in full: `atomic_table_buyin` (wrapper) + `atomic_table_buyin_before_maintenance_announcement_gate`
(core), all 39 triggers on `table_seats` (list below), `fn_concurrent_game_load`,
`fn_enforce_four_table_limit`, `fn_cash_rejoin_floor`, `fn_nit_check`, `fn_refuse_seat_on_closed_cluster_table`,
`fn_refuse_new_entries_while_frozen`, `fn_refuse_while_frozen`, `fn_platform_frozen`,
`fn_entry_purchases_frozen`, `fn_stamp_seat_club`, `fn_stamp_seat_occupancy`,
`fn_stamp_active_seat_game_scope`, `fn_require_live_seat_parent`, `trg_seat_parent_keys_match`,
`fn_ca_guard_seat_creation`, `fn_ca_refuse_restricted_entry`, `fn_ca_reject_automated_user_club_row`,
`fn_ca_house_board_allows_automation`, `fn_guard_retired_club_mutation`, `fn_no_live_seat_on_finished_game`,
`fn_poker_guard_chip_seat`, `fn_cash_game_roster_track`, `fn_caller_is_engine`, `fn_caller_session_is_live`,
`fn_claim_entry_purchase_receipt`, `fn_assert_cash_chip_purchase_table`, `fn_seat_club_for_user`
(+`_membership_unchecked`), `fn_ensure_club_wallet`, `atomic_seat_cashout_locked`,
`atomic_credit_wallet_and_log`. Constraints on `table_seats`: `one_committed_seat_per_game_player`
UNIQUE (user_id, active_game_scope) DEFERRABLE, `active_seat_requires_game_scope`,
`active_seat_requires_open_parent`, `table_seats_table_id_seat_number_key`. The 2026-09-09 composite
FKs are gone (`active_seat_game_scope_parent`, `live_seat_parent_cannot_close` are now trigger
`zzzzz_seat_parent_keys_match`, raising the same constraint names).

**The cash door, in order** (a horse's `seatHorse` call, service_role): hundredths check -> shared
advisory 530090 -> session live (engine: always) -> receipt claim on `p_idempotency_key` ->
`IDEMPOTENCY_RECEIPT_UNBOUND` if the key is in the legacy `transaction_idempotency_keys` -> `PLATFORM_FROZEN`
(`fn_entry_purchases_frozen`, wider than `fn_platform_frozen`: from :53) -> `CASH_PURCHASE_ONLY` /
`IS_TEMPLATE` -> diamond branch or the core: template, amount, table min/max, `fn_cash_rejoin_floor`
(`VPIP_BARRED:<s>` or `BUYIN_BELOW_FLOOR`), blacklist, VIP, `fn_nit_check` career VPIP (`NIT_GAME`),
`Player already seated`, table lock, `TABLE_SIZE`, `SEAT_RESERVED` (waitlist holds, then pending moves -
the 2026-09-10 rule), `TABLE_CAP_REACHED` (cash seats only, >= 4), `fn_seat_club_for_user` -> `No club
wallet resolves`, `UPDATE club_members ... chip_balance >= p_amount` -> `Insufficient club chips`,
DELETE the vacated row at that seat number, INSERT -> triggers: `fn_enforce_four_table_limit`
(`FOUR TABLE LIMIT`, cash + tournament seats + bookings inside 60 min, per-account advisory lock),
`fn_refuse_seat_on_closed_cluster_table` (`TABLE_CLOSING` on lifecycle breaking/closed, `ALREADY_IN_GAME`),
`fn_require_live_seat_parent` (`CLOSED_TABLE_REJECTS_ACTIVE_SEAT`, `CASH_PURCHASE_ONLY` when the parent
key is not 'cash'), `fn_stamp_active_seat_game_scope` + the UNIQUE (one chair per game), freeze guards,
restriction guard, house-board guard, retired-club guard.

**Agreement with the engine mirror** (HorseGameLoad / HorseRejoinConstraints / HorseStaleTable /
HorseBuyInRefusal, re-read today): the four-game arithmetic is the one lane A verified (statuses,
60-minute booking window, seat-first dedupe, `p_exclude_table_id`); `fn_cash_rejoin_floor` keys on
club + variant + sb + bb and `HorseRejoinConstraints` reads the same row columns (`barred_until`,
`required_stack`, `expires_at`); `HorseStaleTable.SEATABLE_LIFECYCLES` excludes breaking/closed exactly
as the trigger does. All 13 refusal literals in `classifyBuyInRefusal` match the production text.
Two literals the engine folds into `refused`: `PLATFORM_FROZEN` (the `'frozen'` token exists and is
never produced) and `ALREADY_IN_GAME` (9 in 24 h). P3, lane A's file (`HorseBuyInRefusal.ts` L44-57):
add `if (m.includes('PLATFORM_FROZEN')) return 'frozen'` and an `'already_in_game'` token.

**What the door refused in the last 24 h** (postgres_logs, ERROR, grouped, UUIDs/numbers collapsed):

| refusal                                                                                                                                                                                                                                            | n     | notes                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FOUR TABLE LIMIT ... may not ENTER another` (booking cap, `tournament_players`)                                                                                                                                                                   | 4,451 | lane D #9 (30 vs 60 min horizon); engine fix in HEAD                                                                                                                                            |
| `FOUR TABLE LIMIT ... may not TAKE another` (`fn_enforce_four_table_limit`, all from the buy-in INSERT)                                                                                                                                            | 97    | bursts of 3-5 in one second per horse, see below                                                                                                                                                |
| `duplicate key ... table_seats_table_id_seat_number_key`                                                                                                                                                                                           | 88    | two seaters chose the same chair; the door deletes only a VACATED row at that number                                                                                                            |
| `TABLE_SIZE: table is full`                                                                                                                                                                                                                        | 82    | race, same as lane A measured                                                                                                                                                                   |
| `deadlock detected`                                                                                                                                                                                                                                | 47    | none on the seat door: `fn_project_hand_side_effects` / `ca_hand_player_idx`, `club_wallets` rake, `fn_refresh_player_stats`; one on `fn_seat_horse_in_seat_first_game` vs the booking cap lock |
| `Player already seated at this table`                                                                                                                                                                                                              | 12    |                                                                                                                                                                                                 |
| `ALREADY_IN_GAME`                                                                                                                                                                                                                                  | 9     |                                                                                                                                                                                                 |
| `TABLE_CLOSING`                                                                                                                                                                                                                                    | 7     |                                                                                                                                                                                                 |
| `TABLE_CAP_REACHED`                                                                                                                                                                                                                                | 5     |                                                                                                                                                                                                 |
| `SEAT_RESERVED ... moving here`                                                                                                                                                                                                                    | 5     | the 2026-09-10 pending-move reservation                                                                                                                                                         |
| `VPIP_BARRED`                                                                                                                                                                                                                                      | 2     | 66 horses barred right now (87 rows), 0 humans on the floor                                                                                                                                     |
| `PLATFORM_FROZEN`                                                                                                                                                                                                                                  | 3     | all inside a break                                                                                                                                                                              |
| `BUYIN_BELOW_FLOOR`                                                                                                                                                                                                                                | 1     |                                                                                                                                                                                                 |
| `NIT_GAME`, `Insufficient club chips`, `No club wallet`, `CLOSED_TABLE_REJECTS`, `CASH_PURCHASE_ONLY`, `one_committed_seat`, `SEAT_OCCUPANCY_IMMUTABLE`, `IDEMPOTENCY_*`, `AUTOMATED_PLAYER_HOUSE_BOARD_ONLY`, `PLAYER_RESTRICTED`, `CLUB_RETIRED` | 0     |                                                                                                                                                                                                 |

The 97 seat-side FOUR TABLE LIMITs are a race the DB is right about, not a rule disagreement:
horse `4845cbbb` at 14:06:21 held a tournament seat (14:03:12), a seat-first seat + its booking
(14:06:12, counted once), and two cash seats the fleet had just bought (14:06:14, 14:06:20) = 4; the
fleet then tried five more tables inside one second (14:06:21.6-22.6) and was refused five times. The
seat-first seat landed after the cycle's snapshot; `seatOne` increments `horseTables` only on success,
so a refused horse stays a candidate for every later table in the same cycle. P3, lane A's file
(`HorseFleetManager.ts` ~L3193, the refusal callback of `seatHorse`): on `four_game_limit` or
`table_cap`, pad `horseTables.get(horse.id)` to `MAX_CONCURRENT_GAMES` (or add the id to a
`cappedThisCycle` set consulted by the candidate filter) so the remaining tables skip it. Cost today is
~5 wasted locked RPCs per race, 97 per day.

`ca_broke_seat_sightings`: 0 rows in 24 h. `ca_seat_guard_dryrun`: 0 rows in 24 h. `horse_error_log`:
0 rows EVER (`max(created_at)` NULL) - no engine writer exists (only `HorseDataLedger.ts` names it as a
table to report on). P3 dead table; nothing reads it for a decision.

`fn_ca_house_board_allows_automation` legacy array: the comments name `a41434bb` as JAQK and `a0000000`
as SHARK; `clubs` says the reverse (a41434bb = SHARK CLUB, a0000000 = Club JAQK). Cosmetic, both ids
are in the array.

## 2. `fn_seat_club_for_user` / `_membership_unchecked` - keep the DB rule, no migration

Confirmed: the held-seat clause joins `tables t2 ON t2.union_id = v_union` with status not in
(closed, completed, cancelled, finished) and no `tournament_id IS NULL`, so a seat at any of the 510
open Midway tournament tables (89 running, 421 waiting) binds the cash wallet. The DB rule is the
right one: Dan 2026-08-21 (migration `20260821_active_counts_one_club_at_a_time.sql`, verbatim) is
"Horses can only play inside ONE club at a time. They can't play both clubs at once", and HALF 1 of
that same migration attributes EVERY seat, tournament included, to `coalesce(ts.club_id, t.club_id)`
for the active count. A cash wallet that ignored the tournament seat would put one horse in two clubs
on the count Dan was reading. Lane A #2 already made the engine mirror this. Measured cost of the
binding today: 335 horses hold a union TOURNAMENT seat as their oldest union seat; 0 of them have
that wallet below 50 chips, 0 below 200 (min 4,721.70, median 47,066.57); 101 are bound by a cash
seat, min 13,164.32. No horse is refused `Insufficient club chips` by the binding (0 in the log).
Tournament seats with a NULL `club_id` at union tables: 0 (the earlier "113" was a LEFT JOIN artefact
over empty tables, re-measured).

## 3. Fleet state / heartbeat / financial alert - store what the engine sends

`fn_ca_fleet_state_upsert(p_rows jsonb, p_beat jsonb)`: `state` vocabulary idle / seated / playing /
sitting_out / busted / suspended / retired / unknown (anything else -> 'unknown'); one row per horse
per call (last mention wins); `detail` stored verbatim when it is a JSON object, so lane A's
`gates{}`, `horses_seated_cash`, `booked_out` need no migration. The latest beat (14:45:15 UTC,
cycle 6.6 s, 1000 total, 699 seated, 140 tables, 0 seeded) carries only the OLD keys
(`disabled_game_tables, disabled_games_read_failed, opening_feeders, overrun_ticks, reason,
stale_door_read_failed, stale_tables_skipped, withheld_tables`) - lane A's build is not deployed yet.
`horses_idle`, `horses_stuck`, `seats_released` are NULL on every beat by the engine's own
documented choice (HorseFleetManager L3868-3886). `ca_horse_fleet_state`: 1000 rows all updated < 2
min ago; 697 seated agree with a live seat, 294 idle agree, 9 disagree (4 seated-with-no-seat,
2 idle-but-seated, 3 at a different table) - one 30-second cycle of lag at 5.4 seat moves per
minute. Nothing in the engine reads the table for a decision (grep: only HorseDataLedger).
`fn_raise_server_financial_alert(p_severity, p_source, p_message, p_context DEFAULT '{}',
p_dedupe_key DEFAULT NULL, p_entity_id DEFAULT NULL)`: the engine's three call shapes (4, 4, 5 args)
all bind; dedupe on `context->>'dedupe_key'`; 60-per-minute-per-source throttle returns NULL (the
caller sees no id - fine). 0 horse/fleet/stable/cluster alerts in 24 h. Repo migration
`20260910062115_server_financial_alerts_accept_an_entity_id` has no `schema_migrations` row but its
body IS live (the signature above) - applied without a history row, along with 9 other 09-10 files
(`20260910022036, 023541, 030442, 035245, 051125, 053005, 053723, 070406, 132723`); production state
is what was audited, not the history.

## 4. Lanes and stake bands vs HorseBehavior.ts

`fn_assign_horse_lanes`: 33% events / 33% cash / rest both by `md5(id)` rank - the split HorseBehavior
L150 quotes. Live: events 329 / cash 329 / both 342 (= a run at 998 horses; the two newest carry
'both'); every horse has a lane. `fn_cash_stake_band` (<= 0.5 micro, <= 2 low, <= 6 mid, else high) ==
`stakeBandForBigBlind`. `fn_project_stake_band` == `projectStakeBandOnto` statement for statement
(downward, then the lowest available, then the band itself). The assigner runs ONLY from
`HorseLaneLoader` when >= 25 horses lack a band (0 today) or by hand - there is no cron
(`cron.job` has one horse job, `ca-horse-claim-due-minute`); the "re-ranks every 30 minutes" in
`stakeBandFor`'s comment is not true of anything.

**Finding 2 (P2, latent): `fn_available_stake_bands()` is platform-wide.** Enabled `cash_games` by host:
DSS micro 25 / low 12 / mid 4 / high 1 (NLH 25/50 Classic, dormant, one open 0/9 table - lane B #18);
Midway micro 34 / low 21 / mid 12 / high 0. So `{micro, low, mid, high}` is "available" and the top 11%
by bb/100 across the whole fleet are minted 'high'. Simulated read-only with the production body
against today's `player_stats`: the next run writes 'high' on 38 Midway horses and 18 DSS horses.
A Midway 'high' horse has no game on its host at all and `stakeBandAllows` is a hard gate whose
fallback only fires when the band is empty platform-wide (it is not) - the exact 2026-09-05 strand
(100 'high' horses) that `20260906093032` was written to end. Band distribution today: DSS micro 84 /
low 183 / mid 149, Midway micro 113 / low 329 / mid 138, 0 'high' - the last run predates the 25/50
row (created 09-06, toggled 09-11 01:03). Migration file 2 makes `fn_available_stake_bands(p_host uuid
DEFAULT NULL)` per host (`coalesce(union_id, club_id)`, the key `StableHandSnapshot.enabledGamesFor`
uses, plus `closed_at IS NULL`) and the assigner project each horse onto the union of its hosts'
bands. Simulated with the new logic: Midway 'high' 38 -> 'mid'; DSS 18 stay 'high' because DSS DOES
have an enabled high game - whether that 25/50 row should be enabled at all is Dan's 09-03 "close any
tables over 2/5" (a `cash_games` config row, lane B #18), not this migration's call; with it disabled
those 18 project to 'mid' by the same function. Engine belt (lane A's file, `applyStakeBandSupply` /
`effectiveStakeBandFor`): publish supply per host and project against the horse's own host, the same
shape lane C #6 described for `stakesWithAGame`.

## 5. `fn_cash_cluster_tick` / `fn_cash_clusters_tick_all` and horse demand

Read all 39 KB. `p_eligible` is keyed by `main1_table_id`; ClusterController sends the fleet's whole
`eligibleCounts()` map (every table id with n > 0) and the tick reads Main 1's key - the fleet's
`allocateBuyers` hands a full Main 1 a `FULL_TABLE_BUYER_PROBE` of 2 (lane C verified), so a game with
Main 1 full reports its demand on the key the tick reads. OPEN: `buyers = waitlist + eligible`,
fires only with every seat of every live/opening table taken, no feeder opening, under `cap_mains + 1
(+1)`, two minutes after an abandon; 2 buyers -> feeder + `promote_pending`, 1 -> 60 s hold then a
5-min rest; an opening feeder with nobody after 6 min is abandoned; dormant = seated 0 AND eligible 0,
corrected regardless of `enabled`. Horses and humans are one number; nothing in the tick refuses a
horse buyer a human buyer would get (10.5). 24 h of `cash_cluster_events`: feeder_opened 149,
feeder_live 136, feeder_abandoned 12, table_opening_hold 253, hold_expired 120 (one-buyer holds -
the fleet's one-horse-per-cluster-per-pass allocation is what produces a 1), break started/completed
135, move_planned 7,918 / seat_moved 7,826 (5.4 must-moves per minute - the design's cost of feeders
draining into mains), game_dormant 1,477 / game_woken 1,468 (a state flag flapping ~15x per game per
day; cosmetic), controller_tick_error 4 (3 lock timeouts, 1 pldbgapi2). Deferred/rested handling and
the 5.5 s budget are as documented. No defect.

## 6. Horse funding: wallets are fine, the Midway TREASURY door is not

Wallets: with band-cheapest buy-in per host (DSS micro 0.80 / low 40 / mid 200; Midway micro 4 /
low 40 / mid 200), **0 horses are below one buy-in and 0 below five, in every club** (DSS min 6,378.95,
JAQK min 11,477.93, SHARK min 4,706.70, union-row wallets 24,613+). No top-up path is needed and none
fires: `fn_seed_horses_to_floor` (treasury -> wallet floor, all-or-nothing) has no engine caller and
no cron; `mass_fund_horses` is closed in the registry; `chip_ledger` shows no wallet funding category
for horses in 24 h, only `horse_funding` (treasury -> stack). `fn_register_horse_for_tournament`: lane
D read all three layers; unchanged since (md5 not re-checked, pg_proc lengths match lane D's read).

**Finding 1 (P1) - migration file 1.** `fn_horse_fund_from_treasury` -> `_before_maintenance_gate`:
`SELECT club_id FROM tables WHERE id = p_table_id` is the treasury; for the 283 open Midway cluster
tables that is `fade0000-...` (the union row, treasury 0.50). Every other money door resolves the club
the SEAT represents: `atomic_credit_wallet_and_log` (cash-out) reads `table_seats.club_id` first,
`atomic_table_buyin` stamps it, the addon reads it, the engine's rebuy roll reads it (lane B #15).
The fix resolves `v_fund_club = coalesce(seat.club_id, table.club_id)` in both layers, locks/debits/
journals that club (`chip_transactions.club_id`, `chip_ledger.club_id` + `from_entity_id`, the replay
identity check), and keeps the response's `club_id` = the table's club because the deployed engine
verifies `data.club_id === tableInfo.club_id` (wallets.ts L57) - returning the funding club there would
turn every Midway reload into `unknown` AFTER the chips moved and replay that mismatch on every retry
of the same op id. `treasury_club_id` is added to the receipt. Engine follow-up (lane B's file,
`wallets.ts` autoRebuyHorse): when `data.treasury_club_id` is present, require it to be the seat's
wallet club (`readSeatWalletClub`) and print it in the "rebought" line. `fn_horse_seat_from_treasury`
has the same `tables.club_id` shape; it has no engine caller (grep) so it is left and noted.

## 7. RLS / grants

All 163 RPC names the engine calls (`rpc('...')`, single and multi-line, non-test files) exist in
`public` and `service_role` has EXECUTE on every one; the horse doors per overload:
`atomic_table_buyin` (svc + authenticated), `fn_register_horse_for_tournament` x2, `fn_seat_horse_in_
seat_first_game`, `fn_horse_fund_from_treasury`, `fn_cash_cluster(s)_tick(_all)`, `fn_ca_fleet_*`,
`fn_assign_horse_*`, `fn_raise_server_financial_alert`, `fn_cashout_seat_occupancy`, `fn_offer_open_seat`,
`fn_cash_seat_*`, `fn_nit_*`, `cash_tables_needing_engine`: service*role EXECUTE true, all
SECURITY DEFINER owned by postgres. Every REVOKE in the 09-04..09-11 migrations that names a horse RPC
revokes PUBLIC/anon/authenticated and re-grants service_role; none touched service_role on a function
the engine uses. Log: 0 `permission denied for function fn*<horse>`in 24 h (the 37x3 challenge
functions and 20x`fn_generate_all_credit_invoices`are browser-role calls, not horse paths).`fn_caller_is_engine()`=`coalesce(auth.role(), 'service_role') = 'service_role'` - the engine passes
every "engine only" gate in the doors above.

## 8. Stale data

- `profiles.horse_status`: 1000 'available', 0 other values. `fn_a_benched_horse_stays_benched` keeps a
  'disabled' one disabled unless `app.horse_release = on`; nothing is benched.
- `ca_horse_fleet_state`: 9 of 1000 disagree with live seats, all one cycle of lag (item 3).
- `stable_hand_horse_state`: 1000 rows; 302 reset today (Chicago), 297 never sat (NULL reset, 0
  minutes); `active_seat_count` disagrees with live cash seats on 192 rows (the column is the
  executor's per-cycle snapshot, not a live count; nothing decides on it); 60 rows at or past their
  daily cap ALL carry a stale `counters_reset_on` (09-05..09-10) and are read as 0 by
  `dailyCapReached` (lane C verified the structural reset); minutes accrue past the cap (max 1,040 on
  09-09) because only a NEW sit is refused. **`updated_at` is 2026-09-04 08:42 on every row** - the
  upsert never sets it (column default fires on INSERT only): P3, lane C's file (`StableHandState.ts`
  upsert row: add `updated_at: new Date().toISOString()`), same defect as lane C #10's `tagged_at`.
- `cash_rejoin_constraints`: 130 live rows, 87 bars in force on 66 horses (max floor 3,448.58); the
  engine mirror reads the same rows (lane A). Consistent with 0 humans on the floor.
- `cash_games`: `NLH 25/50 Classic` (DSS) enabled + dormant + one open 0/9 table = the 'high' supply
  in finding 2 and lane B #18.
- Live seats at closed/deleted tables: 0. Live seats with NULL `club_id` at union tables: 0.
- `fn_emergency_block_deep_stack_horse_membership` exists with NO trigger bound - dead function.

## Migrations (files only, none applied) - `_audit/laneE-migrations/`

1. `a_horse_rebuy_is_funded_by_the_club_its_seat_represents.sql` - finding 1. Replaces both layers of
   `fn_horse_fund_from_treasury` (bodies otherwise byte-identical to production, md5s in the header),
   restates the grants, annotates `ca_money_rpc_registry`, self-checks the grants and the resolver
   line. Idempotent. Apply once outside :50-:03 after reserving a version with
   `node scripts/new-migration.mjs`. Expected effect within minutes: `chip_ledger` rows with
   `category = 'horse_funding'` and `club_id` in (JAQK, SHARK); `busted_unfunded` releases on Midway
   stop. Not a repair: nobody is back-paid (a stood-up horse kept its wallet).
2. `a_stake_band_is_projected_onto_the_games_the_horses_own_host_deals.sql` - finding 2. DROPs the
   zero-argument `fn_available_stake_bands()` (only caller is the assigner rewritten in the same
   transaction; a call with no args still resolves to the new `(uuid DEFAULT NULL)` form), per-host
   projection in `fn_assign_horse_stake_bands`, grants restated, self-checks. The new CTE shape was
   executed read-only against production (results in item 4). Note it is the DROP that makes this
   DDL non-trivial; one transaction, one reload.

## Engine edits described for other lanes (not made here)

- `wallets.ts` autoRebuyHorse (lane B): verify `data.treasury_club_id` against `readSeatWalletClub`
  when present; log it.
- `HorseFleetManager.ts` seatOne refusal callback (lane A): mark a horse capped for the cycle on
  `four_game_limit` / `table_cap` (97 wasted locked RPCs a day).
- `HorseBuyInRefusal.ts` (lane A): `PLATFORM_FROZEN` -> `'frozen'`, `ALREADY_IN_GAME` -> a token.
- `HorseBehavior.applyStakeBandSupply` / fleet publisher (lane A): per-host supply.
- `StableHandState.ts` (lane C): set `updated_at` on the upsert.

## Verified - no issue (do not re-audit)

- `atomic_table_buyin` wrapper idempotency: receipt claim before the legacy-key check; the core's
  `transaction_idempotency_keys` insert is the ONLY guard inside it; a replay returns void without
  touching money; an aborted first attempt leaves nothing behind (single transaction).
- `fn_caller_session_is_live` / `fn_caller_is_engine`: service_role short-circuits both.
- `fn_ensure_club_wallet` is a boolean PERFORMed and discarded; the real membership check is the
  `UPDATE club_members ... chip_balance >= p_amount` (a missing row reads as insufficient chips).
- `TABLE_CAP_REACHED` (cash seats at non closed/deleted tables >= 4) is a strict subset of the trigger's
  count; the trigger's `t.status <> 'closed'` vs the door's `NOT IN ('closed','deleted')`: 0 live seats
  at any table whose status is outside waiting/running/active or `is_deleted`.
- `fn_stamp_seat_club` re-resolves on INSERT with `p_preferred_club = NEW.club_id`; identical answer to
  the door's own resolution (held seat, then preferred when a member, then hash for horses).
- `fn_stamp_seat_occupancy` (new id per occupancy), `fn_stamp_active_seat_game_scope` (`cluster:<id>`
  / `table:<id>`; initialises an unscoped parent inside the admission), `fn_require_live_seat_parent`
  (`CASH_PURCHASE_ONLY` only when `app.money_path` is a cash path AND the parent key is not 'cash'),
  `trg_seat_parent_keys_match` (FOR KEY SHARE on the parent, same constraint names as the dropped FKs):
  all pass for a cash seat at an open cluster table; 0 raises in 24 h.
- `fn_refuse_new_entries_while_frozen` (cash INSERT / revive only; `pg_try_advisory_xact_lock_shared`
  re-entrant under the door's shared lock) and `fn_refuse_while_frozen` (service_role bypass): 3
  PLATFORM_FROZEN in 24 h, all inside a break.
- `fn_ca_guard_seat_creation`: the engine bypasses (`fn_caller_is_engine`); `atomic_table_buyin` also
  declares `app.money_path`. `fn_ca_refuse_restricted_entry`: hot path is one partial-index probe;
  `restrictions_enforced` observations only. `fn_ca_reject_automated_user_club_row`: DSS, JAQK, SHARK,
  Midway are all in `fn_ca_house_board_allows_automation`'s legacy array (262 Midway + 183 DSS horse
  seats live). `fn_guard_retired_club_mutation`: no retired club on any horse path.
- `fn_nit_check` at the door (career VPIP only when `nit_game` is on): 0 `NIT_GAME` in 24 h.
- `fn_cash_game_roster_track`: a leave cancels the pending move and the swap partner; a declared move
  (`app.cash_seat_move = on`) is not a leave; WARNING-not-RAISE on any error.
- `one_committed_seat_per_game_player` + `app.cash_seat_move`: 7,826 executed must-moves in 24 h, 0
  unique violations in the log.
- `atomic_seat_cashout_locked` -> `atomic_credit_wallet_and_log` credits `table_seats.club_id` (the
  seat's wallet), never the table's club; tournament stacks never credit; `CLUB_CREDIT_DESTINATION_
MISSING` aborts rather than minting. `fn_cash_session_open` / `_add_baseline`: no RAISE.
- `fn_cash_clusters_tick_all`: frozen short-circuit, oldest-ticked-first, 5.5 s budget with deferred
  games answering identity, 2 s lock_timeout per game, error rows in `cash_cluster_events`.
- `fn_ca_fleet_state_upsert` signature `(p_rows jsonb, p_beat jsonb)`; `fn_ca_fleet_seat_touch`,
  `fn_ca_fleet_policy_effective` exist and are service_role-executable.
- `fn_project_stake_band` == `projectStakeBandOnto`; `fn_cash_stake_band` == `stakeBandForBigBlind`;
  `fn_assign_horse_lanes` == the 33/33/34 split in HorseBehavior.
- `fn_horse_fund_from_treasury` idempotency (advisory lock on the op id, ledger-row replay with a
  field-by-field identity check, receipt domain `horse_funding`, deferred on the entry freeze, claim
  released on every failure) is sound; only the club resolution is wrong (finding 1).
- No `is_horse` filter in any function read denies a horse what a human gets; the `is_horse` reads are
  identification (`fn_stamp_seat_horse_id`, the resolver's deterministic home-club pick, the
  house-board guard, `fn_seed_horses_to_floor`'s target set).
