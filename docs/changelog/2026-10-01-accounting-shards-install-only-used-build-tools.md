# Accounting shards install only the build tools they use

PR #5722 accounting shard 1 exhausted its 40-minute job limit after PostgreSQL setup spent 22 minutes downloading packages, including unused clang/LLVM dependencies from the Ubuntu Azure mirror. A targeted retry spent another 11 minutes in setup.

Shards 1 and 2 use installed PostgreSQL and packaged pg_cron. Native isolation and extension builds belong to shards 3 and 4. The setup now checks the complete runtime and real pg_cron on every shard, while requiring headers and compiler tools only on shards 3 and 4. Unknown shards fail closed. Signed repositories, no default database service, all qualification steps and all timeouts remain intact.

Regression controls execute the actual readiness shell against isolated runtime files. They cover all four shards, missing createdb, pg_dump and pg_cron, and unknown shards. The two affected workflow suites passed 670 tests.

This change addresses the dependency bottleneck blocking the assigned alert delivery. It does not establish production financial qualification, migration installation or alert closure.
