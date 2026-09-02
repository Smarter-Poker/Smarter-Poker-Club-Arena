-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902163108; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

create index if not exists idx_tournaments_spin_created
  on public.tournaments (created_at)
  where variant = 'spin';

comment on index public.idx_tournaments_spin_created is
  'Serves the candidates CTE of fn_spin_unpaid_settlements, which is 2342ms of the 3741ms fn_spin_metrics spends per /metrics scrape. idx_tournaments_spin_draws cannot serve it: that index is partial on spin_multiplier IS NOT NULL, which this query does not imply, so the planner fell back to idx_tournaments_variant and heap-read all 41k spin rows to discard 38k.';

DO $$
DECLARE v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
  WHERE schemaname='public' AND indexname='idx_tournaments_spin_created';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'idx_tournaments_spin_created was not created';
  END IF;
  IF v_def NOT LIKE '%created_at%' OR v_def NOT LIKE '%spin%' THEN
    RAISE EXCEPTION 'index is not the shape claimed: %', v_def;
  END IF;
  RAISE NOTICE 'idx_tournaments_spin_created in place: %', v_def;
END $$;
