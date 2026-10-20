# Adaptive membership verification reads contiguous batch ranges

Final retention verification exceeded its five-second query bound because the
membership primary key begins with hand_digest. One bounded payload page required
thousands of scattered pair lookups. Grouping the same pairs still exceeded the
bound in production; no complete verification is claimed from those attempts.

The migration adds one concurrent covering index on (batch_key, hand_digest).
The maintained installer separates the concurrent preamble from the guarded
history transaction. Exact catalog checks refuse an incompatible existing index.
No retention rules, financial records, writer functions, snapshot guards or query
deadlines change. This is a database-only delivery.

The disposable PostgreSQL 17 fixture runs in existing CI shard four. It qualifies
the maintained concurrent-preamble parser, valid/ready/live creation, refusal of
an incompatible same-named index, batch-prefix index-only access and exact pair
membership equivalence for duplicate, NULL, malformed and missing tuples.
Production installation, bounded runtime and complete verification remain separate
required evidence recorded in the owning task checkpoint.
