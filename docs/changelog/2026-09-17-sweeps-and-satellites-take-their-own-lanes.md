# Sweeps and satellites take their own lanes (2026-09-17)

Phase 2 of the horse programme. Three migrations, one CI check, one workflow.

| Migration                                                        | Applied (UTC) | What it does                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260917191322_sweeps_and_satellites_take_their_own_lanes.sql`  | 19:32:01      | Spin sweep and satellite finish leave the global lane; VIP credits lock by user_id; `fn_ca_settlement_lane_doctrine()`; two money-row ordering changes (reversed below) |
| `20260917193840_the_lane_doctrine_answers_in_under_a_second.sql` | 19:39:41      | The doctrine's call-graph rule becomes a frontier walk: 8.4 s to 0.35 s, under the engine role's 8 s statement timeout                                                  |
| `20260917194950_the_money_rows_keep_their_old_order.sql`         | 20:06:05      | Restores the finish and the hand obligations to their pre-images, byte for byte, after the deadlock storm described below                                               |

All three are recorded in `supabase_migrations.schema_migrations`. Rollback files sit beside this document.

## What was wrong

After the finish lane (`20260917113717`, 11:37 UTC) the settlement lane G was no longer drained by every finish, but two callers still took it exclusively: `fn_settle_satellite_tournament` and `fn_spin_expire_unfilled`. Each exclusive request waits for every G-shared holder on the platform and holds G for the caller's whole duration, so one sweep of expired Spins queued 68 backends for six seconds at 11:52, and the 12:00-17:10 log still showed 50-200 waits on G over one second in most ten-minute windows, with 229 hand settlements cancelled at the 8 s statement timeout in the 12:00 hour.

## What changed and stayed

1. `fn_ca_lock_settlement_lane_for_sweep_member(uuid)`: the Spin sweep takes G shared, F exclusive and T(member) exclusive per expired Spin, with the transaction-local `ca.finish_lane_tournament` GUC overwritten per member so the global helper re-enters instead of escalating. Refuses NULL and satellites with 55000.
2. `fn_ca_lock_settlement_lane_for_satellite_finish(uuid)`: the satellite finish takes G shared, F exclusive and T(satellite) plus T(target) exclusive in uuid order; a satellite with no target falls back to the global lane; re-entry goes through `fn_ca_lock_settlement_lane_for_finish(NULL)`.
3. `fn_spin_expire_unfilled` and `fn_settle_satellite_tournament_pre_money_path_gate` call the new helpers instead of `fn_ca_lock_settlement_lane_global()`.
4. `fn_award_vip_points_from_rake` credits in `ORDER BY user_id`, the order the finish already uses.
5. `fn_ca_settlement_lane_doctrine()` answers `{ok, checked_at, violations[]}` for four rules: G exclusive only by the two helpers; F named only by the three finish helpers; every caller of the global helper is on the reviewed list of 28; no rolling authority reaches the global lane within four calls. `scripts/ci/check-settlement-lane-doctrine.mjs` and `.github/workflows/settlement-lane-doctrine.yml` ask it on every migration PR and on main. The first body built the whole 3,592-function call graph and took 8.4 s, which the engine role's statement timeout cut at 8 s (57014); `20260917193840` walks only the frontier and answers in 0.35 s (0.67 s end to end through PostgREST). Verified in a rolled-back transaction that a probe pair `fn_zz_probe_a > fn_zz_probe_b > fn_settle_tournament_rake` is reported as a violation and an unlisted caller of the global helper as another.

## What was reversed, and why

Changes 6 and 7 of `20260917191322` tried to give the finish and the hand obligations one lock order for the club wallet and the per-user `table_cap` keys: the finish took every player's `table_cap:<user>` key before touching money, and the obligations took the club wallet row before deciding whether they had anything to do.

Between 19:32 and 19:45 the log recorded 1,393 deadlocks, against 2 in the previous hour. Every cycle had the same three parties:

| Process           | Holds                                  | Waits for                                            |
| ----------------- | -------------------------------------- | ---------------------------------------------------- |
| finish            | `table_cap(user)` for all players      | the `club_wallets` tuple (`pre_seat_guard` line 132) |
| hand obligations  | the `club_wallets` tuple (new line 58) | a row held by the hand side effects                  |
| hand side effects | the hand's rows                        | `table_cap(user)`, held by the finish                |

The premise was wrong in two ways. `fn_project_hand_side_effects` calls the obligations inside the hand's own transaction, so the early wallet lock was taken while the hand's rows were already held, by every hand at every table of the club, whether or not it owed anything. And `table_cap` is not taken before every money row: the side effects reach it after their rows. A finish holding one key per player for its whole duration crosses those paths constantly.

The finish was restored by hand at 19:42:27 and the obligations at 19:45:24; deadlocks have been zero since 19:45:30. `20260917194950` is that restore as a recorded migration, idempotent, with the pre-image md5s as its postcondition. The deadlocks that motivated 6 and 7 (club_wallets, vip_points_carry and club_members cycles, 22 in 5.5 hours) remain open and belong to Phase 4, where the fix is to order the rows inside the functions that take them, not to widen the finish.

## Measured

Postgres log, per period:

| Period                                              | Deadlocks | G shared waits over 1 s | G exclusive waits | of which sweep / satellite | F waits over 1 s | Statement timeouts | F06 lane retries |
| --------------------------------------------------- | --------- | ----------------------- | ----------------- | -------------------------- | ---------------- | ------------------ | ---------------- |
| 18:32-19:32 (before)                                | 2         | 473                     | 10                | 1 / 7                      | 55               | 156                | 6,355            |
| 19:32-19:46 (storm)                                 | 1,393     | 17                      | 1                 | 0 / 0                      | 115              | 10                 | 291              |
| 19:46-20:06 (after, includes the 19:53-20:00 break) | 0         | 0                       | 0                 | 0 / 0                      | 22               | 18                 | 28               |

pg_locks sampler at 0.2 s, 19:41-19:53: no exclusive holder of G except `fn_resolve_satellite_settlement_outcome` (a reviewed global authority, 13 samples); the sweep and the satellite finish hold F for at most 2.4 s and 1.8 s; the finish itself holds F for up to 5.4 s and other finishes queue behind it (958 waiting samples). The finish lane is now the longest queue on the platform; it is the subject of the next lane change (per-tournament finish lanes where the finish touches no shared row).

## Verification criteria

- `scripts/ci/check-settlement-lane-doctrine.mjs` exits 0 against the live catalog in under a second (measured 0.67 s, three runs).
- No `still waiting for ExclusiveLock on advisory lock [5,4265093629,1253463894,1]` line from `fn_spin_expire_unfilled` or `fn_settle_satellite_tournament` after 19:32.
- `fn_complete_tournament_terminal` prosrc md5 `36384d5eaef31083e0ee5424d814138d`; `fn_ca_process_hand_post_commit_obligations` prosrc md5 `9672653f9e15a45072de3b60ce5b0b2f`.
- Deadlocks per 10 minutes at or below the pre-19:32 level.

## Seen on the way, not fixed here

- 557 RUNNING tournaments (2,708 entries) hold a positive tournament rake record with no `captured` batch in `accounting_tournament_fee_batches`, because they were registered before the accounting cutover of `20260917181100` (18:11) and nothing backfilled them. `fn_accounting_tournament_fee_net_plan` refuses their finish with `tournament_fee_sources_require_reconciliation`; the engine logged 864 refused finishes for 529 distinct tournaments between 19:04 and 19:53, all still RUNNING, the oldest since 2026-09-05. The elimination scheduler retries them (queue depth 750-940 since 17:20, oldest wait 15-22 minutes), which is also why completions fell from 20-45 to 3-11 a minute. This is the accounting domain's transition gap and is reported separately.
- The 19:55 release window closed with 25 tables counted unparked (30 at 17:55, 22 at 18:55). They are cash tables that parked between hands on time; the live build (2f4e3356) counts them unparked because their park write never becomes durable. The fix (#4780) is in the waiting release and cannot pass the gate it fixes; that needs its own route.
