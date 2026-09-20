# Tournament fee source fixture

**UNRUN after relocation. Protected execution is pending.** The protected local pipeline is not yet operational. The runner is an execution payload for the approved catalog, not permission to run a direct test or a fallback pipeline.

The earlier scratch fixture completed 103 assertion executions. That is historical local evidence only. Repository packaging and the final execution identity require a fresh protected receipt.

`scripts/dev/test-tournament-fee-sources.sh` creates an isolated PostgreSQL 17 database through a private Unix socket, disables TCP, and removes its temporary directory on exit. `PG_BIN` selects the approved binary provider. It writes no generated files to the checkout. The protected executor must preserve stdout/stderr as its durable log.

`source-binding.json` binds the whole tournament component, each of its ten extracted sections, the shared commission posting function, and every fixture file by SHA-256. The runner extracts the financial functions from `supabase/accounting/weekly-v3/components` into its temporary directory. No second implementation is stored here. Drift requires source review and a new protected execution; do not refresh hashes merely to make a test run.

The source suite covers original charge evidence, earning club and historical charge time, exact cent allocation, retries, source immutability, original-producer capture, cancellation/refund disposition, recognition/bank receipts, atomic shared commission posting, late-failure rollback, weekly request persistence, and missing-history deferral. A three-contributor Spin with missing history for the middle contributor must preserve the original charge, remove all partial source rows and remain `legacy_unverified` on retry.

Boundaries are explicit: the earning-contract helper is a scope/time-checking stub with a synthetic 25% tier. Bank primitives and schema are bounded fixtures. The normal terminal core runs a zero-prize boundary whose settlement stub rejects nonzero prize/bounty work; satellite and cancellation bodies compile here. The companion `tournament-fee-lifecycle` probes execute real nonzero registration, satellite transfer, prize, fee and refund paths against the accounting owner's full schema and candidate. Neither suite alone establishes live scheduling, delivery, financial reconciliation or release readiness.
