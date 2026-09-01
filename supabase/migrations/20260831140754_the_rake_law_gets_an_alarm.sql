-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831140754; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.ca_rake_schedule (
  sb           numeric NOT NULL,
  bb           numeric NOT NULL,
  rake_percent numeric NOT NULL,
  rake_cap     numeric NOT NULL,
  bbj_fee_bb   numeric NOT NULL,
  PRIMARY KEY (sb, bb)
);

INSERT INTO public.ca_rake_schedule (sb, bb, rake_percent, rake_cap, bbj_fee_bb) VALUES
  (0.1,  0.2, 10,  3.0,  0.6),
  (0.2,  0.4, 10,  3.0,  0.6),
  (0.25, 0.5, 10,  3.0,  0.6),
  (0.3,  0.6, 10,  5.0,  0.6),
  (0.5,  1.0, 10,  5.0,  0.25),
  (1,    2,   10,  5.0,  0.25),
  (2,    4,   10,  7.5,  0.12),
  (2,    5,   10,  7.5,  0.12),
  (5,    5,   10,  7.5,  0.12),
  (3,    6,   10,  8.0,  0.12),
  (4,    8,   10, 10.0,  0.12),
  (5,   10,   10, 12.5,  0.06),
  (10,  20,   10, 15.0,  0.06),
  (10,  25,   10, 15.0,  0.06)
ON CONFLICT (sb, bb) DO UPDATE
  SET rake_percent = EXCLUDED.rake_percent,
      rake_cap     = EXCLUDED.rake_cap,
      bbj_fee_bb   = EXCLUDED.bbj_fee_bb;

CREATE TABLE IF NOT EXISTS public.ca_rake_tier (
  label        text PRIMARY KEY,
  min_bb       numeric NOT NULL,
  max_bb       numeric,
  rake_percent numeric NOT NULL,
  rake_cap     numeric NOT NULL,
  bbj_fee_bb   numeric NOT NULL
);

INSERT INTO public.ca_rake_tier (label, min_bb, max_bb, rake_percent, rake_cap, bbj_fee_bb) VALUES
  ('nano',        0.1,  0.2, 10,  3.0, 0.6),
  ('micro',       0.3,  0.8, 10,  3.0, 0.6),
  ('small',       1.0,  3.0, 10,  5.0, 0.25),
  ('mid',         3.5,  8.0, 10,  8.0, 0.12),
  ('high',        9.0, 40.0, 10, 15.0, 0.06),
  ('nosebleeds', 41.0, NULL, 10, 20.0, 0.03)
ON CONFLICT (label) DO UPDATE
  SET min_bb = EXCLUDED.min_bb, max_bb = EXCLUDED.max_bb,
      rake_percent = EXCLUDED.rake_percent, rake_cap = EXCLUDED.rake_cap,
      bbj_fee_bb = EXCLUDED.bbj_fee_bb;

COMMENT ON TABLE public.ca_rake_schedule IS
  'Mirror of RAKE_SCHEDULE in src/config/RakeConfig.ts. rake_cap is an absolute amount. Read only by the rake-law alarm; the engine uses its own copy.';
COMMENT ON TABLE public.ca_rake_tier IS
  'Mirror of STAKES_TIERS in src/config/RakeConfig.ts. Covers stakes the schedule does not name. max_bb NULL is the open top end.';

CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb),
    (SELECT t.rake_cap FROM public.ca_rake_tier t
      WHERE p_bb >= t.min_bb AND (t.max_bb IS NULL OR p_bb <= t.max_bb)
      ORDER BY t.min_bb DESC LIMIT 1)
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '1 hour')
RETURNS TABLE (
  kind          text,
  hand_id       uuid,
  table_id      uuid,
  occurred_at   timestamptz,
  small_blind   numeric,
  big_blind     numeric,
  pot           numeric,
  rake          numeric,
  allowed       numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at, hh.rake_amount AS rake,
           hh.pot_size AS pot, t.small_blind AS sb, t.big_blind AS bb,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           (SELECT count(*) FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
             WHERE a->>'action' IN ('call','raise','bet','allin','all-in')) AS agg
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) > 0
  ), r AS (
    SELECT h.*, public.fn_effective_rake_cap(h.sb, h.bb) AS cap FROM h
  )
  SELECT 'over_cap', id, table_id, created_at, sb, bb, pot, rake, cap
    FROM r WHERE cap IS NOT NULL AND rake > cap + 0.005
  UNION ALL
  SELECT 'over_percent', id, table_id, created_at, sb, bb, pot, rake,
         round(pot * 0.10, 2)
    FROM r WHERE rake > pot * 0.10 + 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0
    FROM r WHERE board_n < 3 AND NOT has_showdown AND agg <= 3
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, rake
    FROM r WHERE board_n < 3 AND (has_showdown OR agg > 3);
$$;

CREATE OR REPLACE FUNCTION public.fn_rake_law_check(p_window interval DEFAULT '2 hours')
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_rake_law_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       drift, severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'rake_law', v.table_id,
           v.allowed, v.rake, round(v.rake - v.allowed, 2),
           CASE WHEN v.kind = 'board_not_recorded' THEN 'warning' ELSE 'critical' END,
           jsonb_build_object(
             'kind', v.kind,
             'hand_id', v.hand_id,
             'occurred_at', v.occurred_at,
             'stake', v.small_blind::text || '/' || v.big_blind::text,
             'pot', v.pot),
           v.kind || ': raked ' || v.rake::text || ' where ' || v.allowed::text || ' was owed'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'rake_law'
          AND l.metadata->>'hand_id' = v.hand_id::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_law_violations(interval)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_law_check(interval)             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_violations(interval)        TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_check(interval)             TO service_role;

SELECT cron.schedule('rake-law-adherence-hourly', '40 * * * *',
                     $cron$SELECT public.fn_rake_law_check('2 hours'::interval);$cron$);
