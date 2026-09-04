# 2026-09-04 - chip standard, the gate before the next phase: everything built so far, re-verified

Dan's rule: before a new phase, prove the previous one is fully built, wired, tested, pushed and published, and look for bugs, gaps, stubs and regressions everywhere. This is that pass, run 11:35-12:30 UTC over Phase 2 (2026-09-03) and defect 0 (this morning). Every figure was read from production or a named CI run.

## Pushed and published

| item                                                                | state                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #2958 felt erasure (delta-mode writes, barrier, restoration, sweep) | merged `a79341862`; published `ca_sha a793418623114283f2957bba876d72095d5af4b9` at 11:45:41Z; engine deploy queued for the :55 gate |
| #2904 handoff document                                              | merged `0f699a110` after a re-run of a CI run that had been cancelled, never failed                                                 |
| #2905 club FK indexes + two unmirrored cron repairs                 | was dirty and red; merged main (LAWS.md by union), fixed the real failure below, pushed `f070b2ce0`, CI green-pending               |
| #2896 promo model                                                   | merged `e02d510e9` (verified)                                                                                                       |
| Phase 2 migrations (14 merged last night + 7 in those PRs)          | repo/prod parity byte-exact for every chip-std file present on main                                                                 |

## Found and fixed (each is a migration, applied and mirrored)

1. **A club could not be deleted again** (`20260904113856`). #2905's own gate was red because `stable_hand_horse_state` (another agent's table) grew two foreign keys into `clubs` after the thirteen gaps were closed. Two indexes; `fn_ca_fk_index_gaps('public.clubs')` returns none.
2. **Four money doors were not on the registry** (`20260904114504`). `fn_ca_money_rpc_drift()` returned `fn_promo_disburse`, `fn_ca_retire_certification_club`, `fn_ca_restore_erased_seat_credit` and `fn_club_owner_has_a_player_wallet` (a trigger that creates a zero wallet). Audited, registered; drift is 0 again. The same migration resolves the drift incidents defect 0 raised (supply meter and trial-balance watch rows from 2026-08-31 20:30 to 2026-09-04 11:05) with `correction_ref` on each - the incident table refuses a resolution without one, which is a good guard. The 65 open `fn_ca_settle_hand_stacks_absolute` warnings are all tournament-table refusals (handoff defect 11) and stay open.
3. **`rake-repair-unbanked-hourly` had timed out on every run since 05:52** (`20260904114911`). Its candidate query walks 48 hours of cash hands (228,174 rows, 151s measured) to find nothing; the function's own `SET statement_timeout '540s'` cannot rescue a statement already running under the role's 2-minute cap. Leading `SET` and a 6-hour window; the 15-minute redrive covers the queue path.
4. **The weekly union close and recompute carried the same trap** (`20260904115113`). Both set their timeout with `set_config` inside the statement; the recompute already died to the cap on 2026-08-30 23:40. Monday 2026-09-07 00:10 is the first real close after the settlement floor. Wrapped, commands untouched.
5. **Four more schedules, same trap** (`20260904115148`): `ca-payout-sweep-hourly` (11 of 87 runs failed this week), `reconcile-club-member-daily-profit`, `tourney_money_conservation_deep_daily`, `tourney_payout_sweep_detect_daily`. Wrapped.

6. **A seat that left mid-hand was refused whole** (`20260904120601`). In the first 40 minutes of delta mode, 3 cash hands were refused "seat missing or left": in each, a player asked to leave mid-hand and the _previous_ hand's `leave_pending` settlement step - still running, because of the barrier defect - cashed the seat out 2 to 11 seconds before the hand ended, at the pre-hand stack. The engine fix removes the cause; the database now also has a correct answer: the players still seated get their deltas, the leaver's own delta is settled against the club wallet the seat cashed out to (a bet is debited, a win is credited), keyed `late_seat_settle:<hand>:<user>`, journalled `player_wallet <-> table_stack` as `settlement`, with a `chip_transactions` row the player can read. Probed rolled-back: debit 0.25 and credit 0.30 both land to the cent, replay settles nothing twice, absolute mode still refuses. Pinned in `TheFeltKeepsWhatLandedOnIt.law.test.ts`.

## Verified clean (no change)

- R3 in refuse: 0 violations since the 22:35 flip. 0 ledger write failures and 0 suspense legs in 12h. `pending_fee_distributions` backlog 0.
- Hand settlements since delta-mode landed at 10:48: 26,941 with 5 refused, every refusal "seat missing or left"; the no-op false failures are gone (a parallel agent also detached `aaa_skip_noop_update` at 11:02 with its own migration; the two changes are compatible and my function is intact - checked by text).
- Commission accrual: 29,707 rows in the last hour (every agent in the chain, Phase 2.2).
- Union rake attribution: 100% of cash union rake records attributed. The 31.65% "unattributed" a naive count shows are tournament records, which the close derives from `tournament_players` by design.
- Wiring on main: `WalletService.disbursePromo` used by `AgentDashboardPage` and `PlayerSessionsPage`; `certify-club-create.mjs` calls `fn_ca_retire_certification_club`; `RakebackSettlerService` calls `fn_union_weekly_rakeback_close_all`; the Monday cron calls `fn_union_settlement_cascade_all -> fn_union_settlement_cascade -> fn_union_weekly_rakeback_close` (the v3 close: attribution basis, per-game-type rates, op-keyed credits) and a second call on a closed period returns `already_executed`, so two callers cannot pay twice. Every scheduled cron command resolves to a live function except one already-inactive archival job.
- Server suite 4,933 green, tsc clean, root law registry green; all repo gates green except the advisory conservation gate, which correctly reports the pre-deploy erasure window.

## Live verification of the engine half

Filled in below once the :55 cutover has served two hours - see the "delta mode live" addendum.
