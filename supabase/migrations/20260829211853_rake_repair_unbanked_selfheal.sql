-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829211853; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET statement_timeout = '600s';

-- Rake self-heal for hands the engine did not survive to bank. See the
-- repo migration 20260829i for the full rationale. Key facts: 28 hands lost
-- in one 20-second restart burst at 19:51 UTC, 29 more in the 8h BEFORE the
-- weighted deploy — a pre-existing, restart-correlated leak. Banks via
-- atomic_distribute_rake (idempotent) from what hand_history durably holds;
-- p_contributions NULL — no attribution is invented (contributions died with
-- the engine). The BBJ slice is then banked by the existing BBJ self-heal,
-- which works from rake_records.
CREATE OR REPLACE FUNCTION public.fn_rake_repair_unbanked(p_since_hours integer DEFAULT 48, p_limit integer DEFAULT 200)
RETURNS TABLE(hand_id uuid, club_id uuid, amount numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '540s'
AS $function$
DECLARE
  r record;
  v_repaired int := 0;
  v_chips numeric := 0;
BEGIN
  FOR r IN
    SELECT hh.id AS h_id, hh.table_id, t.club_id AS c_id, hh.hand_number,
           hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj, hh.pot_size,
           hh.created_at AS h_at,
           CASE WHEN hh.created_at >= '2026-08-29 14:41+00'::timestamptz
                THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END AS method
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.tournament_id IS NULL
       AND t.tournament_id IS NULL
       AND hh.rake_amount > 0
       AND hh.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_since_hours, 48), 1))
       AND hh.created_at < now() - interval '5 minutes'
       AND t.club_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)
       -- time-bounded so the probe rides the created_at index: a hand's rake
       -- row is written within minutes (re-drives within hours) of the hand
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr2
                        WHERE rr2.table_id = hh.table_id
                          AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                 AND hh.created_at + interval '12 hours'
                          AND rr2.metadata->>'hand_number' = hh.hand_number::text)
       AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p
                        WHERE p.resolved_at IS NULL AND p.kind = 'rake'
                          AND (p.hand_id = hh.id OR p.hand_number = hh.hand_number))
     ORDER BY hh.created_at
     LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    BEGIN
      PERFORM public.atomic_distribute_rake(
        r.table_id, r.c_id, r.h_id, r.hand_number::integer, r.rake_amount,
        r.bbj, r.pot_size, NULL, NULL, NULL, NULL, r.method);
      v_repaired := v_repaired + 1;
      v_chips := v_chips + r.rake_amount;
      hand_id := r.h_id; club_id := r.c_id; amount := r.rake_amount;
      RETURN NEXT;
    EXCEPTION WHEN others THEN
      NULL; -- next cycle retries; the candidate predicate re-evaluates
    END;
  END LOOP;

  IF v_repaired > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at)
    VALUES (CASE WHEN v_chips > 50 THEN 'warning' ELSE 'info' END,
            'fn_rake_repair_unbanked',
            'Recovered ' || v_repaired || ' unbanked rake hand(s) totalling ' ||
              round(v_chips, 2) || ' chips (engine did not survive to bank them). ' ||
              'Attribution not invented: contributions were lost with the engine.',
            jsonb_build_object('repaired', v_repaired, 'chips', round(v_chips, 2)),
            (v_chips <= 50), CASE WHEN v_chips <= 50 THEN now() ELSE NULL END);
  END IF;

  RETURN;
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_repair_unbanked(integer, integer) TO service_role;

-- Hourly, same advisory-lock pattern as the project's other heal jobs.
SELECT cron.schedule('rake-repair-unbanked-hourly', '52 * * * *', $cron$
  select case
           when pg_try_advisory_lock(hashtext('rake-repair-unbanked'))
             then (select count(*) from public.fn_rake_repair_unbanked(48, 200))::text
           else 'skipped: previous run still in progress'
         end;
$cron$);
