# 2026-09-02 - chip standard, Lane A bridge: the settle function the engine already calls, and its first correction

Branch `fix/chip-accounting-standard`. This PR is the repo MIRROR of two
migrations that are already live in production, plus the standard itself.
Nothing here changes behaviour on merge; it makes `check-migrations-applied`
and the next agent see what production already runs.

## What is in it

1. `docs/CHIP-ACCOUNTING-STANDARD.md` - the industry standard, the measured
   state of every chip path on 2026-09-02, the target lifecycle per game type,
   rules R1-R11, the layers of protection and the lane plan. It was written on
   Dan's Desktop and copied into every lane worktree untracked; this is the
   first commit of it. Em dashes replaced by hyphens per house style.
2. `docs/SWARM-BRIEF-CHIP-STANDARD.md` - the operating contract every lane
   followed (worktrees, one migration one transaction, rolled-back probes, the
   shared `tournament_obligations` interface).
3. `supabase/migrations/20260902191500_a_place_is_paid_once_the_settle_function_the_engine_already_calls.sql`
   - applied 19:16 UTC as `20260902191644`. Creates `tournament_obligations`
   (UNIQUE per tournament/kind/place and per tournament/kind/user) and
   `fn_settle_tournament_obligation`: upsert the obligation (owed only rises),
   pay `min(amount, owed - paid)` through `fn_credit_and_log` under
   `obl:<obligation>:<paid-so-far>`, refuse a second user on a paid place,
   refuse a second place for the same finisher, refuse a prize-pool kind that
   would take the event past its `prize_pool` (`escrow_short`). PR #2671's
   engine code calls it; the engine build carrying #2671 is cutting over as
   this is written (deploy run 33674643549).
4. `supabase/migrations/20260902194500_bounty_rows_do_not_count_against_the_prize_pool.sql`
   - applied 19:47 UTC. Found during the cutover watch, before any engine
   build called the function in production.

## What was observed (item 4)

The R1-lite cap excluded `bounty`, `mystery_bounty` and `bounty_residual`
rows from the "paid from the pool" sum. Production's bounty functions write
`own_bounty` (597 rows, 71,254.48 chips in 7 days) and
`mystery_bounty_residual` (51 rows, 2,235.29 chips). Replaying the cap as
written over the last 7 days of completed bounty-family events:

| variant            | events | refused as written | refused with the fix |
| ------------------ | ------ | ------------------ | -------------------- |
| bounty             | 111    | 82                 | 3                    |
| mystery_bounty     | 63     | 45                 | 2                    |
| progressive_bounty | 49     | 36                 | 2                    |

163 of 223 events would have had their last places refused with a critical
`escrow_short` alert the moment the engine cut over. The seven that still
refuse really did pay past their pool (the double-payment class in the
standard, 2.2 item 3).

Rolled-back probes against production (Brunch Special PKO 2e645135, pool 180,
180.00 of structure paid, 28.44 of `own_bounty` rows; pool raised by 1.00
inside the transaction so place 5 is owed 13.60 against 12.60 paid):

- as written: `{"ok": false, "refused_reason": "escrow_short"}` - the false
  refusal;
- after apply: `{"ok": true, "paid": 1, "already_paid": 12.6, "idempotency_key": "obl:...:1260"}`;
- negative control, Union Mystery Bounty 1f97c186 (pool 800, 1,150 paid),
  place 9 asked for 29.75 against 28.75 paid: `escrow_short` - a real
  over-pool event still refuses.

All three transactions rolled back; `tournament_obligations` held 0 rows
before and after.

## Deployment state at the time of writing

- Production engine served commit `14b9d8940` (pre-#2671) until the 19:39 UTC
  deploy run; every payout up to then went through the legacy
  `tourney:...:prize:place:N` keys (verified: 0 rows in
  `tournament_obligations`, all `tournament_payouts` since 18:50 recorded by
  `credit_and_log` under legacy keys).
- The function's legacy seeding reads `tournament_payouts` by position, so an
  event that started under the old engine and finishes under the new one is
  paid the difference, never twice.

## Still owed by Lane A (not in this PR)

The nine DB payers do not call the settle function yet (verified 19:41 UTC
against `pg_proc`): `fn_tournament_payout_reconcile`,
`fn_pay_backed_payout_shortfalls`, `fn_ca_backpay_guarantee_shortfalls`,
`fn_backpay_spin_unpaid_winners`, `fn_backpay_hu_winner_shortfalls`,
`fn_final_table_deal`, `fn_collect_bounty`, `fn_finalize_bounty_pool`,
`fn_mystery_bounty_pay`. The R3 trigger does not exist. `ca_payout_freeze`
(the kill switch the function already consults) does not exist. Those are the
next PRs.
