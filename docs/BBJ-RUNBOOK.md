# Bad Beat Jackpot: runbook

How the jackpot works end to end, where its money is, what each alarm means,
and how to put a payout right by hand. Written from the 2026-09-04 audit;
kept current by every phase of `docs/BBJ-BUILD-PLAN.md`.

## The path, in order

1. **Collection.** Every cash hand that sees a flop with 3+ dealt in pays the
   tier's BBJ drop (`bbjFeeBB`, RakeConfig data). `logBBJCollection` banks it
   into the club's pool, or the UNION pool if the club is in a union
   (`bbj_pools`: `main_balance` / `backup_balance` / `promo_balance` per
   `BBJ_POOL_ALLOCATION`). A failed banking call is queued in
   `pending_fee_distributions` (`kind = bbj_contribution`) and re-driven every
   5 minutes by `FeeReconciler.reconcilePendingFees`.
2. **Detection** (`detectBBJHit`, `server/src/config/RakeConfig.ts`) runs at
   showdown on board one. Rules per variant are in `BBJ_QUALIFYING_HANDS`;
   `BBJ_RULES` holds the gates (3+ dealt, pot > 10 BB, no double board, first
   runout). Hold'em: AAAJJ+ with an Ace in hand must lose to quads+, and BOTH
   hole cards must play for loser and winner. On a hit the engine emits
   `bbj_hit` to the table and stores the hit for settlement.
3. **Payout** (`processBBJPayout` -> `bbj_atomic_payout_v2`). One transaction:
   locks the pool, computes total = tier percent of main (main only, never the
   reserve), 50% to the bad-beat holder, 25% to the hand winner, 25% split
   across everyone else dealt in; credits seated recipients on
   `table_seats.stack` and departed ones on the club wallet of the club the
   seat was bought in from (`bbj_credit_one_recipient`); writes
   `bbj_payouts`, `bbj_payout_recipients`, `bbj_winners`; reseeds main from
   backup if main hit zero. Idempotent on (pool, table, hand): a replay returns
   `already_paid` and re-drives any missing credit.
   The engine retries transient failures four times; if all fail the full
   parameter set is queued (`pending_fee_distributions`, `kind = bbj_payout`)
   and a CRITICAL `financial_alerts` row is raised carrying every parameter.
4. **Announcement.** `bbj_payout_complete` to the hitting table (ten-second
   `BBJCelebration`, seat floats, stacks); `bbj_hit_global` fanned out over the
   engine socket to every live cash table in the club or union
   (`liveCashTableIdsInClubs`); the Realtime `bbj_pools` update is the fallback.
   The client draws the club-wide card once, from `BBJHitAnnouncer` in
   `PersistentTableLayer`, gated by `shouldAnnounceBbjHit` (fresh on the
   engine's clock, never twice per session). Every recipient gets a
   `notifications` row saying what they won and where it landed.
5. **Record.** Previous Winners reads `fn_bbj_recent_hits` (ledger-backed,
   cursor paged). The lobby ticker reads `bbj_winners` (world-readable, like
   `bbj_pools`).

## Where the money is

| Pool           | Column                     | Rule                                                                                                                                     |
| -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Main jackpot   | `bbj_pools.main_balance`   | The only payout source.                                                                                                                  |
| Backup reserve | `bbj_pools.backup_balance` | Never paid to a player. Reseeds main only when main reaches zero (which the 85% top tier cannot do). Phase 6 makes it the Mini BBJ bank. |
| Promo          | `bbj_pools.promo_balance`  | Promo rain (`fn_bbj_promo_rain`).                                                                                                        |

Conservation: `fn_bbj_conservation_check()` (epoch-based; `healthy` is the
figure that matters), `fn_bbj_promo_bank_check()`, `fn_bbj_orphaned_payouts()`.

## The alarms

| Source                                                        | Meaning                                                                          | Action                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `processBBJPayout.exhausted` (critical)                       | A detected hit could not be paid after four attempts. Queued for the reconciler. | Watch the next 5-minute cycle. If the queue row exhausts (25 attempts), re-drive by hand (below). |
| `FeeReconciler.exhausted` with `kind = bbj_payout` (critical) | The reconciler gave up on a queued payout.                                       | Re-drive by hand.                                                                                 |
| `FeeReconciler.bbj_unlinkable` (warning, one open row)        | Rake rows with no hand_id; their BBJ drop cannot be reconciled.                  | Rising figures mean `logHandHistory` is failing. Steady small figures are history.                |
| `FeeReconciler.bbj_drift` (warning, one open row)             | Booked drop and banked drop disagree over the window.                            | `fn_bbj_repair_unbanked` self-heals; a persistent gap is a lost-write bug.                        |
| `bbj-reserve-empty` incident                                  | A 100% hit emptied main and the reserve was empty.                               | Fund the pool (`fn_union_fund_bbj_pool`) or accept the restart.                                   |

## Re-driving a payout by hand

Only with the parameters from the alert or the queue row, and only after
reading `bbj_payouts` for that (table, hand): if a row exists, the payout
landed and the RPC will say `already_paid`. Seated = the players still in
their chairs NOW.

```sql
SELECT * FROM bbj_atomic_payout_v2(
  '<pool_id>', '<table_id>', <hand_number>, <payout_total_percent>,
  '<loser_user_id>', '<winner_user_id>',
  ARRAY[...dealt_in_ids]::uuid[], ARRAY[...seated_now]::uuid[],
  '{"winner_hand_name":"<loser hand>","loser_hand_name":"<winner hand>","status":"completed"}'::jsonb);
```

(The name inversion is deliberate and consistent throughout: the player who
LOST the hand WINS the jackpot.) Probe it inside a transaction you roll back
first (CLAUDE.md 11.5), read the recipient rows, then run it for real. Resolve
the alert with a `resolution` note naming who was paid what.

## Probing without spending

`BEGIN; ... SELECT * FROM bbj_atomic_payout_v2(...); SELECT ... ; ROLLBACK;` is
the pattern used in the audit. Use a real table with real seats, a hand number
that does not exist (999999999), and read back seat deltas, wallet deltas,
`bbj_payout_recipients` and the pool debit before rolling back. Never DELETE a
seat row to clean up.
