-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902012048; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.money_check_heartbeat (
  check_name                text PRIMARY KEY,
  expected_interval_minutes integer     NOT NULL,
  last_run_at               timestamptz,
  last_result               jsonb,
  run_count                 bigint      NOT NULL DEFAULT 0,
  registered_at             timestamptz NOT NULL DEFAULT now(),
  note                      text
);

COMMENT ON TABLE public.money_check_heartbeat IS
  'One row per money check the engine is expected to run, with the last time it actually did. Seeded with the expected set so a check that has NEVER run is stale rather than invisible.';

INSERT INTO public.money_check_heartbeat (check_name, expected_interval_minutes, note) VALUES
  ('fn_payout_guarantee_check',          60,  'vacant paid places, unpaid earners, retained bounty pools, unrecorded payouts'),
  ('fn_cash_pot_conservation_check',     60,  'pot = rake + bbj + awarded, on every completed cash hand'),
  ('fn_backpay_unfinalised_bounty_pools',60,  'settles a funded bounty pool a completed event never paid out'),
  ('fn_pay_backed_payout_shortfalls',    60,  'pays what an event still owes when the event is holding the chips'),
  ('fn_detect_results_without_a_hand',   360, 'a result no poker produced'),
  ('fn_tournament_money_conservation',   360, 'per-event money in against money out')
ON CONFLICT (check_name) DO UPDATE
  SET expected_interval_minutes = EXCLUDED.expected_interval_minutes,
      note = EXCLUDED.note;

CREATE OR REPLACE FUNCTION public.fn_record_money_check_run(
  p_check  text,
  p_result jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text := left(nullif(btrim(coalesce(p_check, '')), ''), 200);
BEGIN
  IF v_name IS NULL THEN RETURN; END IF;

  INSERT INTO public.money_check_heartbeat
    (check_name, expected_interval_minutes, last_run_at, last_result, run_count)
  VALUES (v_name, 60, now(), p_result, 1)
  ON CONFLICT (check_name) DO UPDATE
    SET last_run_at = now(),
        last_result = EXCLUDED.last_result,
        run_count   = public.money_check_heartbeat.run_count + 1;
EXCEPTION WHEN OTHERS THEN
  -- Swallowed on purpose, and this is the ONE place in this audit where that
  -- is right: the caller has just finished a money check and the heartbeat is
  -- bookkeeping about that check, not part of it.
  NULL;
END;
$function$;

COMMENT ON FUNCTION public.fn_record_money_check_run(text, jsonb) IS
  'Records that a money check just ran. Called by the driver, not by the check, because what needs proving is that the engine is executing it on its timer.';

REVOKE ALL ON FUNCTION public.fn_record_money_check_run(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_money_check_run(text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_money_check_health(
  p_stale_multiple numeric DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mult    numeric := GREATEST(COALESCE(p_stale_multiple, 3), 1);
  v_rows    jsonb   := '[]'::jsonb;
  v_stale   integer := 0;
  v_never   integer := 0;
  v_alerts  integer := 0;
  r         record;
BEGIN
  FOR r IN
    SELECT h.check_name, h.expected_interval_minutes AS every_min, h.last_run_at,
           h.run_count, h.note,
           CASE WHEN h.last_run_at IS NULL THEN NULL
                ELSE round(EXTRACT(epoch FROM (now() - h.last_run_at)) / 60.0, 1)
           END AS age_min
      FROM public.money_check_heartbeat h
     ORDER BY h.check_name
  LOOP
    DECLARE
      v_is_stale boolean := (r.last_run_at IS NULL)
                            OR (r.age_min > r.every_min * v_mult);
    BEGIN
      v_rows := v_rows || jsonb_build_object(
        'check', r.check_name, 'every_minutes', r.every_min,
        'last_run_at', r.last_run_at, 'age_minutes', r.age_min,
        'runs', r.run_count, 'stale', v_is_stale);

      IF v_is_stale THEN
        v_stale := v_stale + 1;
        IF r.last_run_at IS NULL THEN v_never := v_never + 1; END IF;

        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_money_check_health',
          CASE WHEN r.last_run_at IS NULL THEN
            format('%s has never run. It is expected every %s minutes, and until it does its silence means nothing.',
                   r.check_name, r.every_min)
          ELSE
            format('%s last ran %s minutes ago and is expected every %s. A check that stops looks exactly like a check finding nothing.',
                   r.check_name, r.age_min, r.every_min)
          END,
          jsonb_build_object('kind','money_check_stale','check', r.check_name,
            'every_minutes', r.every_min, 'last_run_at', r.last_run_at,
            'age_minutes', r.age_min, 'runs', r.run_count, 'purpose', r.note,
            'detail','no money was moved by this check'),
          r.check_name);
        v_alerts := v_alerts + 1;
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'stale_multiple', v_mult,
    'checks', jsonb_array_length(v_rows),
    'stale', v_stale,
    'never_run', v_never,
    'conditions_alerted', v_alerts,
    'board', v_rows);
END;
$function$;

COMMENT ON FUNCTION public.fn_money_check_health(numeric) IS
  'The health of every money check in one call: when each last ran, how overdue it is, and a deduped critical for any that has gone quiet. Answers the question none of the individual checks can - whether their zeros mean anything.';

REVOKE ALL ON FUNCTION public.fn_money_check_health(numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_money_check_health(numeric) TO service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.money_check_heartbeat) < 6 THEN
    RAISE EXCEPTION 'the money check registry did not seed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_money_check_health') THEN
    RAISE EXCEPTION 'fn_money_check_health was not created';
  END IF;
END $$;
