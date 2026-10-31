# Heavy hosted build capacity

The compiler, pull-request build and client unit shards, plus the existing publisher build and client-test shards, select the existing `ca-linux-8core` GitHub-hosted pool for the canonical repository. Both client suites request eight workers through the existing CPU-clamped Vitest budget. Forks retain standard hosted runners and cannot request arbitrary labels.

The existing `CA_REQUIRED_NATIVE_PROFILE=large` repository setting already selects this pool for PostgreSQL accounting, engine shards and native qualification. Verified in GitHub settings on October 30: 8 cores, 32 GB RAM, 300 GB SSD, Ready. No infrastructure setting was changed by this patch. The fixed standard fallback remains available through the existing profile selector.

Lightweight classification, admission, verdict and publication-transfer jobs keep their existing cheaper routes. All test inventories, shards, permissions, financial checks, timeouts, required result joins and production concurrency remain intact. Regression tests evaluate canonical/fork routing and actual Vitest worker configuration; complete workflow fingerprints normalize only the explicitly asserted capacity fields.

This changes CI capacity, not engine runtime or activation. No engine restart is needed. Larger compute does not shorten local hook/transport failures, serial dependencies or maintenance waits. Hosted assignment, completion and timing evidence belong in the delivery checkpoint; configuration alone is not a speedup claim.
