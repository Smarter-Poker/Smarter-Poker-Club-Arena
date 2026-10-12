-- 20261004141707_jackpot_facts_establish_who_is_asking.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG (2026-10-04)
--
-- fn_check_ungated_money_rpcs raised a critical financial alert at 04:15Z:
-- public.fn_bbj_pool_facts is SECURITY DEFINER, executable by authenticated,
-- writes a bbj_ table, and never establishes who is asking. Its only write is
-- the derived reporting cache bbj_pool_contribution_hours (20261003215434),
-- whose contents a caller cannot choose, and it already refused anything but
-- the authenticated or service role. But it accepted the authenticated ROLE
-- without a user behind it.
--
-- WHAT THIS CHANGES
--
-- One condition: an authenticated caller must carry a user (auth.uid()).
-- Everything else in the body is the 20261003215434 text, asserted below.
-- Same signature, owner, volatility and grants (restated).
--
-- Applied to production as version 20261004141741 (the apply transport
-- stamps its own version; match by name, never by version).

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $bbj_facts_preimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_bbj_pool_facts(uuid)')
                  AND md5(p.prosrc) = '5cfe89ea9e46907ba986a19bec67b75d') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_bbj_pool_facts is not the 20261003215434 definition';
  END IF;
END
$bbj_facts_preimage$;

CREATE OR REPLACE FUNCTION public.fn_bbj_pool_facts(p_pool_id uuid)
 RETURNS TABLE(hands_contributed bigint, total_contributed numeric, first_contribution_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cut   timestamptz := date_trunc('hour', now() - interval '15 minutes', 'UTC');
  v_last  timestamptz;
  v_hands bigint; v_total numeric; v_first timestamptz;
  l_hands bigint; l_total numeric; l_first timestamptz;
BEGIN
  -- Who may ask: a signed-in player (the jackpot page) or the service. The
  -- only write below is the derived reporting cache; a caller chooses which
  -- pool's facts to read, never what the cache holds. A signed-in caller is a
  -- real user (auth.uid()), not merely a request carrying the role
  -- (20261004: fn_ungated_money_rpcs, critical alert 04:15Z).
  IF COALESCE(auth.role(), 'service_role') NOT IN ('authenticated', 'service_role')
     OR (auth.role() = 'authenticated' AND auth.uid() IS NULL) THEN
    RAISE EXCEPTION 'jackpot facts require a signed-in caller' USING ERRCODE = '42501';
  END IF;
  IF p_pool_id IS NULL THEN
    RETURN QUERY SELECT 0::bigint, ROUND(0::numeric, 2), NULL::timestamptz;
    RETURN;
  END IF;

  SELECT max(h.hour_start) INTO v_last
    FROM public.bbj_pool_contribution_hours h WHERE h.pool_id = p_pool_id;

  -- Fill only when a closed hour may be missing. Re-read under the pool's key
  -- (a backdated contribution or another reader may have moved it), and read
  -- the contributions with this statement's snapshot, taken after the key.
  IF v_last IS NULL OR v_last < v_cut - interval '1 hour' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('bbj-facts-hours:' || p_pool_id::text, 0));
    SELECT max(h.hour_start) INTO v_last
      FROM public.bbj_pool_contribution_hours h WHERE h.pool_id = p_pool_id;
    INSERT INTO public.bbj_pool_contribution_hours (pool_id, hour_start, hands, total, first_at)
    SELECT c.pool_id, date_trunc('hour', c.created_at, 'UTC'), count(*), COALESCE(sum(c.amount), 0), min(c.created_at)
      FROM public.bbj_contributions c
     WHERE c.pool_id = p_pool_id
       AND c.created_at >= COALESCE(v_last + interval '1 hour', '-infinity'::timestamptz)
       AND c.created_at < v_cut
     GROUP BY c.pool_id, date_trunc('hour', c.created_at, 'UTC')
    ON CONFLICT (pool_id, hour_start) DO NOTHING;
  END IF;

  SELECT COALESCE(sum(h.hands), 0), COALESCE(sum(h.total), 0), min(h.first_at)
    INTO v_hands, v_total, v_first
    FROM public.bbj_pool_contribution_hours h
   WHERE h.pool_id = p_pool_id AND h.hour_start < v_cut;

  SELECT count(*), COALESCE(sum(c.amount), 0), min(c.created_at)
    INTO l_hands, l_total, l_first
    FROM public.bbj_contributions c
   WHERE c.pool_id = p_pool_id AND c.created_at >= v_cut;

  RETURN QUERY SELECT (v_hands + l_hands)::bigint,
                      ROUND(v_total + l_total, 2),
                      LEAST(v_first, l_first);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_pool_facts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_pool_facts(uuid) TO authenticated, service_role;

DO $bbj_facts_postimage$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_ungated_money_rpcs() WHERE fn = 'fn_bbj_pool_facts')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.fn_bbj_pool_facts(uuid)'::regprocedure
                     AND p.prosrc LIKE '%bbj_pool_contribution_hours%' AND p.prosecdef) THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_bbj_pool_facts is not the reviewed definition';
  END IF;
END
$bbj_facts_postimage$;

COMMIT;
