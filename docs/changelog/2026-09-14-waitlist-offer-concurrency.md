# Exclusive offers share the real seat and player claims

Two native PostgreSQL sessions reproduced two defects in the deployed offer function. Different players could both be promised the last chair before either transaction committed. One player could receive offers on two tables even when the configured hold limit was one. Locking separate waitlist rows did not protect either shared allowance.

The offer function now takes the existing table admission key before reading capacity. It uses actual seats, current reservations and pending non-swap moves, with the original fallback expiry retained for older holds. A separate player claim serializes concurrent automatic offers, and the configured allowance is checked again after that claim. Busy claims do not wait while holding other queue locks: the table remains untouched or the next eligible queue member is considered. Queue entries remain available to the existing event caller and expiry sweep.

The engine still calls the same RPC after a committed departure. The direct game-join function and the existing expiry sweep remain the other qualified callers. Policy values, human and horse queue eligibility, the notification writer, expiry delivery flags, and financial buy-in authority are preserved.

The PostgreSQL 17 suite runs the actual captured offer, capacity, game-join, sweep, barred-entry and authentication helper definitions. Its 46 checks cover the two original races, real cross-caller lock contention, rollback, notification failure, queue progress, configured limits, legacy expiry, pending moves, stale lobby counts, service-only access and migration drift refusal. It runs in the required accounting CI job. The isolated fixture has no notification delivery triggers and sends no messages.

This qualification covers exclusive offer creation. Historical impact, financial purchase completion and the broader operational alert backlog require their own evidence. Production installation and natural behavior must be verified separately from these local results.
