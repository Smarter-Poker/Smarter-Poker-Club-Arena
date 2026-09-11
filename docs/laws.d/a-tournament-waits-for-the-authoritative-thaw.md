# server/src/tournament/TournamentBreakLifecycleFence.test.ts

A running tournament retains its synchronized break and suspended level clock
until the authoritative maintenance freeze clears. Ninety seconds produces one
diagnostic, never permission to resume. A lifecycle fence ends the wait without
clearing persisted break state. Adoption of an expired countdown during an
ongoing freeze preserves the original remaining play time and durable level
anchor through repeated restarts. ResumeBlindClockBehavior.test.ts also checks
that ordinary post-break elapsed time is counted when no maintenance hold exists.
