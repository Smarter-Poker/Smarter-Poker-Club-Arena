# Tournament recovery refusals reach the diagnostic route

The authenticated tournament diagnostic response removed the recovery refusal
and movement evidence that `TournamentManagerBase` already captured. On
2026-09-30, the scoped observation of MTT table
`45fb11c2-3263-404d-8518-bdf7046e4add` proved its dealer had stopped and joined
its writers, but could not report the manager's reason for retaining it.

The fixed serialization allowlist now includes the existing refusal, its absent
value semantics, the claimed movement boundary and the retained permit's status
and phase. It still excludes arbitrary fields and the permit's custody binding;
authentication, scope and response limits are unchanged.

The route regression failed before the fix because the refusal and movement
fields disappeared. It covers retained, absent and unavailable permit evidence
and verifies that unknown manager fields and custody identifiers remain stripped.
This change restores diagnostic evidence only. It does not claim to repair the
observed table stall or authorize any recovery action.
