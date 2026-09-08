# Elimination Callback Authority

## Production Crash

At approximately 15:53 UTC the public health endpoint returned 503 from a
new standby process running adf1a2c3. Engine logs recorded an unhandled
rejection: Tournament data authority cannot be rebound inside another manager
context. The stack passed through a bound isActive callback, elimination
scheduler pump/enqueue/finish, and the process fatal-rejection handler.

The scheduler is process-wide. Promise continuations and the shared wake timer
inherit the context of the manager that dispatched or woke them. A completion
for tournament A can therefore call B's bound predicate inside A's authority.
The authority guard correctly refuses; the shared scheduler chose the wrong
context. Removing that guard would permit cross-tournament writes and is not
an acceptable repair.

## Repair And Verification

At registration, AsyncResource.bind captures the context for run and isActive.
Every later invocation restores that registration context before the existing
immutable manager binder runs. The shared queue, timer, concurrency bound and
unregister fencing retain their behavior. No data-actor guard was changed.

19 tests passed across the scheduler, new cross-manager reproduction, and data
actor contexts; server tsc --noEmit passed. The new test also runs against the
original scheduler to establish that the captured production error is caught.
The fixed test verifies the manager context survives awaits and that attempting
to change authority inside actual manager work still throws.

No production mutation or forced restart was used. Publication and normal
engine adoption remain separate verification steps. This crash explains a
concrete loss-of-engine path; it is not proof that every iPad connection or
hand-delay issue is resolved.
