# 2026-10-05: a failed Spin expiry run names its failure

`Spin expiry lock order and committed refund contracts` (accounting shard 1)
has gone red on every server-touching pull request since this morning. It
blocks the required `Server Engine (typecheck + tests)` aggregate, so it
blocks every merge that touches the engine or migrations. Through the
check-run API, all it says is "Process completed with exit code 1". The
reason exists only in the job log and in the uploaded `artifacts/spin-expiry/`
evidence, and both are served from blob storage.

`scripts/ci/annotate-spin-expiry-failure.py` runs after a failed Spin expiry
step and prints each failure entry from that evidence as a `::error`
annotation. If the evidence is missing or unreadable, it says so. It only
reports: it never changes the verdict. The pinned step itself is unchanged
(`tests/unit/fixtureNativeCi.test.ts`).
