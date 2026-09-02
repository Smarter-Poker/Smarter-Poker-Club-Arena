# 2026-09-02 - chip standard, round 2: what is live, what the cutover needs, what is Dan's

Orchestrator record for the second session of the Chip Accounting Standard
(`docs/CHIP-ACCOUNTING-STANDARD.md`). The first session was cut off mid-swarm;
this one reconstructed its state from primary sources only (production
`supabase_migrations`, branches, PRs, the standard on the Desktop), found
nothing orphaned that had touched production or the repo, and finished the
lanes. Timestamps UTC.

## Live in production at 21:00 UTC (every migration mirrored in a PR)

| Piece                                                                                                                                                                                                                                  | Migration(s)                                                     | PR           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `tournament_obligations` + `fn_settle_tournament_obligation` (the one payer; a place is paid once; pool-capped `escrow_short`)                                                                                                         | `20260902191500_a_place_is_paid_once...`                         | #2702        |
| Bounty rows (`own_bounty`, `mystery_bounty_residual`) excluded from the prize-pool cap - 163 of 223 bounty events would otherwise have refused their last places at cutover                                                            | `20260902194500_bounty_rows_do_not_count_against_the_prize_pool` | #2702        |
| Payout record keeps its CLASS (`structure`/`reconcile`/...) instead of the engine's provenance, so `fn_tournament_guarantee_check` and `fn_tournament_double_paid_obligations` keep seeing engine payments                             | `20260902205000_the_payout_record_keeps_its_class`               | #2702        |
| Key renamed `tourney:<tid>:obl:<id>:<cents>` so `fn_credit_player_wallet_once` credits the club the player bought in from (3 of 4 probe places had gone to the wrong club)                                                             | `20260902201000_db_payers_settle_through_obligations`            | #2709        |
| Six DB repair arms re-pointed at the settle function (reconciler, backed shortfalls, guarantee backpay, spin backpay, HU backpay, final-table deal)                                                                                    | same                                                             | #2709        |
| R3 money-path trigger, LOG-ONLY (`ca_money_path_violations`)                                                                                                                                                                           | `20260902201500_r3_money_path_log_only`                          | #2709        |
| Engine payers through the settle function                                                                                                                                                                                              | (code)                                                           | #2671 merged |
| One rake spec read by engine and DB                                                                                                                                                                                                    | `20260902173200_one_rake_spec...`                                | #2688        |
| Cash: one cash-out path, one seat creator, rebuy through the pending-addon ledger, seat guard watches, production-only RPC bodies mirrored, definers state callers                                                                     | `2026090217450x...`, `174600`, `185000`, `192000`                | #2693        |
| Tournament chips conserved hand by hand (spins/SNGs)                                                                                                                                                                                   | `20260902173645...`, `183000...`                                 | #2684        |
| Freerolls are FREE BUY: 0 entry, 1.00 rebuy and add-on, trigger `zz_freerolls_are_free_buy` + backfill log; 28 of 28 registering freerolls conform (probe: rebuy_cost 5 -> 1.00, addon 7 -> 1.00, is_rebuy false -> true, rolled back) | `20260902183602...`, `184500...`                                 | #2692        |
| Controls: `ca_payout_freeze` (empty, human-only), `ca_manual_adjustments` four-eyes, `fn_ca_trial_balance` hourly info-only, `ca_direct_balance_writes` view                                                                           | `20260902203000_chip_std_controls` + 2                           | #2708 merged |
| Escrow shadow: `fn_ca_tournament_escrow`, hourly `fn_ca_escrow_vs_counter_check`; 3,819 of 3,826 asserted events in 24h balance to the cent; 1,109.00 real overpayment all pre-01:00 or migration-settled                              | `20260903013500...`, `014000...`                                 | #2707 merged |
| Satellite seat paid from the satellite's own pool with a ledger row; unbacked seat warns, never refuses                                                                                                                                | `20260903020000...`                                              | #2706        |
| Shortfall owed once (other agent, same domain)                                                                                                                                                                                         | `a_shortfall_can_only_be_owed_once`                              | #2686 merged |

## The engine cutover (the one thing not yet proven live)

Production served build `14b9d8940` (pre-#2671) all session. Every deploy run
since 16:27 ended `shipped=false`, "the maintenance break never opened for a
restart" (`ca_engine_deploy_attempts` 34-40). That is the engine-restart
programme (`docs/HANDOFF_CURRENT_STATE.md`, #2695 fixes the park predicate but
is itself waiting on a deploy; the #2663 escalation fires once production is

> = 190 minutes behind). Never `force: true`.

Proof of cutover, when it happens:

```sql
select count(*) from tournament_obligations where source like 'engine.%';            -- > 0
select app_name, count(*) from ca_money_path_violations where at > now() - interval '30 minutes' group by 1;  -- PostgREST -> 0
select count(*) from financial_alerts where source='fn_settle_tournament_obligation' and created_at > now() - interval '1 hour';  -- escrow_short refusals: read each one
```

The function was probed against every kind the engine sends (place, late-reg
top-up, final-table deal, refund) and against the seeding case (an event that
started under the old keys and finishes under the new ones pays the
difference, never twice).

## First real obligation in production

20:21:52 a heads-up SNG winner's 3.80 credit failed after 3 retries (DDL storm
from the lanes' migrations, PostgREST reload). 20:52:01 `ca-payout-sweep-hourly`
paid it through the re-pointed reconciler: obligation `place:1 3.80/3.80
reconcile`, key `tourney:be94502b...:obl:71327c1a...:0`. No hand touched money.

## Measured, last 6 hours to 20:52 UTC (completed events, pool paid vs prize_pool)

| variant        | events | over pool                                                     | under pool                     |
| -------------- | ------ | ------------------------------------------------------------- | ------------------------------ |
| sng            | 817    | 0                                                             | 1 (the 3.80 above, since paid) |
| spin           | 766    | 6 (338.00, all pre-17:28 10x ladder cases already documented) | 0                              |
| bounty         | 3      | 0                                                             | 0                              |
| freezeout      | 3      | 0                                                             | 0                              |
| mystery_bounty | 2      | 0                                                             | 0                              |

The MTT variants that leaked 24 percent of their collections over the prior
36 hours conserve exactly in this window.

## Left log-only on purpose (Dan's rule)

R3 refusal of tournament credits outside the settle function; the R10 REVOKE
on balance columns (would block buy-ins today); automatic kill-switch opener;
prize_pool as a derived column; refusing a satellite seat or capping
`awardCount`; wiring `p_adjustment_id` to require an approved four-eyes row.

## Decisions that are Dan's (consolidated from every lane)

1. Flip R3 to refuse (proposed: after 24h of zero engine rows in `ca_money_path_violations`).
2. Bank short at late-reg close: refuse (as the lock trigger does) or go negative (as today).
3. 1,109.00 real MTT overpayment + 92.00 satellite-fallback mint: confirm no clawback, club absorbs.
4. Satellite qualifier unregistering from the target: cash (today), refuse, or a real ticket liability.
5. Cancelled target: refund a qualifier to wallet or to a ticket (today: nothing).
6. Satellite lobby now shows the remainder after seats, not the collected pool.
7. Retire `chip_escrow_holds`, `chip_supply_snapshots`, `atomic_tournament_register`, `fn_tournament_atomic_register`.
8. `settlement_suspense` takes ~176K/day of spin prize legs (R9): declare the counterparty or accept.
9. `clubs.promo_balance` sits outside the supply identity (~857/day).
10. C4 restart sweep: everyone or nobody. Kill-switch threshold. Rakeback 281,108.01 owed.

## Housekeeping

`gh` on the Mac has a dead keyring token; the REST token in `.env` works.
Autopilot opens a PR for any pushed branch (PATCH the body, do not POST a
second one). `docs/LAWS.md` conflicts across lanes were resolved by union.
