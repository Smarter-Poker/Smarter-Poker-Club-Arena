-- ═══════════════════════════════════════════════════════════════════════════
-- VIP POINTS ARE AWARDED ON THE RAKE, ON EVERY PATH
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED (read-only session; see the pull request).
--
-- THE DEFECT. fn_award_vip_points_from_rake, the AFTER INSERT trigger on
-- rake_records, forked on rake_method and only one fork awarded a share of the
-- rake:
--
--   WEIGHTED_CONTRIBUTED  -> fn_allocate_rake_credits(NEW.rake_amount, ...)
--                            i.e. the player's share of the RAKE. Correct.
--   anything else, which  -> iterate player_contributions and award v::numeric,
--   is every other row       i.e. the player's CONTRIBUTION TO THE POT.
--
-- Those are not two roundings of one rule. One awards a slice of a 10% rake;
-- the other awards the whole bet. Measured on production 2026-09-01:
--
--     rake_method            hands       rake taken     basis awarded
--     DEALT_EQUAL        1,544,385     4,474,442.25     the pot contributions
--     WEIGHTED_CONTRIBUTED  56,401       154,216.27     the rake
--
--     over the last two days:  awarded basis 3,672,403.82
--                              correct basis   117,080.18   -> 31.4x
--     over the last nine:      awarded basis 32,615,366.54
--                              correct basis   973,765.11   -> 33.5x
--
-- DEALT_EQUAL is the DEFAULT, so the wrong branch is not an edge case, it is
-- the platform. Lifetime, since accrual began on 2026-07-29:
--
--     3,811,527 ledger rows, 135,761,739 points, 589 players, source 'rake'
--
-- and a recompute on the correct basis leaves 3,589,721 lifetime points --
-- 97.4% of every VIP point ever awarded came from the wrong branch.
--
-- WHAT IT IS AND IS NOT. Points do not move chips. They buy themes and avatars
-- from vip_reward_catalog and they drive tier progression. So this is an
-- ENTITLEMENT AND TIER-INTEGRITY defect, not a treasury one: no club is short
-- a chip because of it, and no player's wallet is wrong. What is wrong is that
-- two players with identical activity were paid ~38x apart depending on which
-- game they sat in, and that the tier ladder has been climbed on a number that
-- was never the rake.
--
-- THE FIX IS FORWARD ONLY. NOTHING IS BACKFILLED OR CLAWED BACK. The recompute
-- is in the pull request as a decision for Dan, with the tier consequences
-- stated, because reversing it demotes 588 of 589 real players.
--
-- HOW THE FORK GOES AWAY. fn_allocate_rake_credits ALREADY implements both
-- published methods, and both of them divide THE RAKE:
--
--     WEIGHTED_CONTRIBUTED   rake * (my contribution / total contributions)
--     DEALT_EQUAL            rake / number of contributors
--
-- so the fix is not a new formula, it is to stop bypassing the helper. The
-- trigger now passes NEW.rake_method straight through and there is one basis.
-- An unrecognised method is not silently allocated as nothing (which is what
-- the helper returns for a method it does not know) and not silently treated
-- as "award the pot": it is FILED, and then allocated on the weighted default.
--
-- AND IT STOPS SWALLOWING. The old body ended each award in
--
--     EXCEPTION WHEN others THEN CONTINUE;
--
-- so every VIP award that has ever failed, for any reason, failed silently and
-- left no trace anywhere. The trigger must stay non-fatal -- it hangs off the
-- rake write and a VIP point may not cost a club its rake row -- but
-- non-fatal is not the same as invisible. Failures are now filed into
-- ledger_reconcile_log as 'vip_award_failed', which is where this house's
-- alarms already live and which raises a management incident on arrival
-- (fn_ca_reconcile_log_to_incident).
--
-- ONE-PER-HOUR THROTTLE ON THE FILING, deliberately. If fn_award_vip_credit
-- starts refusing every row -- the shape the fn_caller_is_engine guard would
-- take if the engine ever lost service_role -- then filing per contributor per
-- hand is tens of thousands of log rows and notification storms an hour. The
-- filer writes at most one row per kind per hour and counts what it suppressed
-- in the notes. Loud, not deafening.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ── The filer ───────────────────────────────────────────────────────────────
-- Never raises. It is called from inside an exception handler on the money
-- path; a filer that can throw turns a logged failure into a lost rake row.
CREATE OR REPLACE FUNCTION public.fn_file_vip_award_finding(
  p_rake_record_id uuid,
  p_user_id        uuid,
  p_kind           text,
  p_detail         text,
  p_credit         numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recent integer;
BEGIN
  SELECT count(*) INTO v_recent
    FROM public.ledger_reconcile_log l
   WHERE l.entity_type = 'vip_award_failed'
     AND l.metadata->>'kind' = p_kind
     AND l.run_ts > now() - interval '1 hour';

  IF v_recent > 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.ledger_reconcile_log
    (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
     severity, metadata, notes)
  VALUES
    (CURRENT_DATE, now(), 'vip_award_failed', p_user_id,
     COALESCE(p_credit, 0), 0, 'critical',
     jsonb_build_object(
       'kind', p_kind,
       'source', 'fn_award_vip_points_from_rake',
       'rake_record_id', p_rake_record_id,
       'user_id', p_user_id,
       'credit', p_credit,
       'detail', left(COALESCE(p_detail, ''), 500)),
     'vip award ' || p_kind || ': ' || left(COALESCE(p_detail, ''), 200)
       || ' (further findings of this kind suppressed for one hour)');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_file_vip_award_finding could not file %: %', p_kind, SQLERRM;
END;
$function$;

-- ── The trigger, with one basis ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  rec      record;
  v_method text;
BEGIN
  IF NEW.player_contributions IS NULL
     OR jsonb_typeof(NEW.player_contributions) <> 'object' THEN
    RETURN NEW;
  END IF;

  v_method := COALESCE(NEW.rake_method, 'WEIGHTED_CONTRIBUTED');

  IF v_method NOT IN ('WEIGHTED_CONTRIBUTED', 'DEALT_EQUAL') THEN
    -- fn_allocate_rake_credits returns ZERO ROWS for a method it does not
    -- know, so an unrecognised method would award nobody anything and look
    -- exactly like a quiet game. Say so, then fall back to the published
    -- default rather than to the pot.
    PERFORM public.fn_file_vip_award_finding(
      NEW.id, NULL, 'unknown_rake_method',
      'rake_method ' || quote_literal(v_method) || ' is not a published allocation method',
      NEW.rake_amount);
    v_method := 'WEIGHTED_CONTRIBUTED';
  END IF;

  FOR rec IN
    SELECT a.user_id AS uid, a.credit AS credit
      FROM public.fn_allocate_rake_credits(
             NEW.rake_amount, NEW.player_contributions, v_method) a
  LOOP
    BEGIN
      PERFORM public.fn_award_vip_credit(
        rec.uid, rec.credit, 'rake', NEW.id, 'Rake generated');
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.fn_file_vip_award_finding(
        NEW.id, rec.uid, 'award_failed', SQLERRM, rec.credit);
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- ── The alarm: what was credited, against what was raked ────────────────────
--
-- The one comparison that would have caught this on day one. Both sides are
-- restricted to the same window and grouped by rake_method, because the whole
-- defect was one method behaving differently from the other and an aggregate
-- over both would have shown a blended number nobody could interpret.
--
-- THE BAND IS 1%, not zero, for two honest reasons and no others:
--   * fn_allocate_rake_credits distributes whole CENTS, so a rake carried to
--     four decimals loses up to half a cent per record to rounding;
--   * fn_award_vip_credit writes no ledger row for a credit of zero, so a
--     player whose share rounds to nothing contributes rake without credit.
-- Both are sub-cent per hand. 31.4x is not in the band, and neither is a
-- method that stops crediting at all.
CREATE OR REPLACE FUNCTION public.fn_vip_points_basis_violations(
  p_window interval DEFAULT '6 hours'
)
RETURNS TABLE (
  kind        text,
  rake_method text,
  records     bigint,
  rake        numeric,
  credited    numeric,
  ratio       numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH w AS (SELECT now() - p_window AS from_ts),
  raked AS (
    SELECT COALESCE(rr.rake_method, 'WEIGHTED_CONTRIBUTED') AS m,
           count(*)::bigint AS records,
           sum(rr.rake_amount) AS rake
      FROM public.rake_records rr CROSS JOIN w
     WHERE rr.created_at > w.from_ts
       AND jsonb_typeof(rr.player_contributions) = 'object'
       AND COALESCE(rr.rake_amount, 0) > 0
     GROUP BY 1
  ),
  credited AS (
    SELECT COALESCE(rr.rake_method, 'WEIGHTED_CONTRIBUTED') AS m,
           sum(l.credit) AS credited
      FROM public.vip_points_ledger l
      CROSS JOIN w
      JOIN public.rake_records rr ON rr.id = l.source_id
     WHERE l.source_type = 'rake'
       AND l.created_at > w.from_ts
     GROUP BY 1
  ),
  j AS (
    SELECT raked.m, raked.records, raked.rake,
           COALESCE(credited.credited, 0) AS credited,
           round(COALESCE(credited.credited, 0) / raked.rake, 4) AS ratio
      FROM raked LEFT JOIN credited ON credited.m = raked.m
     WHERE raked.rake > 0
  )
  SELECT 'credit_exceeds_rake', j.m, j.records, j.rake, j.credited, j.ratio
    FROM j WHERE j.ratio > 1.01
  UNION ALL
  SELECT 'credit_below_rake', j.m, j.records, j.rake, j.credited, j.ratio
    FROM j WHERE j.ratio < 0.99;
$function$;

CREATE OR REPLACE FUNCTION public.fn_vip_points_basis_check(
  p_window interval DEFAULT '6 hours'
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_vip_points_basis_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'vip_points_basis', NULL,
           v.rake, v.credited,
           'critical',
           jsonb_build_object(
             'kind', v.kind,
             'source', 'fn_vip_points_basis_check',
             'rake_method', v.rake_method,
             'records', v.records,
             'ratio', v.ratio,
             'window', p_window::text,
             'parity_key', v.rake_method || ':' || v.kind),
           v.rake_method || ' credited ' || v.credited::text
             || ' of VIP basis against ' || v.rake::text || ' of rake ('
             || v.ratio::text || ' per rake chip, over ' || v.records::text || ' records)'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'vip_points_basis'
          AND l.metadata->>'rake_method' = v.rake_method
          AND l.metadata->>'kind' = v.kind
          AND l.run_ts > now() - p_window)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$function$;

-- Neither reader is a browser surface: they aggregate rake and VIP credit
-- across every club, and the alarm runs as the cron owner.
REVOKE ALL ON FUNCTION public.fn_file_vip_award_finding(uuid, uuid, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_vip_points_basis_violations(interval)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_vip_points_basis_check(interval)                         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_file_vip_award_finding(uuid, uuid, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_vip_points_basis_violations(interval)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_vip_points_basis_check(interval)                        TO service_role;

-- Every six hours at :15, over a six-hour window that does not overlap itself
-- -- the finding is a WINDOW AGGREGATE rather than a per-hand fact, so an
-- overlap would re-file the same rake twice. The suppression clause uses the
-- same window, so a late run cannot double-file either. Off :00 and :40 so it
-- does not queue behind reconcile-ledger-integrity-6h or
-- rake-law-adherence-hourly.
SELECT cron.unschedule('vip-points-basis-6h')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vip-points-basis-6h');
SELECT cron.schedule('vip-points-basis-6h', '15 */6 * * *',
                     $cron$SELECT public.fn_vip_points_basis_check('6 hours'::interval);$cron$);

COMMIT;
