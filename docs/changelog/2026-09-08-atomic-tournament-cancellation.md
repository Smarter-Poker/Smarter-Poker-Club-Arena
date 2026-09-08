# Atomic Tournament Cancellation

## What Was Wrong

The game server cancelled a tournament through a series of independently
committed writes. It discovered each open entrant, settled one refund at a
time, inserted fee reversals separately, then closed player and table rows.
A timeout between those calls could leave only part of the decision committed.
The next attempt also read a different set of open rows, so it could not prove
or replay the original closeout.

## Root Repair

Migration `20260908065250_tournament_cancellation_commits_one_stored_receipt`
turns the existing `atomic_cancel_tournament(tournament_id, actor_id)` door
into the sole transaction boundary for cancellation:

- The tournament row is locked before replay inspection or any money write.
- Refund entitlement comes from recorded tournament buy-in, rebuy, and add-on
  debits. The existing satellite-seat transfer fallback remains intact.
- Every positive entitlement is settled through the existing refund
  obligation, and the transaction refuses to commit unless the obligation is
  fully settled for the evidence-derived gross amount.
- Per-player fee reversals and both existing aggregate Spin fee sources remain
  covered in the same transaction.
- Tournament, player, and table rows become terminal before one immutable
  receipt is inserted. A retry returns that stored receipt without moving
  money again.

The game server keeps its fail-closed survivor-list preflight, makes one RPC,
and validates the receipt's identity, actor, terminal state, exact-cent totals,
unique refund lines, obligation IDs, and row counts before acknowledging the
cancellation.

## Rolling Cutover

This is the database-first stage. The existing cancellation signature and its
service-role grant are preserved so the live old engine remains callable while
the migration lands ahead of the receipt-verifying server. The generic
obligation helper is also retained. Retirement or revocation of a legacy door
must be a separate post-deploy cleanup after the new server is verified live.

The migration changes no historical balances and performs no backfill. It has
not been applied or deployed as part of this change.

## Verification

- Runtime tests exercise one-RPC ownership, unreadable-survivor refusal, RPC
  failure, hostile receipt values, exact-cent arithmetic, complete refund
  lines, and duplicate rejection.
- Source guards pin lock-before-money ordering, immutable replay, evidence
  derivation, all-row closeout, preserved cancellation safeguards, the
  database-first ACL, and one migration transaction.
- A disposable PostgreSQL 17 fixture compiled the migration and exercised
  first execution, byte-identical replay, append-only receipt refusal, and
  rollback after an intentionally partial obligation result.
- The server TypeScript build passes.
