-- 20261004212118_union_distribution_check_reads_daily_commission_facts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Financial Admin's Settlement tab loads settlement rounds and the union
-- distribution check together. Midway Union's current-period distribution
-- read timed out because it summed roughly 3.2 million agent_commissions rows
-- from the journal on every tab load. A production READ ONLY parity probe
-- measured that direct commission read at 9.4 seconds by itself.
--
-- ca_club_commission_daily is the trigger-maintained, exact sum of every
-- agent_commissions.amount per club and UTC day, including signed values and
-- settled rows. The Financials page already reads this fact. This replacement
-- uses it only for complete UTC days. The partial first day and the current
-- UTC day through all future-dated rows remain direct covering-index reads,
-- preserving the function's arbitrary lower-bound and open-ended contract.
-- A same-snapshot production probe returned the exact same live total through
-- both paths before this migration was written.
--
-- No money moves. Authorization, union scoping, rake and rakeback sources,
-- return shape, note, rounding and health arithmetic are unchanged.
--
-- @live-preimage: definition md5 = 5361b2e2ad34cec018ac9be03b78d872
-- @live-preimage: body md5 = e380a07a61ae1ac4914972909492a4cd

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE
  v_insert_source text;
  v_change_source text;
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_union_distribution_check(uuid,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '5361b2e2ad34cec018ac9be03b78d872' THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_CHECK_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT md5(p.prosrc)
        FROM pg_proc p
       WHERE p.oid =
         'public.fn_union_distribution_check(uuid,timestamp with time zone)'::regprocedure)
       IS DISTINCT FROM 'e380a07a61ae1ac4914972909492a4cd' THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_CHECK_BODY_PREIMAGE_CHANGED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_distribution_check(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_CHECK_SECURITY_PREIMAGE_CHANGED';
  END IF;

  IF to_regclass('public.ca_club_commission_daily') IS NULL
     OR to_regprocedure('public.trg_agent_commission_rollup_insert()') IS NULL
     OR to_regprocedure('public.trg_agent_commission_rollup_change()') IS NULL THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_COMMISSION_FACT_SOURCE_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.ca_club_commission_daily'::regclass
       AND c.contype = 'p'
       AND (SELECT array_agg(a.attname ORDER BY k.ordinality)
              FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
           = ARRAY['club_id','stat_date']::name[]
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'public.ca_club_commission_daily'::regclass
       AND a.attname = 'amount'
       AND a.atttypid = 'numeric'::regtype
       AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_COMMISSION_FACT_SHAPE_CHANGED';
  END IF;

  SELECT pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure),
         pg_get_functiondef('public.trg_agent_commission_rollup_change()'::regprocedure)
    INTO v_insert_source, v_change_source;
  IF position('INSERT INTO public.ca_club_commission_daily' in v_insert_source) = 0
     OR position('INSERT INTO public.ca_club_commission_daily' in v_change_source) = 0
     OR position('(n.created_at AT TIME ZONE ''UTC'')::date' in v_insert_source) = 0
     OR position('(o.created_at AT TIME ZONE ''UTC'')::date' in v_change_source) = 0 THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_COMMISSION_FACT_WRITER_CHANGED';
  END IF;
  IF (SELECT count(*)
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.agent_commissions'::regclass
         AND NOT t.tgisinternal
         AND t.tgenabled IN ('O','A')
         AND ((t.tgname = 'trg_agent_commission_rollup_ins'
               AND p.oid = 'public.trg_agent_commission_rollup_insert()'::regprocedure)
           OR (t.tgname IN ('trg_agent_commission_rollup_upd',
                            'trg_agent_commission_rollup_del')
               AND p.oid = 'public.trg_agent_commission_rollup_change()'::regprocedure)))
       IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_COMMISSION_FACT_TRIGGER_CHANGED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indexrelid = 'public.idx_agent_commissions_club_created'::regclass
       AND i.indisvalid AND i.indisready AND i.indislive
       AND pg_get_indexdef(i.indexrelid) =
         'CREATE INDEX idx_agent_commissions_club_created ON public.agent_commissions USING btree (club_id, created_at) INCLUDE (user_id, amount, settled_at)'
  ) THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_COMMISSION_EDGE_INDEX_CHANGED';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_union_distribution_check(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',
  p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET jit TO 'off'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_today_date date := (now() AT TIME ZONE 'UTC')::date;
  v_today_start timestamptz;
  v_rollup_from_date date;
  v_rollup_from_start timestamptz;
  v_head_end timestamptz;
  v_clubs uuid[];
  v_rake numeric;
  v_comm numeric;
  v_rb numeric;
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT COALESCE(array_agg(c.id), '{}'::uuid[])
    INTO v_clubs
    FROM public.clubs c
   WHERE c.union_id = p_union_id OR c.id = p_union_id;

  SELECT COALESCE(SUM(rr.rake_amount), 0)
    INTO v_rake
    FROM public.rake_records rr
   WHERE rr.club_id = ANY(v_clubs)
     AND rr.created_at >= v_from;

  v_today_start := (v_today_date::timestamp AT TIME ZONE 'UTC');
  v_rollup_from_date := (v_from AT TIME ZONE 'UTC')::date;
  v_rollup_from_start :=
    (v_rollup_from_date::timestamp AT TIME ZONE 'UTC');
  IF v_from > v_rollup_from_start THEN
    v_rollup_from_date := v_rollup_from_date + 1;
    v_rollup_from_start :=
      (v_rollup_from_date::timestamp AT TIME ZONE 'UTC');
  END IF;
  v_head_end := LEAST(v_rollup_from_start, v_today_start);

  -- Exact UTC edges stay on the immutable commission journal. Only complete
  -- UTC days are read from the trigger-maintained daily fact, and the tail is
  -- intentionally open-ended so future-dated evidence keeps its old meaning.
  SELECT COALESCE(SUM(part.amount), 0)
    INTO v_comm
    FROM (
      SELECT COALESCE(SUM(ac.amount), 0) AS amount
        FROM public.agent_commissions ac
       WHERE v_from < v_head_end
         AND ac.club_id = ANY(v_clubs)
         AND ac.created_at >= v_from
         AND ac.created_at < v_head_end
      UNION ALL
      SELECT COALESCE(SUM(cd.amount), 0)
        FROM public.ca_club_commission_daily cd
       WHERE cd.club_id = ANY(v_clubs)
         AND cd.stat_date >= v_rollup_from_date
         AND cd.stat_date < v_today_date
      UNION ALL
      SELECT COALESCE(SUM(ac.amount), 0)
        FROM public.agent_commissions ac
       WHERE ac.club_id = ANY(v_clubs)
         AND ac.created_at >= GREATEST(v_from, v_today_start)
    ) part;

  SELECT COALESCE(SUM(rp.rakeback_amount), 0)
    INTO v_rb
    FROM public.rakeback_periods rp
   WHERE rp.club_id = ANY(v_clubs)
     AND rp.period_start >= v_from::date;

  RETURN jsonb_build_object(
    'period_start', v_from,
    'rake_collected', ROUND(v_rake, 2),
    'agent_commissions', ROUND(v_comm, 2),
    'player_rakeback', ROUND(v_rb, 2),
    'total_distributed', ROUND(v_comm + v_rb, 2),
    'over_distributed_by', ROUND(GREATEST((v_comm + v_rb) - v_rake, 0), 2),
    'healthy', (v_comm + v_rb) <= v_rake * 1.001,
    'note', 'Player rakeback is funded from the agent''s commission, so '
            || 'commissions + rakeback must not exceed the rake collected.');
END
$function$;

DO $postimage$
DECLARE
  v_source text := pg_get_functiondef(
    'public.fn_union_distribution_check(uuid,timestamp with time zone)'::regprocedure);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_distribution_check(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM
           ARRAY['search_path=public','jit=off']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'
  ) OR position('ca_club_commission_daily' in v_source) = 0
     OR (length(v_source) - length(replace(
           v_source, 'FROM public.agent_commissions ac', '')))
        / length('FROM public.agent_commissions ac') IS DISTINCT FROM 2
     OR position('GREATEST(v_from, v_today_start)' in v_source) = 0 THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_CHECK_POSTIMAGE_CHANGED';
  END IF;
END
$postimage$;

COMMIT;
