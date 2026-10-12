-- ============================================================================
-- JACKPOT FACTS READ CLOSED HOURS ONCE
-- ============================================================================
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION 2026-10-03
--
-- The Bad Beat Jackpot page (src/pages/BadBeatJackpotPage.tsx) calls
-- fn_bbj_pool_facts(pool) on every load and again on every HAND_COMPLETED
-- tick, for every viewer. The function counted and summed EVERY contribution
-- the pool ever received:
--
--     SELECT count(*), round(sum(amount),2), min(created_at)
--       FROM bbj_contributions WHERE pool_id = p_pool_id;
--
-- For the union pool f9806a7f that is an index-only scan of 1,171,516 rows:
-- 5,571 ms with 42,833 buffers (single process), and with parallel workers it
-- was seen holding up to 40 parallel worker slots at once (16:30 UTC), on a
-- database that ran out of memory at 20:18 UTC. The pool adds ~3,500 rows an
-- hour; everything older than the current hour never changes.
--
-- THE FIX
--
-- public.bbj_pool_contribution_hours keeps, per pool and per CLOSED UTC hour,
-- the count, sum and earliest timestamp of that hour's contributions. The
-- facts are the sum of the closed hours plus a live read of the open tail
-- (created_at >= the cut, at most ~75 minutes, an index range read). The
-- answer is the same three numbers, computed from the same rows.
--
--   * Hours are UTC hours (three-argument date_trunc, so a session time
--     zone with a half-hour offset cannot shift a bucket). The cut is
--     date_trunc('hour', now() - 15 minutes, 'UTC'): an hour is cached only
--     once it ended at least 15 minutes ago, so a hand transaction that began
--     inside the hour has committed long before (service role statement
--     timeout is 8 s).
--   * Missing closed hours are filled lazily by the facts call itself, under a
--     per-pool advisory key, reading the committed rows after taking the key.
--   * The ONE writer that inserts a contribution with an old created_at
--     (fn_bbj_repair_unbanked stamps the hand's time) is covered by a row
--     trigger that fires only when created_at is before the start of the
--     current hour: it takes the same per-pool key and drops that pool's
--     cached hours from the row's hour onward, so the next call refills them
--     from committed rows. Normal contributions (created_at = now()) never
--     match the trigger's WHEN clause, so the hand path pays nothing.
--   * Any UPDATE, DELETE or TRUNCATE of bbj_contributions (no function does
--     one today) drops the affected pools' cache entirely.
--   * The cache is reporting only. No balance, ledger, pool counter or payout
--     reads it; fn_bbj_promo_facts and every money path are untouched.
--
-- Memory: the fill is one GROUP BY over an index range of a single pool (a few
-- thousand hour groups at most), the read is a primary-key range of the cache
-- plus the open-hour index range. No sort, no work_mem growth.
--
-- The migration fills every pool's closed hours once (an index-only pass over
-- the covering index idx_bbj_contrib_pool_facts) BEFORE it creates the
-- trigger, so the SHARE ROW EXCLUSIVE lock the trigger needs on
-- bbj_contributions is held only for the final statements of the transaction.
-- ============================================================================

-- @live-proof: to_regclass('public.bbj_pool_contribution_hours') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bbj_contribution_backdated_drops_cached_hours' AND tgrelid = 'public.bbj_contributions'::regclass) AND (SELECT prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') FROM pg_proc WHERE oid = 'public.fn_bbj_pool_facts(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.bbj_pool_contribution_hours (
  pool_id     uuid        NOT NULL,
  hour_start  timestamptz NOT NULL,
  hands       bigint      NOT NULL,
  total       numeric     NOT NULL,
  first_at    timestamptz NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, hour_start)
);
COMMENT ON TABLE public.bbj_pool_contribution_hours IS
  'Reporting cache for fn_bbj_pool_facts: per pool and closed UTC hour, count/sum/min(created_at) of bbj_contributions. Never read by a money path. Rebuilt lazily; dropped from an hour onward by bbj_contribution_backdated_drops_cached_hours.';
ALTER TABLE public.bbj_pool_contribution_hours ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bbj_pool_contribution_hours FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bbj_pool_contribution_hours TO service_role;

-- Same signature, return type, owner, SECURITY DEFINER and search_path as
-- before. VOLATILE because it may fill the cache.
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
  -- Who may ask is unchanged: a signed-in player (the jackpot page) or the
  -- service. The only write below is the derived reporting cache; a caller
  -- chooses which pool's facts to read, never what the cache holds.
  IF COALESCE(auth.role(), 'service_role') NOT IN ('authenticated', 'service_role') THEN
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

-- The ACL stays exactly as it was (CREATE OR REPLACE keeps it); state it.
REVOKE ALL ON FUNCTION public.fn_bbj_pool_facts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_pool_facts(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_contribution_drops_cached_hours()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Fires only for a contribution stamped before the current hour (WHEN).
    PERFORM pg_advisory_xact_lock(hashtextextended('bbj-facts-hours:' || NEW.pool_id::text, 0));
    DELETE FROM public.bbj_pool_contribution_hours h
     WHERE h.pool_id = NEW.pool_id
       AND h.hour_start >= date_trunc('hour', NEW.created_at, 'UTC');
    RETURN NULL;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    -- Every contribution is gone, so every cached hour is wrong.
    DELETE FROM public.bbj_pool_contribution_hours WHERE true;
    RETURN NULL;
  END IF;
  -- UPDATE / DELETE (statement level, transition table old_rows).
  FOR r IN SELECT DISTINCT o.pool_id FROM old_rows o WHERE o.pool_id IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('bbj-facts-hours:' || r.pool_id::text, 0));
    DELETE FROM public.bbj_pool_contribution_hours h WHERE h.pool_id = r.pool_id;
  END LOOP;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_contribution_drops_cached_hours() FROM PUBLIC, anon, authenticated;

-- Fill every pool's closed hours once, before the trigger takes its lock.
INSERT INTO public.bbj_pool_contribution_hours (pool_id, hour_start, hands, total, first_at)
SELECT c.pool_id, date_trunc('hour', c.created_at, 'UTC'), count(*), COALESCE(sum(c.amount), 0), min(c.created_at)
  FROM public.bbj_contributions c
 WHERE c.pool_id IS NOT NULL
   AND c.created_at < date_trunc('hour', now() - interval '15 minutes', 'UTC')
 GROUP BY c.pool_id, date_trunc('hour', c.created_at, 'UTC')
ON CONFLICT (pool_id, hour_start) DO NOTHING;

CREATE TRIGGER bbj_contribution_backdated_drops_cached_hours
  AFTER INSERT ON public.bbj_contributions
  FOR EACH ROW
  WHEN (NEW.created_at < date_trunc('hour', now(), 'UTC'))
  EXECUTE FUNCTION public.fn_bbj_contribution_drops_cached_hours();

CREATE TRIGGER bbj_contribution_rewrite_drops_cached_hours_upd
  AFTER UPDATE ON public.bbj_contributions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_bbj_contribution_drops_cached_hours();

CREATE TRIGGER bbj_contribution_rewrite_drops_cached_hours_del
  AFTER DELETE ON public.bbj_contributions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_bbj_contribution_drops_cached_hours();

CREATE TRIGGER bbj_contribution_truncate_drops_cached_hours
  AFTER TRUNCATE ON public.bbj_contributions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_bbj_contribution_drops_cached_hours();

COMMIT;
