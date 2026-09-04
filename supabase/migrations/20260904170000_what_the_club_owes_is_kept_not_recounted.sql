-- WHAT THE CLUB OWES ITS AGENTS IS KEPT, NOT RECOUNTED ON EVERY OPEN.
--
-- Found in the phase 4 verification walk, in a browser, on production
-- (2026-09-04 10:40 UTC): the agent console's Payouts tab opened to "The
-- Commission Ledger Could Not Be Read", and on the second try answered in
-- 8,870 ms. fn_ca_agent_payables (phase 3) sums agent_commissions WHERE
-- settled_at IS NULL for the club on every open. When phase 3 measured it
-- the club had 259,135 unsettled rows and the read took ~1.7 s cold. One
-- day later it has 499,933, the estate writes 622,976 commission rows a
-- day, and NOTHING on this platform has ever set settled_at - so the set
-- this function scans grows by a quarter of a million rows a day for this
-- club alone and never shrinks. The covering index from 20260903210000
-- made the scan index-only; it did not make it small. EXPLAIN ANALYZE
-- today: Parallel Index Only Scan over 499,933 entries, 2,395 ms for the
-- aggregate alone, before PostgREST, before the network.
--
-- A number that is read once an hour and changes 250,000 times a day is a
-- rollup, not a query. This migration keeps it.
--
-- WHAT IT ADDS.
--   agent_commission_unsettled_rollup (club_id, user_id) -> owed,
--   rows_behind, oldest_unsettled. One row per agent per club, maintained
--   by STATEMENT-level triggers with transition tables, so a hand that
--   writes four commission rows costs one upsert, and a settlement run that
--   marks 100,000 rows paid costs one pass over what it changed rather than
--   100,000 trigger calls. Backfilled from the ledger inside this
--   transaction and asserted equal to it before COMMIT.
--
-- oldest_unsettled is exact on INSERT (least of old and new) and recomputed
-- from the index for the pairs a settlement touches, since settling a row
-- can move the minimum forward and only the ledger knows where to.
--
-- fn_ca_agent_payables now reads the rollup. Same payload, same gate, same
-- 200-row cap; `total_rows` still means rows behind the figure. A rebuild
-- function is provided for service_role in case a path ever writes the
-- ledger without firing triggers (TRUNCATE is the only one), and the
-- payables read reports `rollup_checked_at` so the nightly reconciler has a
-- hook to compare against the ledger.
--
-- The triggers never RAISE. A rollup that refuses a commission insert would
-- be a display table breaking a money path, which is the wrong way round.
--
-- Horses are counted like every other player (CLAUDE.md 10.5): a commission
-- row is a commission row.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
--  1. The rollup
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_commission_unsettled_rollup (
  club_id          uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  owed             numeric     NOT NULL DEFAULT 0,
  rows_behind      bigint      NOT NULL DEFAULT 0,
  oldest_unsettled timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);

COMMENT ON TABLE public.agent_commission_unsettled_rollup IS
  'Per (club, agent) sum of agent_commissions rows with settled_at IS NULL, maintained by statement-level triggers on agent_commissions. Read by fn_ca_agent_payables. Rebuild with fn_rebuild_agent_commission_rollup().';

ALTER TABLE public.agent_commission_unsettled_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_commission_unsettled_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.agent_commission_unsettled_rollup TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  2. Maintenance: one pass per statement, never a row at a time
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
   GROUP BY n.club_id, n.user_id
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed             = r.owed + EXCLUDED.owed,
         rows_behind      = r.rows_behind + EXCLUDED.rows_behind,
         oldest_unsettled = least(r.oldest_unsettled, EXCLUDED.oldest_unsettled),
         updated_at       = now();
  RETURN NULL;
END;
$function$;

-- A settlement (or an amount correction, or a delete) changes which rows
-- are outstanding for the pairs it touched. Recompute exactly those pairs
-- from the ledger: the partial index makes each one a single range scan.
CREATE OR REPLACE FUNCTION public.fn_agent_commission_rollup_recompute(p_pairs jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  WITH pairs AS (
    SELECT DISTINCT (p->>'club_id')::uuid AS club_id, (p->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(p_pairs) p
     WHERE p->>'club_id' IS NOT NULL AND p->>'user_id' IS NOT NULL
  ),
  fresh AS (
    SELECT pr.club_id, pr.user_id,
           coalesce(sum(ac.amount), 0)  AS owed,
           count(ac.id)                 AS rows_behind,
           min(ac.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id AND ac.settled_at IS NULL
     GROUP BY pr.club_id, pr.user_id
  )
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT f.club_id, f.user_id, f.owed, f.rows_behind, f.oldest, now() FROM fresh f
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed = EXCLUDED.owed,
         rows_behind = EXCLUDED.rows_behind,
         oldest_unsettled = EXCLUDED.oldest_unsettled,
         updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pairs jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be combined with a column list on the
    -- trigger, so the trigger fires on every UPDATE and the filter is here:
    -- only rows whose outstanding amount, settlement or ownership changed
    -- name a pair to recompute. A notes-only update names none.
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('club_id', x.club_id, 'user_id', x.user_id)), '[]'::jsonb)
      INTO v_pairs
      FROM (
        SELECT o.club_id, o.user_id
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.settled_at IS DISTINCT FROM n.settled_at
            OR o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.user_id IS DISTINCT FROM n.user_id
        UNION
        SELECT n.club_id, n.user_id
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.settled_at IS DISTINCT FROM n.settled_at
            OR o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.user_id IS DISTINCT FROM n.user_id
      ) x;
  ELSE
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('club_id', o.club_id, 'user_id', o.user_id)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o;
  END IF;
  IF v_pairs <> '[]'::jsonb THEN
    PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_agent_commission_rollup_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_agent_commission_rollup_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_agent_commission_rollup_recompute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_commission_rollup_recompute(jsonb) TO service_role;

DROP TRIGGER IF EXISTS trg_agent_commission_rollup_ins ON public.agent_commissions;
CREATE TRIGGER trg_agent_commission_rollup_ins
  AFTER INSERT ON public.agent_commissions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_agent_commission_rollup_insert();

DROP TRIGGER IF EXISTS trg_agent_commission_rollup_upd ON public.agent_commissions;
CREATE TRIGGER trg_agent_commission_rollup_upd
  AFTER UPDATE ON public.agent_commissions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_agent_commission_rollup_change();

DROP TRIGGER IF EXISTS trg_agent_commission_rollup_del ON public.agent_commissions;
CREATE TRIGGER trg_agent_commission_rollup_del
  AFTER DELETE ON public.agent_commissions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_agent_commission_rollup_change();

-- ─────────────────────────────────────────────────────────────────────────
--  3. Rebuild, for the day something writes the ledger without a trigger
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_rebuild_agent_commission_rollup()
RETURNS TABLE(pairs bigint, owed numeric, rows_behind bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (session_user IN ('postgres', 'supabase_admin')
          OR coalesce(auth.role(), '') = 'service_role'
          OR coalesce(fn_is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'rebuild is an operator action' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.agent_commission_unsettled_rollup;
  INSERT INTO public.agent_commission_unsettled_rollup
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT ac.club_id, ac.user_id, sum(ac.amount), count(*), min(ac.created_at), now()
    FROM agent_commissions ac
   WHERE ac.settled_at IS NULL AND ac.club_id IS NOT NULL AND ac.user_id IS NOT NULL
   GROUP BY ac.club_id, ac.user_id;

  RETURN QUERY
  SELECT count(*)::bigint, coalesce(sum(r.owed), 0), coalesce(sum(r.rows_behind), 0)::bigint
    FROM public.agent_commission_unsettled_rollup r;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_rebuild_agent_commission_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rebuild_agent_commission_rollup() TO service_role;

-- Backfill. CREATE TRIGGER above took SHARE ROW EXCLUSIVE on
-- agent_commissions, so every commission INSERT queues behind this
-- transaction until COMMIT (it waits; it does not fail - the same shape as
-- the index rebuild in 20260903210000). The GROUP BY therefore sees every
-- row that exists, the triggers see every row that arrives afterwards, and
-- no row is counted twice or missed. Measured: the aggregate over 2.45M
-- rows is a few seconds, which is the length of the queue.
INSERT INTO public.agent_commission_unsettled_rollup
       (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
SELECT ac.club_id, ac.user_id, sum(ac.amount), count(*), min(ac.created_at), now()
  FROM agent_commissions ac
 WHERE ac.settled_at IS NULL AND ac.club_id IS NOT NULL AND ac.user_id IS NOT NULL
 GROUP BY ac.club_id, ac.user_id
ON CONFLICT (club_id, user_id) DO UPDATE
   SET owed = agent_commission_unsettled_rollup.owed + EXCLUDED.owed,
       rows_behind = agent_commission_unsettled_rollup.rows_behind + EXCLUDED.rows_behind,
       oldest_unsettled = least(agent_commission_unsettled_rollup.oldest_unsettled, EXCLUDED.oldest_unsettled),
       updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────
--  4. The payables read comes off the rollup
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_agent_payables(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows      jsonb;
  v_owed      numeric;
  v_count     bigint;
  v_agents    integer;
  v_estimate  numeric;
  v_oldest    timestamptz;
  v_checked   timestamptz;
  v_cap constant integer := 200;
BEGIN
  IF NOT fn_ca_can_manage_agents(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH ranked AS (
    SELECT a.id,
           a.user_id,
           a.role,
           coalesce(a.status, 'active') AS status,
           coalesce(a.is_prepaid, false) AS is_prepaid,
           coalesce(a.credit_limit, 0)   AS credit_limit,
           coalesce(a.credit_used, 0)    AS credit_used,
           coalesce(a.commission_rate, 0) AS commission_rate,
           coalesce(a.player_rakeback_rate, 0) AS player_rakeback_rate,
           coalesce(a.total_players, 0)  AS total_players,
           coalesce(o.owed, 0)           AS owed,
           coalesce(o.rows_behind, 0)    AS rows_behind,
           o.oldest_unsettled            AS oldest,
           o.updated_at                  AS checked,
           -- What the page printed before this function existed, kept beside
           -- the truth rather than replaced silently.
           round(coalesce(a.weekly_rake_generated, 0)
                 * coalesce(a.commission_rate, 0), 2) AS estimate,
           coalesce(
             nullif(btrim(pr.display_name), ''),
             nullif(btrim(pr.alias), ''),
             nullif(btrim(pr.username), ''),
             'Member') AS name,
           row_number() OVER (ORDER BY coalesce(o.owed, 0) DESC, a.created_at) AS rn
      FROM agents a
      LEFT JOIN agent_commission_unsettled_rollup o
             ON o.club_id = p_club_id AND o.user_id = a.user_id
      LEFT JOIN profiles pr ON pr.id = a.user_id
     WHERE a.club_id = p_club_id
  )
  SELECT
    coalesce(jsonb_agg(
      jsonb_build_object(
        'agent_id', r.id,
        'user_id', r.user_id,
        'name', r.name,
        'role', r.role,
        'status', r.status,
        'is_prepaid', r.is_prepaid,
        'credit_limit', r.credit_limit,
        'credit_used', r.credit_used,
        'credit_available', greatest(r.credit_limit - r.credit_used, 0),
        'utilization', CASE WHEN r.credit_limit > 0
                            THEN round(r.credit_used / r.credit_limit, 4)
                            ELSE 0 END,
        'commission_rate', r.commission_rate,
        'player_rakeback_rate', r.player_rakeback_rate,
        'total_players', r.total_players,
        'owed', round(r.owed, 2),
        'rows_behind', r.rows_behind,
        'oldest_unsettled', r.oldest,
        'estimate', r.estimate)
      ORDER BY r.rn) FILTER (WHERE r.rn <= v_cap), '[]'::jsonb),
    count(*)::integer,
    round(sum(r.owed), 2),
    sum(r.rows_behind),
    round(sum(r.estimate), 2),
    min(r.oldest),
    max(r.checked)
    INTO v_rows, v_agents, v_owed, v_count, v_estimate, v_oldest, v_checked
  FROM ranked r;

  RETURN jsonb_build_object(
    'agents', coalesce(v_agents, 0),
    'cap', v_cap,
    'total_owed', coalesce(v_owed, 0),
    'total_rows', coalesce(v_count, 0),
    'total_estimate', coalesce(v_estimate, 0),
    'oldest_unsettled', v_oldest,
    'rollup_checked_at', v_checked,
    'rows', v_rows,
    'generated_at', now());
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_agent_payables(uuid) IS
  'What a club owes each of its agents, read from agent_commission_unsettled_rollup (trigger-maintained since 2026-09-04; it was a scan of every unsettled commission row before). Gated by fn_ca_can_manage_agents.';

-- ─────────────────────────────────────────────────────────────────────────
--  Assertions: the rollup equals the ledger it was built from
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  l_owed numeric; l_rows bigint; r_owed numeric; r_rows bigint; n integer;
BEGIN
  SELECT coalesce(sum(amount), 0), count(*) INTO l_owed, l_rows
    FROM agent_commissions WHERE settled_at IS NULL AND club_id IS NOT NULL AND user_id IS NOT NULL;
  SELECT coalesce(sum(owed), 0), coalesce(sum(rows_behind), 0) INTO r_owed, r_rows
    FROM agent_commission_unsettled_rollup;
  IF l_rows <> r_rows OR abs(l_owed - r_owed) > 0.000001 THEN
    RAISE EXCEPTION 'rollup % / % does not equal ledger % / %', r_owed, r_rows, l_owed, l_rows;
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.agent_commissions'::regclass
     AND tgname IN ('trg_agent_commission_rollup_ins', 'trg_agent_commission_rollup_upd', 'trg_agent_commission_rollup_del');
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 rollup triggers, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'fn_ca_agent_payables'
     AND p.prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 1 THEN RAISE EXCEPTION 'fn_ca_agent_payables grants changed'; END IF;
END $$;

COMMIT;
