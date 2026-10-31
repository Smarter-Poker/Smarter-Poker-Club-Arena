# Delivery validation follows changed inputs and measured shard work

Existing publisher runs 41130993335 and 41216398631 took 6m16s and 6m01s.
These are publication paths, not the full PR financial suite. Dependency caches
hit; restores took seconds, so no speculative cache redesign is included.

The compiler job spent 421s on isolated financial replay and 81s on fleet-rule
evaluation in run 41200651455. An immutable modification-only CSS/raster proof
now omits only these unchanged simulations. Full compiler, source invariants,
unit/browser selection and artwork scanning remain; malformed CSS, mixed code,
SQL, workflow, unknown/dirty input, additions and deletions retain full replay.
The existing narrower presentation/configuration test-selection proof is unchanged.

The same run's accounting shards took 1785/1414/2195/2033 seconds. Diamond SQL
listing, acceptance and evidence move together from shard 3 to shard 2; the
independent backed-payout scan moves from 4 to 2. Every command, timeout,
assertion, evidence artifact and fail-closed aggregate is retained. Both groups
own isolated clusters and need no other shard's runtime state or isolation tool.
No paid capacity, extra matrix jobs, runtime changes or production SQL are added.

Active qualification bindings record source wiring only, not financial or live
recertification. Final normal hosted execution and timing evidence are recorded
in the delivery checkpoint; before/after figures are observational, not promises.
