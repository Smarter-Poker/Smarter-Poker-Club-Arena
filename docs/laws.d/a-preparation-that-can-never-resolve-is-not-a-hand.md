# tests/a-preparation-that-can-never-resolve-is-not-a-hand.law.test.ts

Engine 8825af51 held one tournament hand permit that could never resolve in
that process, and every layer above read "unresolved" as "a hand may be in the
air": the break counted the table unparked, `readyForRestart` stayed shut, and
the release transaction refused the cutover - which was the only thing that
could replace the process holding the permit. 70 of its 71 breaks certified no
restart, `unparked_at_countdown` 1 at every countdown, while `thaw_ok` stayed
true and ~158 tables resumed each time; the poker was fine and only the deploy
route was dead, for 57 hours, with 6 lease-less RUNNING tournaments, 49 seats
and 4,908,000 tournament chips frozen behind it. The permit itself (14cddb92,
table 9f30d335, hand 12943630, `aborted_unsettled`) had zero dispatch rows,
zero snapshots and zero commits - the hand provably never started. This pins
the three halves of the fix: the engine answers truthfully for a stopped
generation while still carrying every conjunct that proves no move is in
flight and still replaying a pending move to a receipt; both preparation
blocker classes share one bound instead of only the per-engine one; and the
release gate asks the database whether a hand is actually in the air, by an
allow-list of preparation reasons only, with the engine's own
`handsInFlightTotal` as a second witness, freshness-bounded so a month-old
incomplete snapshot is not mistaken for a live hand, three outcomes rather
than two, failing closed on "could not tell", and with no flag, variable or
argument that can turn a refusal into permission.

Section 5 (2026-09-23) pins the same discipline for
`terminalBoundaryPersistenceFailed`: build 8825af51 sets it when a hand fails
to start or settle and never clears it on a stopped engine, so every release
refused on `captureEngine.engine_work_not_drained` with `boundary=0/true` on a
dead engine. On an engine that is stopped, terminal, with no hand controller,
no recovery in flight and an empty live bank map, the flag now defers the
table to `proveUnresolvableCustody`, which reads the rows before anything is
written; on any other engine it refuses exactly as before, in both the capture
and `physical()`.
