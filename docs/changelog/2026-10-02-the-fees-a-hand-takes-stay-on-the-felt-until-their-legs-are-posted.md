# The fees a hand takes stay on the felt until their legs are posted

**Date:** 2026-10-02 (work began 22:49 UTC 2026-10-01)
**Migration:** `20261001231409_a_hands_fees_stay_on_the_felt_until_their_legs_are_posted.sql`
**Law:** `tests/a-balance-never-moves-without-its-ledger-row.law.test.ts` (extended), `docs/laws.d/a-balance-never-moves-without-its-ledger-row.md`
**Executed proof:** `scripts/dev/test-ledger-invariant.sh` (P2b-P2f pass, R12-R14 refused by name)

## Dan's question, answered in one paragraph

Drift was possible because the engine commits a cash hand in two transactions:
the first moves the seats (sum of stack deltas = inflow - rake - bbj) and writes
no leg for the rake and the jackpot drop; the second, seconds later, posts those
legs under the club wallet, VIP carry and pool locks and marks the hand's
envelope complete. Between the two the chips the hand took are in neither a
balance nor the journal, and a second half that never ran left the felt short of
its journal for good - which is what the trial balance and the ledger replay
kept reading as "the felt moved more than its legs". The per-transaction ledger
invariant installed earlier today saw it on its first 28 minutes: 4,491
findings, every one on `table_stack`, every one half of this pair. The legs
cannot be moved into the commit (below), so the balance is kept where the legs
are: the hand's own receipt now counts `rake + bbj - inflow` as felt from the
moment its envelope is stored until the moment it completes, in the transaction
that posts the legs. Each transaction balances to the cent on its own, a hand
whose second half has not run reads as fees still on the felt rather than chips
that vanished, and a second half that posts legs without completing, completes
without legs, or a first half that stores no envelope, is refused by name. Once
observe mode reads zero for twenty minutes of full dealing the one row flips to
`refuse`, and drift of this kind is impossible by construction rather than
detected after the fact.

## Which legs were deferred, and why the split exists

Read from `fn_ca_commit_hand_settlement` (12-argument door, md5
`e9d96bfefffef41bc22b6b6f2d5da452`), its core
`fn_ca_commit_hand_settlement_exact_before_obligations` ->
`fn_ca_settle_hand_stacks_absolute`, and `fn_ca_process_hand_post_commit_obligations`
(md5 `8d18dde12765610895b25e297a1f403f`):

| Transaction 1 (commit)                                           | Transaction 2 (obligations)                                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seats: stack deltas = inflow - rake - bbj (conservation rule)    | `atomic_distribute_rake`: rake_records, rake_attributions, club_wallets period/lifetime, `table_stack -> union_wallet` (union route, autoledger) or `table_stack -> chip_retirement` (standalone, explicit leg) |
| `hand_atomic_commits` receipt inserted, envelope stored + hashed | `bbj_record_contribution`: three `table_stack -> bbj_pool` legs (main/backup/promo)                                                                                                                             |
| time banks written on the seats                                  | `record_insurance_transaction`: insurance bank leg against `table_stack` (= inflow)                                                                                                                             |
| pending add-on rows locked (ids frozen into the envelope)        | `resolve_pending_addon`: float -> seat, refund leg; `promo_apply_playthrough`                                                                                                                                   |
|                                                                  | `post_commit_completed_at` stamped                                                                                                                                                                              |

Callers of the second half: the engine (`ServerTableEngineSettlement.postHandTasks`,
`processHandPostCommitObligations`, bounded retry then the outbox), the
projection worker (`fn_project_hand_side_effects`), and the restart path
(`fn_ca_resume_hand_submission`, which runs both halves in ONE transaction).

Why it is split, measured rather than assumed. Postgres log 21:00-23:00 UTC
2026-10-01, `canceling statement due to statement timeout` (8 s):

| statement                                    | cancellations                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_ca_process_hand_post_commit_obligations` | 2,674 (1,122 on `UPDATE public.club_wallets SET period_rake_collected ...`, the rest waiting on club_wallets tuples and vip_points_carry index inserts) |
| `fn_project_hand_side_effects`               | 285                                                                                                                                                     |
| `fn_ca_commit_hand_submission`               | 18                                                                                                                                                      |

`atomic_distribute_rake` takes the club's one `club_wallets` row (and, through
the rake_records triggers, every player's `vip_points_carry` row and the horse
claims' `profiles` rows) and holds them to COMMIT; `20261001000000` deliberately
moved that wallet lock FIRST so a tournament finish and a raked hand take the
banks before the player rows. Folding the obligations into the commit would
queue every hand of a club on that row inside the commit path (about 1,300
refused commits an hour instead of 9; each one rolls the hand back and kills the
table for restart), and would hold the table and seat locks the commit already
owns while waiting on the banks. So the legs stay where they are, and the
invariant's rule is honoured the other way: a balance whose leg is posted later
must not move earlier.

## What changed

One branch in `fn_ca_tally_balance_move` (asserted substitution on the anchor
`WHEN 'union_wallets' THEN`, count 1, read back; live md5
`7e2ead66788e37e4449c8d725ac4654f` -> `b7911a245d4bf33134a9a2f474c1f410`,
the fixture harness produced the identical after-md5), and the two invariant
triggers installed on `hand_atomic_commits` under a 250 ms lock_timeout with
rollback-and-retry, no DROP anywhere:

```
WHEN 'hand_atomic_commits' THEN
  k := 'table_stack';
  v := CASE WHEN post_commit_payload IS NOT NULL AND post_commit_completed_at IS NULL
             AND fn_ca_felt_counts_table(table_id)
       THEN stack_result.rake + stack_result.bbj - stack_result.inflow ELSE 0 END
```

Nothing about the hand commit changes: no amount, receipt, refusal name,
idempotency key (`hand:submission:` lock, request hash, payload hash), lock
order, or engine code. The engine calls are byte-identical.

Why `stack_result` and not the envelope: the stack core writes `rake`, `bbj`,
`inflow` into `stack_result` from the same arguments the door asserts against
the envelope (`post_commit_fee_mismatch` refuses `rake.amount <> p_rake`,
`bbj_contribution.amount <> p_bbj`), and `inflow` (the insurance net landed on
the seats) exists only there. The pending-add-on float already follows this
exact pattern (20260912): a leg in one transaction, the seat in another, the
chips counted on the felt in between. The fees are its mirror image.

## Proof from production rows

4,074 of 4,074 completed cash hands committed 22:45-23:21 UTC 2026-10-01
(all cash felt hands in a 13,000-hand window, excluding the last three minutes):
`round(rake + bbj - inflow, 2)` on the receipt equals the net of `table_stack`
legs carrying that hand_id, to the cent, 5,241.00 both sides. The ten that a
first pass disagreed on were the query's own window: single-transaction
restart-path hands whose legs carry `created_at` (transaction start) six seconds
before the receipt's `committed_at` (clock_timestamp inside the same
transaction). Widening the window put all ten in agreement.

## Measured commit path, before

pg_stat_statements, cumulative to 22:58 UTC 2026-10-01:

| RPC                                          | calls     | mean     | max      |
| -------------------------------------------- | --------- | -------- | -------- |
| `fn_ca_commit_hand_submission`               | 3,059,514 | 119.4 ms | 7,998 ms |
| `fn_ca_process_hand_post_commit_obligations` | 3,063,766 | 144.4 ms | 8,000 ms |
| `fn_project_hand_side_effects`               | 3,076,995 | 140.7 ms | 8,000 ms |

The change adds three row-trigger firings per cash hand (INSERT + UPDATE in
transaction 1, UPDATE in transaction 2), each one jsonb read and one primary-key
lookup (`fn_ca_felt_counts_table`). After figures: see "Live verification".

## Live verification

(filled in as the migration is applied and observed)
