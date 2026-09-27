-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501031657 "x45b_dedupe_all_agent_commissions_then_unique"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 575de7e7e8c5d46a8aa627a1aa632ed9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 45 fix continued: dedupe agent_commissions across ALL source_type
-- values (not just rake_settlement) before creating the unique index.
-- The earlier migration filtered to source_type='rake_settlement' but a few
-- legacy rows have source_type='rake' (older naming).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, source_id, source_type
           ORDER BY created_at ASC
         ) AS rn
  FROM public.agent_commissions
  WHERE source_id IS NOT NULL
)
DELETE FROM public.agent_commissions
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_commissions_source
  ON public.agent_commissions (user_id, source_id, source_type)
  WHERE source_id IS NOT NULL;
