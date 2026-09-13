# Maintenance Break Recovery Drill

The former drill used direct root SSH and an ad hoc container kill. That path
is retired: a workstation may not mutate, restart, or publish the Club Arena
engine.

A live crash drill may run only after it is implemented as a reviewed,
default-branch Club Arena repository event with all of these controls:

- exact full merged SHA and pinned Hetzner host identity;
- explicit incident/drill authorization and a single owning release lane;
- table-safe maintenance-break admission before any process mutation;
- immutable before/after engine provenance and runtime-write receipts;
- automatic refusal when active-table or freeze preconditions are unclear;
- cache-busted health and hand-progression verification after recovery.

Until that controlled path exists, use the unit, integration, and rolled-back
database tests for maintenance-break recovery. Do not reproduce the retired
direct SSH/container commands from historical changelogs.
