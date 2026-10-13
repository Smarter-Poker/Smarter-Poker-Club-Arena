# Journal vacuum admission follows actual retention deletions

PostgreSQL 17.6 production readback at 2026-10-13 15:24 UTC showed 472,600 dead journal rows, no active vacuum, and no table-specific vacuum settings. Its inherited 50 plus 20% trigger required 4,006,330 dead rows at 20,031,400 estimated rows. The last journal autovacuum completed October 12 at 19:36 UTC. Deletion alone had not established reusable space.

`20261013152739_horse_journal_vacuum_trigger.sql` changes only the original journal's vacuum threshold to 20,000 and scale factor to 0.02. At that measured size the trigger becomes 420,628. This is a measured initial threshold, not a claim of optimal maintenance cost or guaranteed filesystem shrink. Other settings, ownership, rights, RLS, data, indices and original product jobs remain unchanged. One transaction takes a two-second lock timeout, refuses changed target/settings and replay, and asserts the exact option delta.

The retained native PostgreSQL 17 qualifier uses the original table schema, actual non-superuser owner, unchanged dummy payload, and real transactional DDL. It proves the measured default trigger misses the dead rows while the new trigger admits them; unrelated options/data/ACL/RLS survive; rollback, permission denial, lock timeout, target drift and replay preserve original state. The existing mandatory adaptive-retention native CLI invokes this qualifier without a new workflow or relaxed checks. Local qualification uses this setting-only proof; unchanged financial chains are not repeated locally.

Migration installation, hosted protected delivery, actual vacuum completion and recovered bytes remain root-owned and pending until separately observed. No application runtime replacement is required.
