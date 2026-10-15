# Phase 7 preserves an incident already resolved

At 22:13 UTC the guard-drift incident and alert had already been resolved at 21:34:39 by another operator. The merged, uninstalled Phase 7 migration called the non-idempotent incident action again, which would rewrite the existing time and explanation and emit a second event/notification.

Migration 20261015221949 supersedes the uninstalled 20261015182553. Its four incident calls first select and lock only an unresolved row; a concurrent resolution is rechecked after the lock wait. All source preimages, postimages, permissions, cause assertions, financial-alert predicates and final closure checks are preserved. It refuses if the predecessor is already installed. Stored function bodies are unchanged.

The existing required floor-owner native driver also runs the exact Phase 7 action statements against the captured actual incident authority in isolated PostgreSQL 17. The regression proves the predecessor overwrites a resolution, while the successor preserves its full row and emits nothing; open incidents still resolve once, repeated requests do nothing, concurrent resolution wins, and transaction rollback undoes closure events. The captured authority hash is exact and a changed body is refused. Notification delivery is a fixture, not a production delivery claim.

The 42-day read took about 20 seconds during read-only production validation. The predecessor ran it after locking the club treasury row. Its unchanged assertion now runs before taking that financial lock or resolving any incident, keeping the treasury comparison atomic without retaining the lock during the broad scan. A source-order regression pins this boundary.
