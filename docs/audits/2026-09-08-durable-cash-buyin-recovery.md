# Cash Buy-In Recovery After Lost Confirmation

## Problem And Repair

The cash confirmation callback awaited an unbounded RPC and kept its request key
only in a ref. Cancel, the decision clock, reload or a changed seat could discard
an unanswered purchase identity. A timeout cannot prove that the debit failed.
The old player_seated action also has no matching server handler.

The client now journals the exact account, table, seat, amount, auto-rebuy option,
club and request key before sending. IndexedDB read/write transactions serialize
the synchronous local/session-storage reservation across tabs. No network request
holds that transaction. Storage failure stops submission. The journal survives
reload and has no age-based eviction. It is account scoped and deliberately keeps
minimal unresolved financial intent across logout; it stores no credentials,
current balances or profile information. Another account cannot load that intent.

A recovery click first reads the caller-owned completed receipt. An unconfirmed
receipt is not a refusal. Only an explicit review/Retry can resubmit, with exactly
the saved payload and key. There is no offline or reconnect purchase queue.
Mutation confirmation has a 15-second budget; each receipt read has a 6-second
budget. Unknown outcomes remain visible and recoverable; timer expiry cannot
eject an unresolved buyer. Old view completions cannot clear a new view's latch.

Confirmed receipt recovery refreshes the authoritative wallet and requests RESYNC
on the existing engine connection. It never paints an old starting stack, reseats
a departed player, or subtracts the purchase again from a refreshed balance.
Only a newly confirmed purchase may paint its initial seat. Post-confirmation UI
or notification errors cannot reinterpret a committed buy-in as a failed debit.

## Database Boundary

Migration 20260908192135_cash_buyin_receipt_readback.sql adds only
fn_ca_cash_buyin_receipt(uuid, uuid), a read-only SECURITY DEFINER function.
It verifies auth.uid and the live session, and requires an exact completed
cash_transaction receipt for atomic_table_buyin, caller and table. It returns
only whitelisted canonical intent fields. It makes no money or seat changes.
No receipt table SELECT grant is added. Execute is authenticated only, revoked
from PUBLIC, anon and service_role.

Applied through the migration tool at 19:48 UTC as catalog version
20260908194834 / cash_buyin_receipt_readback. Verified live function MD5:
82e0c070a873103964f597a1968745c7. The scoped schema manifest records that evidence.
The production database change precedes the client and is backward compatible.

## Verification

- Actual PostgreSQL migration and 11 receipt/access cases passed in an isolated
  database, within the existing full chip-journal atomicity suite. Existing
  rebuy, BBJ and add-on proofs passed in the same run. No production purchase.
- 181 client tests across 12 focused files passed before three additional
  journal cases; the latest 30 journal/callback cases pass, including IndexedDB
  completion/deadline behavior and UUID case normalization.
- The real TablePage JSX callback is exercised for timeouts, lost responses,
  restored receipts, storage failure, view changes and late confirmation.
- Public requestSnapshot coverage verifies one RESYNC on the existing socket.
- TypeScript passes. The first full build compiled successfully but the final
  provenance gate rejected a branch behind main. This is not recorded as a
  successful release build; rebase and a fresh guarded build are required.

IndexedDB transaction scheduling reference:
https://w3c.github.io/IndexedDB/#transaction-scheduling

## Release And Limits

At this checkpoint the database function is live; the client is uncommitted and
not published. Release SHA, CI and public build checks must be appended after
publication. Browser tooling currently times out refreshing its CDP connection.
No physical iPad home-screen, offline/network-switch or production paid-join
verification has been claimed. The broad connection incident and long hand-gap
outliers remain open despite the repaired permanent settlement freezes.

## Guarded Build And Integration, 20:10 UTC

The local unpublished-commit preservation hook refused the rebase. Rebase was
aborted, restoring the clean committed tree, and origin/main was merged normally
without conflicts. No guard override or history rewrite was used. Build commit
266b32ff passed npm run build, including the final provenance check with
behind-main=0. TypeScript and 106 targeted tests across six files passed on that
integrated source. Existing PostgreSQL proof remains valid; the merge changed
none of the cash receipt migration or probe files.
