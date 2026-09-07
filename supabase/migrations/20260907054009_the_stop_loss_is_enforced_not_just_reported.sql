-- THE STOP LOSS IS ENFORCED, NOT JUST REPORTED
-- =============================================================================
-- Measured against how club unions on PPPoker, PokerBros, ClubGG and Upoker
-- actually run their weekly accounting. Most of that model is already built
-- here and matches: weekly settlement, a union fee kept out of rake with the
-- rest paid back to the club, agent and sub-agent commission tiers, bad-beat
-- contributions, presettlement during the week, and a settlement due date. Our
-- due_at of period_end + 3 days lands at midnight Pacific on Wednesday night,
-- which is exactly the "settle by end of Wednesday in the union's time zone"
-- charter those unions publish.
--
-- Two things did not match, and one of them is a bug of a class already fixed
-- elsewhere tonight.
--
-- 1. PRESETTLEMENT WINDOW, in fn_union_club_exposure.
--    The exposure calculation counted only presettlements with
--        received_at >= v_start
--    so cash a club paid in an earlier week that was never applied to a
--    settlement did not reduce its exposure. Same defect fixed in
--    fn_union_club_invoice by 20260907044041, in the other function that reads
--    the same table, and it was missed there.
--
-- 2. A BREACHED STOP LOSS DID NOTHING.
--    union_club_terms already carries security_deposit, stop_loss_limit,
--    stakes_cap_bb, status, suspended_at and suspended_reason, and
--    fn_union_club_exposure already computes headroom and breached with
--    presettlement offsetting exposure 1:1 - precisely the published behaviour
--    ("presettlement increases the stop loss limit in a 1:1 ratio"). But
--    NOTHING ever wrote union_club_terms.status. fn_union_enforce_stop_loss
--    closes that, and RESTORES a club once its exposure is back inside, because
--    a suspension with no path back is the same trap as a lock with no release.
--    It only restores a club it suspended itself. It runs from the EXISTING
--    hourly union-integrity-sweep, because World Hub CLAUDE.md 11.3 forbids new
--    pg_cron jobs for application logic.
--
-- IT IS A NO-OP TODAY, AND THAT IS THE POINT. union_club_terms has ZERO rows,
-- so neither member club has a security deposit or a stop-loss limit and the
-- union is extending unlimited credit. Those numbers are a commercial decision
-- and Dan's, not an agent's, so the machinery is wired and armed and starts
-- protecting the union the moment he inserts the terms:
--
--   INSERT INTO union_club_terms (union_id, club_id, security_deposit, stop_loss_limit)
--   VALUES ('fade0000-0000-0000-0000-000000000001', '<club_id>', <deposit>, <limit>);
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_club_exposure(
  p_union_id uuid,
  p_week_start timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(club_id uuid, club_name text, week_start timestamp with time zone,
               running_net numeric, presettled numeric, exposure numeric,
               security_deposit numeric, stop_loss_limit numeric, headroom numeric,
               breached boolean, terms_on_file boolean, status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_week_start, fn_union_week_start());
BEGIN
  RETURN QUERY
  WITH rep AS (
    SELECT r.club_id, r.club_name, r.settle_net
      FROM fn_union_reconciliation_report(p_union_id, v_start, now()) r
  ),
  pre AS (
    -- Unapplied cash the club has already handed over. Closed out by
    -- applied_settlement_id, never by age.
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  )
  SELECT rep.club_id, rep.club_name, v_start, rep.settle_net,
         COALESCE(pre.amt, 0),
         GREATEST(0, round(-rep.settle_net - COALESCE(pre.amt, 0), 2)) AS exposure,
         COALESCE(t.security_deposit, 0),
         t.stop_loss_limit,
         CASE WHEN t.stop_loss_limit IS NULL THEN NULL
              ELSE round(t.stop_loss_limit
                         - GREATEST(0, -rep.settle_net - COALESCE(pre.amt, 0)), 2) END,
         CASE WHEN t.stop_loss_limit IS NULL THEN false
              ELSE GREATEST(0, -rep.settle_net - COALESCE(pre.amt, 0)) > t.stop_loss_limit END,
         (t.club_id IS NOT NULL),
         COALESCE(t.status, 'no_terms')
    FROM rep
    LEFT JOIN pre ON pre.club_id = rep.club_id
    LEFT JOIN union_club_terms t
           ON t.union_id = p_union_id AND t.club_id = rep.club_id
   ORDER BY exposure DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_enforce_stop_loss(p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r           record;
  v_suspended int := 0;
  v_restored  int := 0;
  v_out       jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR r IN
    SELECT * FROM public.fn_union_club_exposure(p_union_id) e WHERE e.terms_on_file
  LOOP
    IF r.breached AND r.status = 'active' THEN
      UPDATE union_club_terms t
         SET status           = 'suspended',
             suspended_at     = now(),
             suspended_reason = 'stop_loss_breached: exposure '
                                || to_char(r.exposure, 'FM999,999,999,990.00')
                                || ' over limit '
                                || to_char(r.stop_loss_limit, 'FM999,999,999,990.00'),
             updated_at       = now()
       WHERE t.union_id = p_union_id AND t.club_id = r.club_id;

      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_enforce_stop_loss', 'critical',
              r.club_name || ' suspended: exposure '
              || to_char(r.exposure, 'FM999,999,999,990.00')
              || ' exceeds its stop-loss limit of '
              || to_char(r.stop_loss_limit, 'FM999,999,999,990.00')
              || '. It resumes automatically once presettlement or settlement brings the '
              || 'exposure back inside the limit.',
              jsonb_build_object('union_id', p_union_id, 'club_id', r.club_id,
                                 'club_name', r.club_name, 'exposure', r.exposure,
                                 'stop_loss_limit', r.stop_loss_limit,
                                 'security_deposit', r.security_deposit,
                                 'presettled', r.presettled));
      v_suspended := v_suspended + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'club_id', r.club_id, 'club_name', r.club_name, 'action', 'suspended',
        'exposure', r.exposure, 'limit', r.stop_loss_limit));

    ELSIF (NOT r.breached) AND r.status = 'suspended' THEN
      UPDATE union_club_terms t
         SET status           = 'active',
             suspended_at     = NULL,
             suspended_reason = NULL,
             updated_at       = now()
       WHERE t.union_id = p_union_id AND t.club_id = r.club_id
         AND t.suspended_reason LIKE 'stop_loss_breached:%';

      IF FOUND THEN
        v_restored := v_restored + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'club_id', r.club_id, 'club_name', r.club_name, 'action', 'restored',
          'exposure', r.exposure, 'limit', r.stop_loss_limit));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('union_id', p_union_id,
    'suspended', v_suspended, 'restored', v_restored,
    'detail', v_out, 'ran_at', now());
END $function$;

COMMENT ON FUNCTION public.fn_union_enforce_stop_loss(uuid) IS
  'Suspends a member club whose weekly exposure passes its stop_loss_limit and restores it when the exposure comes back inside. No-op for any club with no union_club_terms row. Runs hourly from fn_union_integrity_sweep_all.';

REVOKE ALL ON FUNCTION public.fn_union_enforce_stop_loss(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_enforce_stop_loss(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep_all(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u record; v_one jsonb; v_signals int := 0; v_unions int := 0; v_failed int := 0;
  v_suspended int := 0; v_restored int := 0; v_sl jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR u IN SELECT id FROM unions LOOP
    BEGIN
      v_one := public.fn_union_integrity_sweep(u.id, p_hours);
      v_signals := v_signals + COALESCE((v_one->>'signals')::int, 0);
      v_unions := v_unions + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;

    -- Stop-loss enforcement rides the sweep rather than taking a schedule of
    -- its own (World Hub CLAUDE.md 11.3). It must never be able to stop the
    -- integrity sweep from finishing.
    BEGIN
      v_sl := public.fn_union_enforce_stop_loss(u.id);
      v_suspended := v_suspended + COALESCE((v_sl->>'suspended')::int, 0);
      v_restored  := v_restored  + COALESCE((v_sl->>'restored')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_enforce_stop_loss', 'warning',
              'Stop-loss enforcement failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals,
                            'clubs_suspended', v_suspended, 'clubs_restored', v_restored,
                            'window_hours', p_hours, 'ran_at', now());
END $function$;

DO $assert$
DECLARE v_src text; v_res jsonb; v_terms int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_club_exposure' AND pronamespace='public'::regnamespace;
  IF v_src LIKE '%p.received_at >= v_start%' THEN
    RAISE EXCEPTION 'exposure still time-filters unapplied presettlements';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_enforce_stop_loss%' THEN
    RAISE EXCEPTION 'the hourly sweep does not call stop-loss enforcement';
  END IF;

  SELECT count(*) INTO v_terms FROM union_club_terms;
  v_res := public.fn_union_enforce_stop_loss('fade0000-0000-0000-0000-000000000001');
  IF v_terms = 0 AND ((v_res->>'suspended')::int <> 0 OR (v_res->>'restored')::int <> 0) THEN
    RAISE EXCEPTION 'enforcement acted with no terms on file: %', v_res::text;
  END IF;
END
$assert$;

COMMIT;
