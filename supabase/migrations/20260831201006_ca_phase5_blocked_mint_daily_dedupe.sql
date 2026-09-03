-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831201006; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_blocked_mint_daily_dedupe (prod 20260831201006). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5: tournament-mint-blocked warnings dedupe daily-global (31 per-table incidents for one root cause was notification spam).

-- ZERO-DRIFT phase 5: the tournament-mint guards dedupe per TABLE, so an
-- engine that retries exits across a fleet of horse tables opened 31 separate
-- warning incidents in 35 minutes — 31 notification streams for ONE root
-- cause (the engine exit path, fix already queued in the phase-5 PR). The
-- dedupe key becomes daily-global: one incident per day, occurrences count
-- the attempts, per-table detail stays in the metadata of each bump.
DO $$
DECLARE v_def text; v_new text; fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['atomic_table_cashout(uuid,uuid,integer)',
                            'atomic_credit_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid,text)'] LOOP
    v_def := pg_get_functiondef(('public.' || fn)::regprocedure);
    v_new := replace(v_def,
      '''tourney-cashout-blocked:'' || p_table_id::text',
      '''tourney-cashout-blocked:'' || to_char(now(), ''YYYY-MM-DD'')');
    IF v_new <> v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END $$;
