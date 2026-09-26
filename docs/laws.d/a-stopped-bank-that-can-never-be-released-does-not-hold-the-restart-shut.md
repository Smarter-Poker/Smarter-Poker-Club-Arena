# tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts

On 2026-09-25 serving engine 778075b4 had 20 tournament managers quarantined
after lease loss; their STOPPED tournament engines answered
`hasUnretiredStoppedTimeBankCustody()` true for ever (root cause fixed
engine-side in #5254, not in that build) and `MaintenanceBreak.unparkedTables()`
counted `stopped_bank_custody_unconfirmed` with no bound, so `/health` showed
`readyForRestart false, unparkedTables 154, unparkedReasons
{ f06_preparation_stuck: 13, stopped_bank_custody_unconfirmed: 154 }` at every
break and every `auto-deploy-hetzner` run since 15:59 UTC waited for a
certificate that could not open, including the run carrying the fix. The reason
is raised only by a terminal engine, which deals no hands; what a restart
discards is the in-memory mirror of banks whose seats already stopped, and the
chips are in the database. This pins that the release admits the BOUNDED class
`stopped_bank_custody_stuck` (the engine ages the raw reason into it past the
same 600 s gate the F06 class uses, in
`server/src/maintenance/theGateSaysWhyItIsShut.law.test.ts`) under the same
database in-flight proof as the preparation reasons; that the RAW reason is
admitted only when `releaseSha` is on a literal allow-list of exact full
predecessor SHAs that can never present the bounded class, and refused from
every other serving identity, so the exception retires itself with the first
bounded engine; that `cards_in_air`, the refusing bank classes (`unwritten`,
`unreadable`, `bank_park_write_incomplete`) and any unknown reason still
refuse, predecessor included; and that the database proof remains the only
path that proceeds, with no bypass.

Corrected 2026-09-26 (#5267): `stopped_bank_custody_stuck` is no longer admitted. Past the bound the engine still refuses under that name and the release refuses it too, from every serving release; what outlives the bound on a build with #5255 is a bank still not on disk. The exact-SHA raw-reason exception for predecessor `778075b4` was unchanged by #5267.

Retired 2026-09-26: the exact-SHA exception fired once, got production off `778075b4`, and was removed, because a rollback to that SHA would have re-armed a custody reason in the release allow-list. This law now pins that `stopped_bank_custody_unconfirmed` refuses from every serving release, `778075b4` included, and that the exception is gone from the source; `tests/noServingReleaseBuysACustodyException.law.test.ts` pins that no SHA-specific exception can be reintroduced.
