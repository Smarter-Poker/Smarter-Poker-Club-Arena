# Explicit release reads do not wait for ordinary audits

The read-only c857 inspector observation `40977095033` waited behind the
ordinary audit's `Nothing is silently red on main` job while the release owner
needed its original transaction evidence. Runtime-log observations already had
per-run concurrency, but release-recovery observations still shared the audit's
single pending slot and also selected its ordinary jobs.

The existing Production Integrity Audit workflow now gives an explicit
`release_recovery_observation` its own per-run observation group and excludes
that request from the nine ordinary audit jobs. Scheduled and generic audit
requests retain their group and jobs. The release reader, native qualification,
ownership checks, limits, transport, permissions and artifact remain unchanged.
There is no new event, publisher, release action, runner or schedule.

Two regressions execute the maintained workflow expressions: distinct release
reads receive distinct groups; ordinary schedules and generic requests retain
their behavior; explicit release requests run the qualified reader without the
ordinary audits. Both fail against the previous workflow. This source fix does
not cancel, replace or retry the existing observation or activate an engine.
