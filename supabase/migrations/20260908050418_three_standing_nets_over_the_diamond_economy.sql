-- 20260908050418_three_standing_nets_over_the_diamond_economy.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS BUILDS, AND WHY (CLAUDE.md 10.83, 10.84, 10.86 and 10.12;
-- docs/changelog/2026-09-08-three-standing-nets.md):
--
-- Three nets, and one line about what a net is FOR. CLAUDE.md 10.12 forbids building a monitor
-- and calling a defect handled. None of these repairs anything or moves a diamond: they are
-- instruments over an economy whose live paths were fixed first, and every one of them exists
-- because something real was invisible until a person went looking by hand.
--
--   1. CONCENTRATION AND VELOCITY. One account holds 87 percent of all human diamonds and
--      nobody knew; issuance is about to run at roughly 225,000 a day against real player
--      spending of about 370 a month. Both are facts about the currency that should be standing
--      on a wall, not discovered in a session. fn_ca_diamond_economy_watch files DR13 when
--      concentration or the faucet-over-sink ratio leaves the band, with thresholds DERIVED from
--      what is there today and the measurement written beside each one (10.84).
--
--   2. RETENTION. ca_diamond_incidents took 2,447 rows in 24 hours, 79 percent of them info, and
--      has no retention at all; user_daily_challenges holds 51,780 rows and grows 5,000 to 8,000
--      a day with nothing ever removed. hand_history reached 3.6 GB the same way. Both are
--      pruned on a schedule, and the schedule IS the product here (10.12's first exemption): it
--      repairs nothing, it stops a table becoming the next incident. Resolved incidents and
--      claimed or expired challenges only - nothing unresolved and nothing owed is ever removed.
--
--   3. REACHABILITY. Four defects tonight were code that read as working while being unreachable:
--      a gift RPC no route called, a rule with no consumer, a route behind a guard that answered
--      first, and a claim on an overload the engine does not use. fn_ca_diamond_unreachable_money
--      names, in one read, every money function with no caller and every path granted to
--      authenticated that the privileged-column guard would refuse. It is the fourth class of
--      the same trap, and it is now a query rather than an accident.
--
-- Nothing here moves a diamond.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Concentration and velocity.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_diamond_rule_modes (rule, mode, flip_after, clean_days_required, ruling, note) VALUES
  ('DR13:concentration_or_velocity', 'log', '2026-10-08 00:00:00+00', 7, '13',
   'Concentration of the currency in one account, or an issuance-to-spending ratio outside its band. This one stays a report: there is nothing to refuse, only somebody to tell.')
ON CONFLICT (rule) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economy_watch()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conc numeric; v_ratio numeric; v_faucet numeric; v_sink numeric; v_top numeric; v_humans numeric;
  v_filed integer := 0; v_mode text := public.fn_ca_diamond_rule_mode('DR13:concentration_or_velocity');
  -- Measured 2026-09-08. Concentration: one human held 87.2 percent of all human diamonds
  -- (494,445 of 566,746) with the next largest at 11,571. A band of 60 says "one account owns
  -- the currency" without firing on the ordinary case of a few large holders.
  c_concentration_pct constant numeric := 60;
  -- Velocity: over the prior 30 days the faucet issued 18,301 and players spent 16,993 of which
  -- 14,120 were admin adjustments, so real spending was about 370 - a true ratio near 50. With
  -- horses claiming, issuance runs at roughly 225,000 a day. A band of 20 is far above any
  -- healthy month and far below where the economy sits when the faucet has run away.
  c_ratio_max constant numeric := 20;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  SELECT COALESCE(max(p.diamonds), 0), COALESCE(sum(p.diamonds), 0)
    INTO v_top, v_humans FROM public.profiles p WHERE NOT p.is_horse;
  v_conc := CASE WHEN v_humans > 0 THEN round(100 * v_top / v_humans, 1) ELSE 0 END;

  SELECT COALESCE(sum(dt.amount) FILTER (WHERE dt.amount > 0), 0),
         COALESCE(sum(-dt.amount) FILTER (WHERE dt.amount < 0), 0)
    INTO v_faucet, v_sink
    FROM public.diamond_transactions dt
   WHERE dt.created_at >= now() - interval '30 days'
     AND NOT public.fn_ca_is_fixture_account(dt.user_id);
  v_ratio := CASE WHEN v_sink > 0 THEN round(v_faucet / v_sink, 2) ELSE NULL END;

  IF v_conc > c_concentration_pct THEN
    PERFORM public.fn_ca_diamond_incident('DR13:concentration_or_velocity', 'warning', NULL, v_top,
      'fn_ca_diamond_economy_watch',
      jsonb_build_object('kind', 'concentration', 'largest_human_pct', v_conc, 'threshold_pct', c_concentration_pct,
                         'largest_holder_diamonds', v_top, 'all_human_diamonds', v_humans,
                         'note', 'One account holds most of the human-held currency. Not a defect: a fact about the economy that should be seen.'));
    v_filed := v_filed + 1;
  END IF;

  IF v_ratio IS NOT NULL AND v_ratio > c_ratio_max THEN
    PERFORM public.fn_ca_diamond_incident('DR13:concentration_or_velocity', 'warning', NULL, v_faucet - v_sink,
      'fn_ca_diamond_economy_watch',
      jsonb_build_object('kind', 'velocity', 'faucet_over_sink', v_ratio, 'threshold', c_ratio_max,
                         'faucet_30d', v_faucet, 'sink_30d', v_sink,
                         'note', 'Issuance is outrunning spending. The levers are the per-user daily caps and what diamonds can be spent on; both are Dan''s.'));
    v_filed := v_filed + 1;
  END IF;

  RETURN jsonb_build_object('ok', true, 'concentration_pct', v_conc, 'faucet_over_sink', v_ratio,
                            'faucet_30d', v_faucet, 'sink_30d', v_sink, 'incidents_filed', v_filed,
                            'mode', v_mode);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economy_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economy_watch() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Retention. The schedule IS the product: this repairs nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_prune_history(p_incident_days integer DEFAULT 30,
                                                              p_challenge_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_incidents integer := 0; v_challenges integer := 0;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_incident_days < 7 OR p_challenge_days < 30 THEN
    RAISE EXCEPTION 'retention below the floor: incidents 7 days, challenges 30 days';
  END IF;

  -- Only RESOLVED incidents, and only info or warning. Anything unresolved, and anything
  -- critical, stays for ever: a record of a thing nobody answered is the record that matters.
  DELETE FROM public.ca_diamond_incidents
   WHERE resolved_at IS NOT NULL
     AND severity IN ('info', 'warning')
     AND occurred_at < now() - make_interval(days => p_incident_days);
  GET DIAGNOSTICS v_incidents = ROW_COUNT;

  -- Only challenges that are finished: claimed (paid) or expired (the window closed). A
  -- completed-unclaimed row is money owed and is never removed by a retention pass.
  DELETE FROM public.user_daily_challenges
   WHERE (claimed OR expired_at IS NOT NULL)
     AND created_at < now() - make_interval(days => p_challenge_days);
  GET DIAGNOSTICS v_challenges = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'incidents_pruned', v_incidents, 'challenges_pruned', v_challenges,
                            'incident_days', p_incident_days, 'challenge_days', p_challenge_days);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_prune_history(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_prune_history(integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Reachability: the fourth class of tonight's trap, as a query.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_unreachable_money()
RETURNS TABLE(finding text, object text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- A money function nothing calls, and nothing grants to a client either: it can only ever run
  -- if a human types its name. That is how send_stream_gift sat unreachable for months.
  SELECT 'no_caller_and_no_client_grant'::text,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'writes profiles.diamonds but no other function calls it and neither anon nor authenticated may execute it'::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?profiles[^;]*diamonds\s*='
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc q JOIN pg_namespace m ON m.oid = q.pronamespace
        WHERE m.nspname = 'public' AND q.oid <> p.oid AND q.prosrc LIKE '%' || p.proname || '%')
     AND NOT EXISTS (
       SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee IN ('anon'::regrole, 'authenticated'::regrole))

  UNION ALL

  -- A money function a browser CAN call, that the privileged-column guard would refuse. That is
  -- exactly what made send_stream_gift answer 42501 to every real player.
  SELECT 'client_reachable_but_guard_refuses'::text,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'granted to authenticated and writes profiles.diamonds, but fn_guard_profile_privileged_columns does not name it'::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?profiles[^;]*diamonds\s*='
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'authenticated'::regrole)
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc g JOIN pg_namespace gn ON gn.oid = g.pronamespace
        WHERE gn.nspname = 'public' AND g.proname = 'fn_guard_profile_privileged_columns'
          AND g.prosrc LIKE '%' || p.proname || '[(]%')

  UNION ALL

  -- A rule row that reads as armed while nothing consults it (the DR15 shape).
  SELECT 'rule_with_no_consumer'::text, r.rule,
         'ca_diamond_rule_modes carries it, but no function calls fn_ca_diamond_rule_mode with this name'::text
    FROM public.ca_diamond_rule_modes r
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosrc LIKE '%fn_ca_diamond_rule_mode%'
        AND p.prosrc LIKE '%' || r.rule || '%');
$$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_unreachable_money() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_unreachable_money() TO service_role;
COMMENT ON FUNCTION public.fn_ca_diamond_unreachable_money() IS
  'Money paths that read as working while being unreachable: no caller, refused by the privileged-column guard, or a rule nothing consults. Four defects on 2026-09-08 were one of these three.';

-- ---------------------------------------------------------------------------
-- 3b. THE FIRST THING THE DETECTOR FOUND, REMOVED IN THE SAME MIGRATION.
-- ---------------------------------------------------------------------------
-- fn_add_diamonds(uuid, integer) credits a wallet with no payment, no reference and no journal
-- class. It was the "development fallback" inside DiamondService.purchaseDiamonds: a browser
-- call that credited a package for free. It never worked, and only because the grant was absent
-- - authenticated cannot execute it - so the button showed a raw permission error instead of
-- giving diamonds away. Its ledger record is zero writes, ever.
--
-- The client half was removed on main earlier today (store readiness phase 3), which left the
-- function with no caller anywhere in either repo. The first run of the reachability report
-- above named it in one line. A credit path that exists is a credit path someone calls one day,
-- so it goes now rather than waiting for the delete list's next pass.
DROP FUNCTION IF EXISTS public.fn_add_diamonds(uuid, integer);

-- ---------------------------------------------------------------------------
-- 4. The schedules.
-- ---------------------------------------------------------------------------
SELECT cron.schedule('ca-diamond-economy-watch-daily', '25 6 * * *',
                     $cron$SELECT public.fn_ca_diamond_economy_watch();$cron$)
 WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-economy-watch-daily');
SELECT cron.schedule('ca-diamond-prune-history-daily', '40 6 * * *',
                     $cron$SELECT public.fn_ca_diamond_prune_history();$cron$)
 WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-prune-history-daily');

-- ---------------------------------------------------------------------------
-- 5. Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v jsonb; v_unreachable text;
BEGIN
  v := public.fn_ca_diamond_economy_watch();
  IF COALESCE((v ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the economy watch did not run: %', v;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-economy-watch-daily')
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-prune-history-daily') THEN
    RAISE EXCEPTION 'a schedule is missing';
  END IF;

  -- the retention floor cannot be argued away
  BEGIN
    PERFORM public.fn_ca_diamond_prune_history(1, 1);
    RAISE EXCEPTION 'retention accepted a value below its floor';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%below the floor%' THEN RAISE; END IF;
  END;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_add_diamonds') THEN
    RAISE EXCEPTION 'fn_add_diamonds survived: a free credit path with no caller is still callable';
  END IF;

  -- and the reachability report must find nothing, because tonight fixed all three shapes
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_unreachable
    FROM public.fn_ca_diamond_unreachable_money();
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'unreachable money paths remain: %', v_unreachable;
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
