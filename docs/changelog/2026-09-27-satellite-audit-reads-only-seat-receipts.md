# Satellite audit reads only seat receipts

Job233 timed out inside the unchanged satellite conservation audit. The retained
production read-only plan scanned roughly3.5million rake_records to select about2919
source receipts (estimated scan cost261560). The financial function is retained
byte-for-byte. A partial btree on source for fn_award_satellite_seat permits the
existing predicate to seek its own receipts; no accounting or horse/player rule changes.

Metadata stays in the heap. A production metadata-size read reached its8second
limit, so no size distribution is claimed; indexing unbounded JSONB could reject
future valid receipts. The small selected set can safely retain heap fetches.

The online build is one explicit CREATE INDEX CONCURRENTLY statement through the
maintained session route. The separate short recording migration refuses missing,
invalid, not-ready, dead, differently shaped/owned indexes and changed function
source. It has no blocking fallback. Existing DDL/maintenance guards stay active.
Unknown acknowledgment requires durable catalog readback, not blind retry.

Native PostgreSQL17 replays the exact captured function on local synthetic data,
compares complete result rows and an independent mixed-seat/ticket/cash oracle,
proves a concurrent writer commits during the actual online build, tests interrupted
build refusal, and verifies function/OID/ACL/RLS preservation. A200002-row fixture
moves from12513 receipt scan buffers to202 with unchanged results; local query time
18.551ms to1.213ms is not production timing or billing savings. Large metadata
remains writable. The existing required accounting shard4 executes this native
runner, and path tests enforce admission for every qualification input.

The first production online build stopped at its15second lock timeout while old
transactions remained. Durable readback found the owned index invalid, ready and
live, with no running builder. Native qualification then reproduced that exact
old-snapshot boundary. The maintained finite REINDEX INDEX CONCURRENTLY recovery
waits beyond15seconds for a real old snapshot while a second writer commits,
preserves the full audit result/authority and leaves no transient indexes. Its
session route retains a6minute statement limit and180second lock wait for the
existing120second transaction bound. Unknown outcomes still require readback;
there is no automatic retry or DROP/rebuild driver.

The root installed that qualified recovery once at04:42:04.420UTC, then recorded
verification version20260927044216 once. Installed replacementOID61293720 is
valid/ready/live,32KB, with no transient indexes. The audit definition remains
MD5462b1c631010e4bab0361967d2da2a75; verification SQL remains2680bytes and
MD518f81dd761e8088e8b1ea0fcb09b037f. Source/native qualification does not itself
perform production DDL or call the financial audit in production. The next natural
job233 outcome and production query plan remain distinct root-owned acceptance;
index validity does not prove every other query in the conservation job is fast.
