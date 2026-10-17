# tests/rollback-drills-ride-the-release-lane.law.test.ts

A live rollback/restore drill (DA10: a rollback, then a roll-forward) runs only through `.github/workflows/engine-rollback-drill.yml`. That workflow is a default-branch repository event that binds the drill to one run key and hands it to the unchanged durable Hetzner release transaction. The law pins:

- the event-only triggers and the single rollback-drill lane;
- the strict production-door check for every drill target;
- that a drill never writes a deploy receipt;
- that the transaction takes its drill mode (rollback or rollforward only; the crash drill has its own route) only from the root-owned record bound to the run key;
- that it prepares the seal's audited rollback mode only for a rollback, past the locked restart certificate and rollback readiness;
- that it never spends the off-cycle window or makes a release stand aside;
- that it admits an older target only above both compatibility floors, and only if this host already sealed it.

It executes the real drill shell in `tests/operations/engine-drill-admission.py`.
