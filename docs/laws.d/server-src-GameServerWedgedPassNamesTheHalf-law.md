# server/src/GameServerWedgedPassNamesTheHalf.law.test.ts

`performOwnedEngineLeaseProofRenewal` awaits two halves and each half awaits
exactly one RPC, so the half still outstanding when a pass is abandoned names the
call that hung rather than only the branch it was in. On 2026-09-12 the renewal
loop stopped for four and a half hours and telling a hung pass from a departed
loop took a hand-diff of `pg_stat_statements` against the container log, because
the process said nothing either way; the abandon timer and the loop supervisor
stop that being terminal, and this stops the next one being a mystery.

The test pins that each case is named exactly - cash alone, tournament alone,
both, and neither when the pass settles as the timer fires - and that a REJECTED
half is not blamed, because it has come back. That last one is why the flags are
cleared with `.finally()` and not `.then()`, and it is the assertion that fails
if the call is ever changed.
