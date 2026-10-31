# Retire the exact expired announcement after its advisory marker is removed

The pinned bd11 transaction removes its awaiting-certificate marker at startup and exit. Its announcement-only recovery returns transient status 75, retaining the original request. Once the original deadline expires, retries therefore have no waiting marker even though the durable announcement and all custody records still exist.

The existing cancellation owner now admits this markerless state only for original run 41177442979-1, immutable deadline 1793440868 after expiry, and a positive pinned `announced` disposition. Exact source hashes, announcement manifest, reservation, complete owned thaw, released Lightning hold, absence of runtime/checkpoint intents and pending seal, unchanged serving container/health, loaded stop authority and process/cgroup binding remain mandatory. A pinned retryable recovery child is recognized alongside the pinned transaction. No new process is adopted.

If the originally admitted invocation exits after its immutable cancellation intent was saved, both original process identities must be positively absent before exact instance masks can be installed. A replacement invocation never receives a stop. Completion waits for natural quiescence, all three original units and the original cgroup to be empty. Reused or unreadable original PIDs refuse. Durable stop-issued records continue to prohibit duplicate stops.

The read-only pending observation adds exact expiry/recovery categories and a bounded procfs classification with only a fixed process class and argv hash exported. It retains unknown outcomes and does not authorize cancellation. No production operation is part of these changes.

Local verification: 27 withdrawal cases (one real Linux systemd case unavailable on macOS) and 113 observation cases (four Linux-only cases unavailable on macOS) pass. The maintained real Linux systemd fixture now qualifies the actual recovery child before its existing loaded-unit mask/stop/empty-cgroup checks. Required Linux CI and actual same-owner readback remain necessary before dispatch.
