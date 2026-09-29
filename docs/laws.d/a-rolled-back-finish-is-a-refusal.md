# server/src/tournament/aRolledBackFinishIsARefusal.law.test.ts

A tournament finish whose every attempt the database answered with a SQLSTATE rollback (the 2026-09-26 02:30 lock-timeout storm on the platform finish lane) is a retryable refusal, not an unknown outcome that fences the manager; a lost response, a thrown transport failure, an unverifiable success or a resolver that reports a commit keeps the outcome unknown and fail-closed.
