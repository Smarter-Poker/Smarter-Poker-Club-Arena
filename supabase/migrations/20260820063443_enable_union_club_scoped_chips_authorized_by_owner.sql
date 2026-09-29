-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820063443 "enable_union_club_scoped_chips_authorized_by_owner"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b51d57a3759a87287a5540a2aeacbcb4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Authorised by Dan (owner) 2026-08-20: "proceed" / "finish this job up".
-- Turns on per-club chip custody. Preflight completed: single buy-in
-- implementation (legacy non-club-aware overload dropped and verified safe on
-- production), engine-shaped call proven end to end in a rolled-back
-- transaction, legacy seats cash out to the global wallet by seat stamp.
-- Rollback: set value='off' on the same row.
UPDATE public.platform_policies
   SET value = 'on', updated_at = now()
 WHERE key = 'union.club_scoped_chips';

