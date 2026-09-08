# A tournament pays every place or none

**2026-09-07** - branch `fix/tournament-settle-is-atomic`

> This note records implementation scope only. Operational rollout and
> production observation are recorded separately.

## Failure shape addressed

The retired normal path could pay places through separate external RPC
transactions, write `COMPLETED` separately and treat reconciliation as
non-fatal. Recovery could use the same per-place shape. Successful RPC
transport also did not prove that the stored obligation reached its full
amount. That construction allowed a terminal tournament to be only partly
paid. This note intentionally records no production counts or chip totals;
those metrics are not independently reproduced by this permanent artifact.

## The branch implementation

The migration introduces:

- `tournament_place_settlement_batches`, one exact completeness header per
  normal tournament;
- `fn_prepare_tournament_place_obligations`, which validates the finalized
  standings, structure, prize-pool guarantee and integer-cent total, then
  commits the complete obligation set and its fingerprint without moving
  chips;
- `fn_settle_tournament_places_atomic`, which revalidates that committed set,
  settles an exact Bubble Protection promise and every place, consumes the
  exact escrow amount, changes `COMPLETING` to `COMPLETED`, releases live seats,
  closes every physical tournament table and proves that no live seat or
  nonterminal table remains inside one exception subtransaction;
- a public `fn_settle_tournament_obligation` classification gate and a renamed
  private child core. The public gate preserves legitimate non-structure and
  satellite settlement but returns `atomic_batch_required` for normal place,
  late-registration adjustment, Bubble Protection and final-table-deal money.
  Only complete normal-place and final-table-deal batch functions may call the
  private core after proving their plans; application roles, including
  `service_role`, cannot call that core;
- `trg_freeze_batched_tournament_place`, which rejects any place-obligation
  insert, update or delete after its batch exists unless the atomic settler has
  opened the transaction-local gate;
- `trg_tournament_atomic_place_completion_guard`, a final database gate against
  any normal completion without the exact, fully paid batch.

Status is part of the immutable settlement record. A normal tournament that is
`COMPLETED` cannot move backward, a prepared place batch cannot leave
`COMPLETING`, and only a settled batch may make the terminal transition. The
final-table-deal batch similarly permits only settled `RUNNING` to `COMPLETED`.

Preparation rejects recognized payout evidence whose non-zero net belongs to
the wrong recipient or to a place outside the plan. It also rejects the reverse
conflict: any positive result prize outside the exact place plan. Settlement
and the completion trigger repeat the positive-result check, so neither a late
result edit nor an extra prize row can bypass the frozen batch.

After every single-obligation child call, the batch function re-reads the
stored `amount_paid`. After all money moves it also proves the exact escrow
delta and payout evidence. The `COMPLETED` transition releases seats through
the database trigger, and the same subtransaction closes every tournament table
with `current_players = 0` before checking that no live seat or nonterminal
table survived. A refusal, partial child result, evidence mismatch, SQL error,
deadlock, closure failure or lost terminal claim raises inside the
subtransaction, so the money, batch, status, table and seat changes roll back
together while the previously committed prepare record remains available for
replay.

The server helper performs prepare first and retries only transport or
explicitly retryable outcomes. Normal finish and stuck-`COMPLETING` recovery
both use it and require `ok && completed` before reporting success. Both paths
run the canonical guarantee transaction, re-read the authoritative pool and
refuse to price or settle unless the row is finalized and at least the
advertised guarantee. Live finish then reprices eliminated paid-place rows from
that funded pool, including prior zero-prize rows. Add-on closure no longer
writes `prize_pool_finalized` before guarantee funding; the guarantee RPC owns
the flag and successful funding precedes repricing. Elimination and
late-registration repricing record entitlement but do not pay a place
independently.

The public guarantee RPC now wraps a private debit core and proves, in one
transaction, the exact bank debit, overlay row, explicit journal leg, live
escrow credit and authoritative finalized pool. A pool finalized below its
guarantee is refused rather than silently reopened. Database gates make
finalization irreversible; freeze the finalized pool, advertised guarantee,
payout structure and Spin draw; refuse registration, rebuy and add-on writes
after finalization; and refuse finalization while any promised entry or add-on
window remains open. Prepare, settle and the completion trigger independently
refuse a finalized pool below its guarantee.

Bubble Protection is not prepaid by the application during elimination. Normal
batch preparation derives the exact stone-bubble holder only after the final
field and standings are frozen, creating a missing obligation with source
`engine.atomicPlaceSettlement`. It accepts an exact pre-existing obligation
only when its source is `engine.eliminatePlayer` or
`engine.atomicPlaceSettlement`; every other source is refused. Its payout
evidence is separately identified by source `bubble_protection`, null position
and the exact Bubble player. The batch freezes the Bubble obligation id, player,
amount and source, so a mutable display flag cannot erase durable evidence. The
separate final-table-deal contract uses its own `engine.atomicFinalTableDeal`
source and all-or-none batch.

The browser's legacy `finalizeTournament` surface now fails closed, satellites
and final-table deals stay on their separate contracts, and the SQL functions
plus batch table are unavailable to browser roles.

The branch removes the applying payout sweep from `RakebackSettlerService` and
the five-minute Heads-Up single-place backpay loop from `GameServer`.
`fn_tournament_payout_reconcile`, `fn_pay_backed_payout_shortfalls` and
`sp_ca_reconcile_backpaid_events` now raise on `p_apply=true` before scanning.
`fn_backpay_hu_winner_shortfalls` is replaced by an owner-run, non-paying
observation with no applying mode. Application execution is revoked from every
retired door.
Application access to the older
`fn_tournament_payout_sweep` and `fn_ca_backpay_guarantee_shortfalls` entries is
also revoked. The migration unschedules `ca-payout-sweep-hourly` and every cron
command that invokes one of these applying forms, removes the legacy expected
job entry when that roster exists, deletes direct reconcile settlement aliases
and creates no replacement payer, cron, retry worker, reconciler or backfill.

## Existing damage is outside this migration

This branch performs no wallet credit, manual ledger insertion, backfill or
clawback for historical tournaments. Any historical remediation requires its
own reproduced evidence and approval; this migration does not guess that an
old open row is safe to pay.

## Verification boundary

Permanent law, law-registry and schema-manifest guards pin the public-child and
private-core authority boundary; complete-batch transaction; post-child paid
total, escrow and ledger proofs; frozen place and Bubble obligations; physical
table and seat closure; completion gates; live and recovery guarantee proof;
irreversible finalization; zero-prize repricing; add-on finalization ownership;
contract exclusions; and retirement of every applying repair entry and cron.
Operational evidence and the 30-day non-paying observation belong in separate
records.
