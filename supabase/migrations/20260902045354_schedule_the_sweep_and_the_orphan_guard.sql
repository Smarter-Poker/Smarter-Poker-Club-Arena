-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902045354; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- One job runs twelve conservation checks and raises an incident for any that
-- reports a finding. One job a day names anything still unrun. Offset from the
-- money checks at :00/:15/:30/:45/:47 and the ratchet at :35.
SELECT cron.schedule('ca-conservation-sweep-hourly', '52 * * * *',
                     $cron$ SELECT public.fn_ca_conservation_sweep(); $cron$);

SELECT cron.schedule('ca-orphaned-checks-daily', '18 6 * * *',
                     $cron$ SELECT public.fn_ca_orphaned_checks_watch(); $cron$);

