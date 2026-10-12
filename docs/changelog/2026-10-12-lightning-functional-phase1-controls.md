# Lightning Functional Build Phase 1: Operator Setup Controls

The prepared pilot had no operator-screen control for its installed calibration-window setter and no supported integrity-telemetry toggle in the original operator door. Phase 1 adds both to the existing confirmation flow; it enables no game or worker and changes no wallet, seat or hand.

The bounded `set_integrity_telemetry` database action requires a typed boolean, valid operator authority, reason and request ID. The same row lock, idempotent response, audit event and preserved config update own the change. Setup is refused outside MUST-MOVE, during an unfinished drain or while a worker runs. The migration asserts exact qualified pre/post images and original owner/security/search path/grants for the operator control and two read models. Installed migrations remain immutable.

The dashboard carries the actual calibration window. Both new controls use persisted before/after state, input validation, duplicate-submit protection and the original unknown-ack retry identity. Missing readback remains unknown and unavailable. The existing painted console, confirmation focus handling, refusal messaging and discrete `lightning_operator_changed` event flow remain.

The eight-phase execution plan maps the previously authorized inventory to ordered work. The explicitly dispatched existing private-pilot setup now prepares integrity recording through the same authenticated audited door with a stable recovery request, then verifies its persisted configuration while keeping Lightning and its worker off. It creates no participant or financial fixture.

Phase 1 completion requires protected integration, exact migration installation/readback, publication and affected authenticated browser proof. No fixed calendar wait or automatic rollout is introduced.

Qualification includes real PostgreSQL 17 missing-door reproduction, authorization/type/reason/busy/drain guards, running-worker refusal, on/off persistence and read-model agreement, duplicate request with one audit event, ALREADY, unchanged money/stacks and exact migration reapplication in isolation. Client qualification covers range/precision, submit/refusal/unknown retry and safe availability. Production browser qualification exercises validation and cancel at mobile/desktop widths without writing a decision.

Real-time law: triggered by `lightning_operator_changed` discrete WS event, no snapshot diff.
