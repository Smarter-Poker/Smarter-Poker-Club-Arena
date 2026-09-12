# The Fixture Uses The Real Scheduler Library

The isolated qualification fixture builds the real pg_cron 1.6.4 extension with Supabase's pinned heap-table patch. It verifies seven native C functions and their service ownership, then exercises scheduling, alteration, both unschedule forms, application DDL refusal and transaction rollback. Background job execution stays disabled in this fixture.

This replaces the prerequisite for three handwritten scheduler helpers in the older schema input. That input still requires a separately guarded composition before full-schema or funded-route qualification; this change alone does not accept either. Compilation and dependency installation run only in disposable Linux CI.
