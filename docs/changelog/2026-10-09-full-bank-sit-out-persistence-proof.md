# Full Bank Sit-Out Persistence Regression

The existing manual and automatic full-bank expiry tests now exercise the real
ServerTableEngine constructor persistence callback with a seat occupancy identity.
An isolated seat adapter observes the exact update predicates and applies them to
a current seat plus other-table, other-player, former-occupancy and departed-seat
controls. Both paths must persist sitting-out, preserve it through heartbeat and
clear it only after explicit return, without touching the control seats.

This extends the already deployed player-control fix with regression protection.
It changes no runtime, database migration, artwork or financial behavior. The
adapter proves the connected persistence request and guarded state transition;
it does not claim a real production bank-expiry hand or a PostgreSQL integration.

The required accounting gate exposed a separate qualification defect: its
Lightning stress harness treated every zero-formation budget stop as starvation.
An isolated deterministic call through the real matcher showed that a documented
formation lock retry can consume the existing budget and legitimately stop with
zero formations. The failed hosted run omitted that response payload, so its
specific contention cause cannot be reconstructed.

The harness now accepts only recorded formation-contention retries with the
supported retryable SQL states and a replan. Missing or unknown retries still
fail. Deterministic countercases run in the existing required harness, inside a
rolled-back fixture transaction: slow first planning must form a hand, bounded
retry must stop, and zero-attempt starvation must be rejected. Failure responses
are printed for diagnosis. Runtime budgets and financial assertions are preserved.

Validation: 13 persistence tests, server compilation, deterministic real-matcher
countercases, focused S1 with all 15 invariants, and 25 harness contract tests
passed. Required exact-candidate hosted checks remain necessary for delivery.

The next required runner exhausted Docker Hub's anonymous pull allowance while
fetching the pinned Prometheus verification image. Both connected offline rule
checks now use Prometheus's official Quay repository with the identical manifest
digest, verified from the registry response and independently hashed bytes.
Container isolation, rule fixtures and assertions are unchanged. Shell syntax and
source review pass locally; Docker is unavailable on this Mac, so actual
container execution remains a hosted prerequisite.
