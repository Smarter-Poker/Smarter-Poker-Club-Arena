-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820161136 "union_rake_ledger_checkpoint"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a0f88f2d817eca369386f021f862ba24 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE INDEX IF NOT EXISTS idx_uwt_rake_wallet_recon
  ON public.union_wallet_transactions (union_id, created_at)
  INCLUDE (amount, direction)
  WHERE wallet = 'rake_wallet';

CREATE TABLE IF NOT EXISTS public.union_rake_ledger_checkpoint (
  union_id         uuid PRIMARY KEY,
  as_of            timestamptz NOT NULL,
  credits          numeric NOT NULL DEFAULT 0,
  debits           numeric NOT NULL DEFAULT 0,
  rows_seen        bigint  NOT NULL DEFAULT 0,
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.union_rake_ledger_checkpoint ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_union_rake_ledger_totals(p_union_id uuid)
RETURNS TABLE(total_credits numeric, total_debits numeric,
              total_rows bigint, checkpoint_as_of timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of  timestamptz;
  v_cr     numeric;
  v_db     numeric;
  v_rows   bigint;
  v_target timestamptz := now() - interval '1 hour';
  d_cr     numeric;
  d_db     numeric;
  d_rows   bigint;
BEGIN
  SELECT c.as_of, c.credits, c.debits, c.rows_seen
    INTO v_as_of, v_cr, v_db, v_rows
    FROM union_rake_ledger_checkpoint c WHERE c.union_id = p_union_id;
  IF NOT FOUND THEN
    v_as_of := '-infinity'::timestamptz; v_cr := 0; v_db := 0; v_rows := 0;
  END IF;

  IF v_target > v_as_of THEN
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('union_rake_ledger_cp:' || p_union_id::text, 42));

      SELECT c.as_of, c.credits, c.debits, c.rows_seen
        INTO v_as_of, v_cr, v_db, v_rows
        FROM union_rake_ledger_checkpoint c WHERE c.union_id = p_union_id;
      IF NOT FOUND THEN
        v_as_of := '-infinity'::timestamptz; v_cr := 0; v_db := 0; v_rows := 0;
      END IF;

      IF v_target > v_as_of THEN
        SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'credit'), 0),
               COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit'), 0),
               COUNT(*)
          INTO d_cr, d_db, d_rows
          FROM union_wallet_transactions t
         WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet'
           AND t.created_at >= v_as_of AND t.created_at < v_target;

        INSERT INTO union_rake_ledger_checkpoint
              (union_id, as_of, credits, debits, rows_seen, last_verified_at, updated_at)
        VALUES (p_union_id, v_target, v_cr + d_cr, v_db + d_db, v_rows + d_rows, now(), now())
        ON CONFLICT (union_id) DO UPDATE
          SET as_of     = EXCLUDED.as_of,
              credits   = EXCLUDED.credits,
              debits    = EXCLUDED.debits,
              rows_seen = EXCLUDED.rows_seen,
              updated_at = now();

        v_as_of := v_target;
        v_cr    := v_cr + d_cr;
        v_db    := v_db + d_db;
        v_rows  := v_rows + d_rows;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN QUERY
  SELECT v_cr   + COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'credit'), 0),
         v_db   + COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit'), 0),
         v_rows + COUNT(t.*),
         v_as_of
    FROM union_wallet_transactions t
   WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet'
     AND t.created_at >= v_as_of;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_rake_ledger_checkpoint_verify(p_union_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_target   timestamptz := now() - interval '1 hour';
  v_cr       numeric; v_db numeric; v_rows bigint;
  v_old_cr   numeric; v_old_db numeric; v_old_as_of timestamptz;
  v_tail_cr  numeric; v_tail_db numeric;
  v_believed numeric; v_truth numeric; v_drift numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('union_rake_ledger_cp:' || p_union_id::text, 42));

  SELECT c.credits, c.debits, c.as_of
    INTO v_old_cr, v_old_db, v_old_as_of
    FROM union_rake_ledger_checkpoint c WHERE c.union_id = p_union_id;

  SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'credit'), 0),
         COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit'), 0),
         COUNT(*)
    INTO v_cr, v_db, v_rows
    FROM union_wallet_transactions t
   WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet'
     AND t.created_at < v_target;
  v_truth := v_cr - v_db;

  IF v_old_as_of IS NOT NULL THEN
    SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'credit'), 0),
           COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit'), 0)
      INTO v_tail_cr, v_tail_db
      FROM union_wallet_transactions t
     WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet'
       AND t.created_at >= v_old_as_of AND t.created_at < v_target;
    v_believed := (v_old_cr + v_tail_cr) - (v_old_db + v_tail_db);
    v_drift    := round(v_believed - v_truth, 2);
  END IF;

  INSERT INTO union_rake_ledger_checkpoint
        (union_id, as_of, credits, debits, rows_seen, last_verified_at, updated_at)
  VALUES (p_union_id, v_target, v_cr, v_db, v_rows, now(), now())
  ON CONFLICT (union_id) DO UPDATE
    SET as_of            = EXCLUDED.as_of,
        credits          = EXCLUDED.credits,
        debits           = EXCLUDED.debits,
        rows_seen        = EXCLUDED.rows_seen,
        last_verified_at = now(),
        updated_at       = now();

  IF COALESCE(v_drift, 0) <> 0 THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_union_rake_ledger_checkpoint_verify',
           'Union rake ledger checkpoint drifted from recomputed truth',
           jsonb_build_object('union_id', p_union_id, 'drift', v_drift,
                              'believed', v_believed, 'truth', v_truth)
     WHERE NOT EXISTS (
       SELECT 1 FROM financial_alerts
        WHERE source = 'fn_union_rake_ledger_checkpoint_verify'
          AND resolved IS NOT TRUE
          AND context->>'union_id' = p_union_id::text);
  END IF;

  RETURN jsonb_build_object(
    'union_id', p_union_id, 'as_of', v_target,
    'credits', v_cr, 'debits', v_db, 'rows_seen', v_rows,
    'net', v_truth, 'drift', COALESCE(v_drift, 0));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_rake_ledger_totals(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_rake_ledger_checkpoint_verify(uuid)
  FROM PUBLIC, anon, authenticated;
