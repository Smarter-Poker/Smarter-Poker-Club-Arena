# 2026-09-11 — Reconcile the accepted legacy engine release

Add a separately installed recovery-only entrypoint for an accepted v1 release whose pinned health parser rejects the still-serving sealed legacy engine's absent `releaseSha` field. Preserve frozen v1 files and original request/generation bytes, prove the full legacy image and live process, execute the original pure parser, then bind a truthful reconciliation failure to the original operation and retire its exact durable records.

Add a root-owned installer that verifies digest-addressed executable and manifest bytes, installs one exact inactive native unit, verifies the loaded contract, and records its installation. It never enables or starts the unit and refuses conflicting bytes or writable ancestors.

The 37 native cases exercise lost responses, creation interruption, partial cleanup, expired-authority readback, immutable outcomes, stale ownership, changed identities, installed-unit verification and zero engine-mutating commands. The existing required Vitest CI shard path executes the Python suite. Installation, live execution and terminal host proof remain the sole production owner's responsibility. Sanitized local evidence and exact source hashes are recorded in `docs/changelog/evidence/2026-09-11-legacy-sealed-release-reconciliation.json`.

See `docs/operations/legacy-sealed-release-reconciliation.md` for the exact installation interface, manifest fields, receipt semantics and readback limits.
