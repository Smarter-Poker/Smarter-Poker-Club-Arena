# Recovery rechecks the authoritative rolling-hour boundary

The release transaction waited sixty seconds after a correctly refused rolling-hour reservation. An owner window permitting only minute 53 could therefore be skipped when the prior announcement became one hour old a few seconds into that minute.

The seal now optionally returns the latest blocking reservation's exact eligibility timestamp under its existing lock. Its original CLI response stays compatible. The existing bounded transaction rounds this timestamp up to its seconds clock and rechecks every original owner-minute, health, source, lock and reservation predicate at eligibility. The rolling hour, notice, freeze, certificate, rollback reserves, one-shot reservation and unknown-acknowledgement behavior remain unchanged.

Regression coverage runs the maintained recovery block, actual owner-minute predicate and actual seal CLI/file lock on isolated files. Health, ancestry transport, engine locking and the announcement endpoint are explicit positive fixtures. It covers the minute collision, latest of multiple blockers, equality, unreadable prior JSON, invalid eligibility metadata, a closed owner minute, unknown announcement acknowledgement, CLI compatibility and concurrent reservation. This source counterexample does not establish the actual production announcement-refusal cause.
