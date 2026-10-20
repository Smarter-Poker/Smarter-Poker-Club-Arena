# Retirement replay verification uses a compact digest probe

The full cleanup check exceeded its unchanged five-second statement limit on
cold negative lookups into the purge ledger's wide digest index. A bounded
production plan measured 2,781 such probes at 823 ms, while the newly installed
batch-membership covering index took 5.7 ms for the same page.

Add a concurrent, nonunique BTree index over `hashtextextended(hand_digest,0)`.
The maintained read-only query first probes this smaller key, then compares the
actual stored digest exactly. Hash collisions are rejected; neither UUID-to-hash
mapping nor collision freedom is assumed. Existing primary and unique indexes,
rows, retention policy, permissions and verification deadlines stay unchanged.

The migration refuses a different expression, seed, type, collation, ownership,
predicate, key layout, ordering or opclass. The existing native retirement-index
CI entrypoint runs the new exact-migration fixture as well as its membership
fixture. Qualification covers concurrent installation, the default planner,
positive and negative matches, noncanonical stored mappings, forced collisions
and index-shape refusal.

Isolated PostgreSQL 17 measured the compact index at 18% of the wide index's
size on 250,000 rows. That is feasibility evidence, not production performance
or cleanup completion. Installation and a complete, acknowledged global proof
are verified separately. No compute downgrade is part of this migration.
