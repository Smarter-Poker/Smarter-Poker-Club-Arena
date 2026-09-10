# Terminal Rehearsal Entry Windows

Before: the shared SQL fixture omits entry window fields (scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql, lines 40-50). PostgreSQL supplies current_level=0, late_reg_levels=0, late_reg_mins=60 and rebuy_levels=4. The exact pool guard therefore refuses closure before level 4. Three terminal acceptance probes fail at this unrelated entry-window boundary before testing money rollback or replay.

Change: make the shared terminal template an event whose published level and timed entry windows have closed. Preserve rebuy-specific overrides in atomic-tournament-hand-boundary.sql. Add a rollback-only native check that exercises the real pool guard on a temporary table; no production authority is modified.

Phase 3 remains open. M5 replay separately refuses the schema-only donor satellite receipt ACL. Automatic review rejected restoring that source into the disposable database, so this patch does not retry the rejected operation or certify the full cutover.

Verification: six real PostgreSQL guard scenarios passed with the complete fixture rolled back. Four existing source guard files cover 61 unique tests; 60 passed on the first run and one filesystem scan timed out. The unchanged affected file then passed all five tests in isolation. TypeScript compilation could not be certified: the first attempt saw an incomplete dependency copy, and the next exited 2 during full-disk exhaustion without recorded diagnostics. No TypeScript source changed. The disposable dependency copy was removed to recover space.
