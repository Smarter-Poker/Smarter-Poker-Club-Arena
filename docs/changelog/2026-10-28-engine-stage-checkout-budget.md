# Engine staging checks out only its policy files

The engine staging detector timed out during checkout in run 40784960118,
before it could admit or offer the protected memory repair. It materialized
the full asset and runtime tree inside its three-minute budget.

Its checkout now selects `server/release` while retaining complete filtered
Git history. Admission still reads the reviewed window file. Runtime selection,
ancestry and changed-tree comparisons still inspect the complete Git tree,
including paths outside the sparse working tree. No release decision,
permission, timer, receiver, test or cutover safeguard changes.

A real Git fixture fails before this correction because assets and runtime
files are materialized. Afterward it verifies those files are absent, the
window policy is present, and the real detector still offers the latest
unserved runtime commit across a subsequent asset and client change.

The Chet's Game incident diagnostic independently confirms V8 heap exhaustion
at 2026-10-28 23:09:10 UTC. This checkout repair unblocks delivery; it is not
the runtime memory repair or proof that gameplay lag is resolved.
