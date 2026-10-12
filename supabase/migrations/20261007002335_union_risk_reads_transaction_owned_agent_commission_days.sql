-- Union Risk cold commission probes read 1,084,468 original rows across111pairs
-- in4.883s and exceeded the existing combined8s request budget. This introduces
-- exact closed UTC-day per-agent facts, initialized only by an explicit bounded
-- operator call under the original sorted club commission keys. The original
-- INSERT transaction adds later/backdated deltas exactly once; unqualified days
-- remain raw until the locked baseline is explicitly initialized. A one-time
-- current/future baseline proves all later days, with original INSERT deltas
-- maintaining that provenance; explicit invalidation always overrides it.
-- Relevant UPDATE/DELETE/TRUNCATE invalidate completeness; settlement-only
-- changes preserve it. Missing days, exact head/tail and older windows remain
-- original raw sums. No scheduled repair, money move, timeout increase or zero
-- fallback is introduced. No source history is removed.
-- unqualified-write-ok: smarter_private.agent_commission_report_days because this private postgres-only trigger clears every derived completeness marker only after the original journal is explicitly truncated; no browser role can call it or modify the private table.
-- @live-proof: md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure)) = 'cfd722f72a01fd7fe8efc08dd2027f6a'
-- @live-proof: md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure)) = '1a07fad61faa37c4f9c1c78835fb7843'
-- unqualified-write-ok: smarter_private.agent_commission_report_frontiers because this postgres-only original-journal TRUNCATE trigger invalidates all derived future provenance; no browser role can mutate these facts.
-- @live-proof: md5(pg_get_functiondef('smarter_private.initialize_agent_commission_report_day(uuid,date)'::regprocedure)) = '5dd2776e3eac285f78f8dabed9225f51'
-- @live-proof: md5(pg_get_functiondef('smarter_private.invalidate_agent_commission_report_days()'::regprocedure)) = '2a1cde231f6a8036f51179d630fbbd2d'
-- @live-proof: md5(pg_get_functiondef('smarter_private.initialize_agent_commission_report_frontier(uuid)'::regprocedure)) = 'b4cb0882e0036ad69dde434fce8e81a2'
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure)) IS DISTINCT FROM '0215c54b5f864825dbb2502092551f14'
 OR md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure)) IS DISTINCT FROM 'c7e84377219a39d955783d0feae6642b'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public','jit=off'])
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.trg_agent_commission_rollup_insert()'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=public'])
 OR to_regclass('smarter_private.agent_commission_report_days') IS NOT NULL
 OR to_regclass('smarter_private.agent_commission_report_daily') IS NOT NULL
 OR to_regclass('smarter_private.agent_commission_report_frontiers') IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.agent_commissions'::regclass AND tgname='trg_agent_commission_rollup_ins' AND tgenabled='O' AND tgfoid='public.trg_agent_commission_rollup_insert()'::regprocedure AND tgnewtable='new_rows')
 THEN RAISE EXCEPTION 'COMMISSION_REPORT_SOURCE_PREIMAGE_CHANGED'; END IF;
END;$preimage$;
CREATE TABLE smarter_private.agent_commission_report_days(
 club_id uuid NOT NULL,day date NOT NULL,computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(club_id,day));
CREATE TABLE smarter_private.agent_commission_report_daily(
 club_id uuid NOT NULL,day date NOT NULL,user_id uuid NOT NULL,amount numeric NOT NULL,
 PRIMARY KEY(club_id,day,user_id));
ALTER TABLE smarter_private.agent_commission_report_days OWNER TO postgres;
ALTER TABLE smarter_private.agent_commission_report_daily OWNER TO postgres;
REVOKE ALL ON smarter_private.agent_commission_report_days,smarter_private.agent_commission_report_daily FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE smarter_private.agent_commission_report_frontiers(
 club_id uuid PRIMARY KEY,first_complete_day date NOT NULL,
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE smarter_private.agent_commission_report_frontiers OWNER TO postgres;
REVOKE ALL ON smarter_private.agent_commission_report_frontiers FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.initialize_agent_commission_report_frontier(p_club uuid)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,smarter_private AS $function$
DECLARE v_count bigint;v_today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'COMMISSION_REPORT_INITIALIZATION_REQUIRES_FRESH_SNAPSHOT' USING ERRCODE='25001';
 END IF;
 IF p_club IS NULL THEN RAISE EXCEPTION 'COMMISSION_REPORT_CLUB_REQUIRED' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||p_club::text,0));
 IF EXISTS(SELECT 1 FROM smarter_private.agent_commission_report_frontiers WHERE club_id=p_club) THEN
   RAISE EXCEPTION 'COMMISSION_REPORT_FRONTIER_ALREADY_INITIALIZED' USING ERRCODE='55000';
 END IF;
 -- Capture every existing future-dated source too; there is no assumed empty tail.
 DELETE FROM smarter_private.agent_commission_report_daily WHERE club_id=p_club AND day>=v_today;
 INSERT INTO smarter_private.agent_commission_report_daily(club_id,day,user_id,amount)
 SELECT p_club,(a.created_at AT TIME ZONE 'UTC')::date,a.user_id,COALESCE(SUM(a.amount),0)
 FROM public.agent_commissions a WHERE a.club_id=p_club AND a.user_id IS NOT NULL
 AND a.created_at>=(v_today::timestamp AT TIME ZONE 'UTC')
 GROUP BY (a.created_at AT TIME ZONE 'UTC')::date,a.user_id;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 -- These private markers have just been rebuilt from the locked fresh snapshot.
 DELETE FROM smarter_private.agent_commission_report_days WHERE club_id=p_club AND day>=v_today;
 INSERT INTO smarter_private.agent_commission_report_frontiers(club_id,first_complete_day) VALUES(p_club,v_today);
 RETURN v_count;
END;$function$;
ALTER FUNCTION smarter_private.initialize_agent_commission_report_frontier(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.initialize_agent_commission_report_frontier(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.initialize_agent_commission_report_day(p_club uuid,p_day date)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,smarter_private AS $function$
DECLARE v_count bigint;v_today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'COMMISSION_REPORT_INITIALIZATION_REQUIRES_FRESH_SNAPSHOT' USING ERRCODE='25001';
 END IF;
 IF p_club IS NULL OR p_day IS NULL OR NOT isfinite(p_day)
    OR p_day>=v_today OR p_day<v_today-7 THEN
   RAISE EXCEPTION 'COMMISSION_REPORT_DAY_OUTSIDE_BOUNDED_CLOSED_WINDOW' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||p_club::text,0));
 -- VOLATILE commands obtain fresh snapshots after the existing original writer key.
 DELETE FROM smarter_private.agent_commission_report_daily WHERE club_id=p_club AND day=p_day;
 INSERT INTO smarter_private.agent_commission_report_daily(club_id,day,user_id,amount)
 SELECT p_club,p_day,a.user_id,COALESCE(SUM(a.amount),0)
   FROM public.agent_commissions a
  WHERE a.club_id=p_club AND a.user_id IS NOT NULL
    AND a.created_at>=(p_day::timestamp AT TIME ZONE 'UTC')
    AND a.created_at<((p_day+1)::timestamp AT TIME ZONE 'UTC')
  GROUP BY a.user_id;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 INSERT INTO smarter_private.agent_commission_report_days(club_id,day,complete)
 VALUES(p_club,p_day,true) ON CONFLICT(club_id,day) DO UPDATE SET computed_at=clock_timestamp(),complete=true;
 RETURN v_count;
END;$function$;
ALTER FUNCTION smarter_private.initialize_agent_commission_report_day(uuid,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.initialize_agent_commission_report_day(uuid,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.invalidate_agent_commission_report_days()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,smarter_private AS $function$
DECLARE c uuid;affected jsonb;
BEGIN
 IF TG_OP='TRUNCATE' THEN
   FOR c IN SELECT club_id FROM smarter_private.agent_commission_report_days UNION SELECT club_id FROM smarter_private.agent_commission_report_frontiers ORDER BY club_id LOOP
     PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||c::text,0));
   END LOOP;
   DELETE FROM smarter_private.agent_commission_report_days;
   DELETE FROM smarter_private.agent_commission_report_frontiers;
   RETURN NULL;
 ELSIF TG_OP='UPDATE' THEN
   SELECT jsonb_agg(DISTINCT jsonb_build_object('club',x.club_id,'day',(x.created_at AT TIME ZONE 'UTC')::date)) INTO affected
   FROM (
     SELECT o.club_id,o.created_at FROM old_rows o FULL JOIN new_rows n USING(id)
      WHERE o.id IS NULL OR n.id IS NULL OR o.amount IS DISTINCT FROM n.amount OR o.user_id IS DISTINCT FROM n.user_id
         OR o.club_id IS DISTINCT FROM n.club_id OR o.created_at IS DISTINCT FROM n.created_at
     UNION ALL
     SELECT n.club_id,n.created_at FROM old_rows o FULL JOIN new_rows n USING(id)
      WHERE o.id IS NULL OR n.id IS NULL OR o.amount IS DISTINCT FROM n.amount OR o.user_id IS DISTINCT FROM n.user_id
         OR o.club_id IS DISTINCT FROM n.club_id OR o.created_at IS DISTINCT FROM n.created_at
   )x WHERE x.club_id IS NOT NULL AND x.created_at IS NOT NULL;
 ELSE
   SELECT jsonb_agg(DISTINCT jsonb_build_object('club',o.club_id,'day',(o.created_at AT TIME ZONE 'UTC')::date))
    INTO affected FROM old_rows o WHERE o.club_id IS NOT NULL AND o.created_at IS NOT NULL;
 END IF;
 FOR c IN SELECT DISTINCT (x->>'club')::uuid FROM jsonb_array_elements(affected)x ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||c::text,0));
 END LOOP;
 INSERT INTO smarter_private.agent_commission_report_days(club_id,day,complete)
 SELECT DISTINCT (x->>'club')::uuid,(x->>'day')::date,false FROM jsonb_array_elements(affected)x
 ON CONFLICT(club_id,day) DO UPDATE SET complete=false,computed_at=clock_timestamp();
 RETURN NULL;
END;$function$;
ALTER FUNCTION smarter_private.invalidate_agent_commission_report_days() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.invalidate_agent_commission_report_days() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_commission_report_invalidate_update AFTER UPDATE ON public.agent_commissions
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.invalidate_agent_commission_report_days();
CREATE TRIGGER zz_commission_report_invalidate_delete AFTER DELETE ON public.agent_commissions
 REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.invalidate_agent_commission_report_days();
CREATE TRIGGER zz_commission_report_invalidate_truncate AFTER TRUNCATE ON public.agent_commissions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.invalidate_agent_commission_report_days();
CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  /* ONE KEY PER CLUB, IN CLUB ORDER, BEFORE ITS ROLLUP ROWS (2026-10-01).
     Each commission row takes its agent's unsettled row and then the club's
     day row, so a writer with two tiers held the day row while it asked for
     its second agent's row - which a tournament finish, holding that agent's
     row, was waiting to pass on its way to the day row. The club's
     commission key comes first, in club order: the cash accrual batch takes
     every key it will need before its first item (fn_credit_agent_commissions_batch,
     fn_retry_cash_accounting_sources), a finish takes them here source by
     source in club order, and within one club only its holder writes these
     rows. The sums below are unchanged. */
  FOR v_club IN SELECT DISTINCT n.club_id FROM new_rows n WHERE n.club_id IS NOT NULL ORDER BY n.club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_club::text,0));
  END LOOP;

  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
     AND NOT public.fn_agent_commission_paid_by_period(n.club_id, n.user_id, n.created_at)
   GROUP BY n.club_id, n.user_id
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed             = r.owed + EXCLUDED.owed,
         rows_behind      = r.rows_behind + EXCLUDED.rows_behind,
         oldest_unsettled = least(r.oldest_unsettled, EXCLUDED.oldest_unsettled),
         updated_at       = now();

  -- Phase 6: the per-day total the Financials page reads.
  INSERT INTO public.ca_club_commission_daily AS c
         (club_id, stat_date, amount, rows_counted, updated_at)
  SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, sum(n.amount), count(*), now()
    FROM new_rows n
   WHERE n.club_id IS NOT NULL
   GROUP BY n.club_id, (n.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET amount       = c.amount + EXCLUDED.amount,
         rows_counted = c.rows_counted + EXCLUDED.rows_counted,
         updated_at   = now();
  -- Original INSERT deltas are synchronous, even for not-yet-qualified days.
  -- Such rows remain unread until an explicit locked baseline marks completeness.
  INSERT INTO smarter_private.agent_commission_report_daily AS d(club_id,day,user_id,amount)
  SELECT n.club_id,(n.created_at AT TIME ZONE 'UTC')::date,n.user_id,COALESCE(SUM(n.amount),0)
    FROM new_rows n
   WHERE n.club_id IS NOT NULL AND n.user_id IS NOT NULL AND n.created_at IS NOT NULL
   GROUP BY n.club_id,(n.created_at AT TIME ZONE 'UTC')::date,n.user_id
  ON CONFLICT(club_id,day,user_id) DO UPDATE SET amount=d.amount+EXCLUDED.amount;
  RETURN NULL;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_union_agent_risk_report(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_user_id uuid, agent_name text, club_name text, role text, players integer, seated_now integer, rake_generated numeric, player_net numeric, commission_accrued numeric, credit_extended numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET jit TO 'off'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_today timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_head_end timestamptz;
  v_tail_start timestamptz;
  v_clubs uuid[];
  v_comm_today timestamptz := date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_comm_day_lo date;
  v_comm_head_end timestamptz;
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT COALESCE(array_agg(x.club_id), '{}'::uuid[])
    INTO v_clubs
    FROM (
      SELECT p_union_id AS club_id
      UNION
      SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id = p_union_id
    ) x;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN
    v_day_lo := v_day_lo + 1;
  END IF;
  v_head_end := LEAST(v_day_lo::timestamptz, v_today);
  v_tail_start := GREATEST(v_today, v_from);

  v_comm_day_lo := (v_from AT TIME ZONE 'UTC')::date;
  IF (v_comm_day_lo::timestamp AT TIME ZONE 'UTC')<v_from THEN
    v_comm_day_lo:=v_comm_day_lo+1;
  END IF;
  v_comm_head_end:=LEAST(v_comm_day_lo::timestamp AT TIME ZONE 'UTC',v_comm_today);

  RETURN QUERY
  WITH roster AS MATERIALIZED (
    SELECT m.agent_id AS agent_user_id,
           m.user_id AS player_id,
           m.club_id,
           m.joined_at,
           COALESCE(m.credit_used, 0) AS credit_used
      FROM public.club_members m
     WHERE m.club_id = ANY(v_clubs)
       AND m.agent_id IS NOT NULL
  ),
  rake_roster AS MATERIALIZED (
    SELECT DISTINCT ON (r.player_id)
           r.player_id, r.club_id
      FROM roster r
     ORDER BY r.player_id, (r.club_id = p_union_id),
              r.joined_at ASC NULLS LAST, r.club_id
  ),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = ANY(v_clubs)
       AND rc.day >= v_day_lo
       AND rc.day < v_today::date
  ),
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM unnest(v_clubs) c(club_id)
      CROSS JOIN generate_series(v_day_lo, v_today::date - 1, interval '1 day') g
     WHERE v_day_lo < v_today::date
       AND NOT EXISTS (
         SELECT 1 FROM ok_days o
          WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  gap_hand_records AS MATERIALIZED (
    SELECT r.id, r.rake_amount
      FROM gap_days gd
      CROSS JOIN LATERAL (
        SELECT rr.id, rr.rake_amount
          FROM public.rake_records rr
         WHERE v_from >= v_today - interval '7 days'
           AND rr.club_id = gd.club_id
           AND rr.created_at >= gd.day::timestamptz
           AND rr.created_at < (gd.day + 1)::timestamptz
           AND rr.hand_id IS NOT NULL
           AND rr.rake_amount > 0
           AND rr.player_contributions IS NOT NULL
         OFFSET 0
      ) r
  ),
  gap_hand_fallback_records AS MATERIALIZED (
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_hand_records x
      JOIN public.rake_records r ON r.id = x.id
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.rake_attributions a
        WHERE a.rake_record_id = x.id
          AND a.eligible_contribution > 0)
  ),
  rollup_rake AS (
    SELECT rr.player_id, rr.club_id, SUM(d.rake_amount) AS amount
      FROM public.club_rake_daily_user d
      JOIN ok_days o ON o.club_id = d.club_id AND o.day = d.day
      JOIN rake_roster rr ON rr.player_id = d.user_id
     GROUP BY rr.player_id, rr.club_id
  ),
  edge_attribution_rake AS (
    SELECT rr.player_id, rr.club_id, SUM(a.rake_amount) AS amount
      FROM (
        SELECT ra.player_id, ra.rake_amount
          FROM public.rake_attributions ra
         WHERE v_from >= v_today - interval '7 days'
           AND ra.club_id = ANY(v_clubs)
           AND ra.created_at >= v_from
           AND ra.created_at < v_head_end
           AND ra.hand_id IS NOT NULL
           AND ra.rake_amount > 0
        UNION ALL
        SELECT ra.player_id, ra.rake_amount
          FROM public.rake_attributions ra
         WHERE ra.club_id = ANY(v_clubs)
           AND ra.created_at >= v_tail_start
           AND ra.hand_id IS NOT NULL
           AND ra.rake_amount > 0
      ) a
      JOIN rake_roster rr ON rr.player_id = a.player_id
     GROUP BY rr.player_id, rr.club_id
  ),
  raw_records AS MATERIALIZED (
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE v_from < v_today - interval '7 days'
       AND r.club_id = ANY(v_clubs)
       AND r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE v_from >= v_today - interval '7 days'
       AND r.club_id = ANY(v_clubs)
       AND r.created_at >= v_from AND r.created_at < v_head_end
       AND r.hand_id IS NULL
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM ok_days o
      JOIN public.rake_records r
        ON r.club_id = o.club_id
       AND r.created_at >= o.day::timestamptz
       AND r.created_at < (o.day + 1)::timestamptz
     WHERE r.hand_id IS NULL
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_days gd
      CROSS JOIN LATERAL (
        SELECT rr.id, rr.rake_amount, rr.player_contributions
          FROM public.rake_records rr
         WHERE v_from < v_today - interval '7 days'
           AND rr.club_id = gd.club_id
           AND rr.created_at >= gd.day::timestamptz
           AND rr.created_at < (gd.day + 1)::timestamptz
           AND rr.rake_amount > 0
           AND rr.player_contributions IS NOT NULL
         OFFSET 0
      ) r
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_days gd
      CROSS JOIN LATERAL (
        SELECT rr.id, rr.rake_amount, rr.player_contributions
          FROM public.rake_records rr
         WHERE v_from >= v_today - interval '7 days'
           AND rr.club_id = gd.club_id
           AND rr.created_at >= gd.day::timestamptz
           AND rr.created_at < (gd.day + 1)::timestamptz
           AND rr.hand_id IS NULL
           AND rr.rake_amount > 0
           AND rr.player_contributions IS NOT NULL
         OFFSET 0
      ) r
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_hand_fallback_records r
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE r.club_id = ANY(v_clubs)
       AND r.created_at >= v_tail_start
       AND r.hand_id IS NULL
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE r.club_id = ANY(v_clubs)
       AND r.created_at >= v_from
       AND r.rake_amount < 0 AND r.player_contributions IS NOT NULL
  ),
  raw_rake AS (
    SELECT rr.player_id, rr.club_id,
           SUM(x.rake_amount * split.contribution / NULLIF(split.total, 0)) AS amount
      FROM raw_records x
      CROSS JOIN LATERAL (
        SELECT (e.key)::uuid AS player_id,
               e.value::numeric AS contribution,
               SUM(e.value::numeric) OVER () AS total
          FROM jsonb_each_text(x.player_contributions) e(key, value)
         WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           AND e.value::numeric > 0
      ) split
      JOIN rake_roster rr ON rr.player_id = split.player_id
     WHERE split.total > 0
     GROUP BY rr.player_id, rr.club_id
  ),
  gap_hand_rake AS (
    SELECT rr.player_id, rr.club_id,
           SUM(x.rake_amount * split.eligible_contribution
               / NULLIF(split.total, 0)) AS amount
      FROM gap_hand_records x
      CROSS JOIN LATERAL (
        SELECT a.player_id,
               a.eligible_contribution,
               SUM(a.eligible_contribution) OVER (
                 PARTITION BY a.rake_record_id) AS total
          FROM public.rake_attributions a
         WHERE a.rake_record_id = x.id
           AND a.eligible_contribution > 0
      ) split
      JOIN rake_roster rr ON rr.player_id = split.player_id
     WHERE split.total > 0
     GROUP BY rr.player_id, rr.club_id
  ),
  rake AS (
    SELECT q.player_id, q.club_id, SUM(q.amount) AS rake_generated
      FROM (
        SELECT * FROM rollup_rake
        UNION ALL SELECT * FROM edge_attribution_rake
        UNION ALL SELECT * FROM raw_rake
        UNION ALL SELECT * FROM gap_hand_rake
      ) q
     GROUP BY q.player_id, q.club_id
  ),
  flows AS MATERIALIZED (
    SELECT p.player_id, p.club_id,
           COALESCE((
             SELECT SUM(l.amount)
               FROM public.chip_ledger l
              WHERE l.club_id = p.club_id
                AND l.to_entity_id = p.player_id
                AND l.created_at >= v_from
                AND l.status = 'posted'
                AND l.to_type = 'player_wallet'
                AND l.from_type = 'table_stack'
           ), 0) - COALESCE((
             SELECT SUM(l.amount)
               FROM public.chip_ledger l
              WHERE l.club_id = p.club_id
                AND l.from_entity_id = p.player_id
                AND l.created_at >= v_from
                AND l.status = 'posted'
                AND l.from_type = 'player_wallet'
                AND l.to_type = 'table_stack'
           ), 0) AS net
      FROM (SELECT DISTINCT r.player_id, r.club_id FROM roster r) p
  ),
  comm_pairs AS MATERIALIZED (
    SELECT DISTINCT r.agent_user_id, r.club_id FROM roster r
  ),
  comm_ok_days AS MATERIALIZED (
    SELECT c.club_id,g::date AS day
      FROM unnest(v_clubs)c(club_id)
      CROSS JOIN generate_series(v_comm_day_lo,(v_comm_today AT TIME ZONE 'UTC')::date-1,interval '1 day')g
      LEFT JOIN smarter_private.agent_commission_report_days m ON m.club_id=c.club_id AND m.day=g::date
      LEFT JOIN smarter_private.agent_commission_report_frontiers f ON f.club_id=c.club_id
     WHERE v_from>=v_comm_today-interval '7 days'
       AND v_comm_day_lo<(v_comm_today AT TIME ZONE 'UTC')::date
       AND (m.complete IS TRUE OR (m.club_id IS NULL AND g::date>=f.first_complete_day))
  ),
  comm_gap_days AS MATERIALIZED (
    SELECT c.club_id,g::date AS day
      FROM unnest(v_clubs)c(club_id)
      CROSS JOIN generate_series(v_comm_day_lo,(v_comm_today AT TIME ZONE 'UTC')::date-1,interval '1 day')g
     WHERE v_from>=v_comm_today-interval '7 days'
       AND v_comm_day_lo<(v_comm_today AT TIME ZONE 'UTC')::date
       AND NOT EXISTS(SELECT 1 FROM comm_ok_days m WHERE m.club_id=c.club_id AND m.day=g::date)
  ),
  comm AS MATERIALIZED (
    SELECT p.agent_user_id,p.club_id,COALESCE((
      SELECT SUM(x.amount) FROM (
        SELECT d.amount
          FROM smarter_private.agent_commission_report_daily d
          JOIN comm_ok_days m ON m.club_id=d.club_id AND m.day=d.day
         WHERE d.club_id=p.club_id AND d.user_id=p.agent_user_id
        UNION ALL
        SELECT ac.amount FROM public.agent_commissions ac
         WHERE ac.user_id = p.agent_user_id AND ac.club_id = p.club_id
           AND ac.created_at>=v_from AND ac.created_at<v_comm_head_end
        UNION ALL
        SELECT ac.amount FROM public.agent_commissions ac
         WHERE ac.user_id = p.agent_user_id AND ac.club_id = p.club_id
           AND ac.created_at>=GREATEST(v_comm_today,v_from)
        UNION ALL
        SELECT ac.amount FROM comm_gap_days gd CROSS JOIN LATERAL (
          SELECT a.amount FROM public.agent_commissions a
           WHERE a.user_id=p.agent_user_id AND a.club_id=p.club_id
             AND a.created_at>=(gd.day::timestamp AT TIME ZONE 'UTC')
             AND a.created_at<((gd.day+1)::timestamp AT TIME ZONE 'UTC')
          OFFSET 0
        )ac WHERE gd.club_id=p.club_id
        UNION ALL
        SELECT ac.amount FROM public.agent_commissions ac
         WHERE v_from<v_comm_today-interval '7 days'
           AND ac.user_id = p.agent_user_id AND ac.club_id = p.club_id
           AND ac.created_at>=v_comm_head_end AND ac.created_at<v_comm_today
      )x
    ),0) AS amt FROM comm_pairs p
  ),
  seated AS MATERIALIZED (
    SELECT s.user_id, s.club_id
      FROM public.table_seats s
      JOIN (SELECT DISTINCT r.player_id, r.club_id FROM roster r) p
        ON p.player_id = s.user_id AND p.club_id = s.club_id
     WHERE s.left_at IS NULL
     GROUP BY s.user_id, s.club_id
  )
  SELECT r.agent_user_id,
         pr.username,
         cl.name,
         COALESCE(a.role, 'agent'),
         COUNT(DISTINCT r.player_id)::int,
         COUNT(DISTINCT r.player_id) FILTER (WHERE st.user_id IS NOT NULL)::int,
         ROUND(COALESCE(SUM(rk.rake_generated), 0), 2),
         ROUND(COALESCE(SUM(fl.net), 0), 2),
         ROUND(COALESCE(MAX(cm.amt), 0), 2),
         ROUND(COALESCE(SUM(r.credit_used), 0), 2)
    FROM roster r
    LEFT JOIN public.profiles pr ON pr.id = r.agent_user_id
    LEFT JOIN public.clubs cl ON cl.id = r.club_id
    LEFT JOIN public.agents a ON a.user_id = r.agent_user_id AND a.club_id = r.club_id
    LEFT JOIN rake rk ON rk.player_id = r.player_id AND rk.club_id = r.club_id
    LEFT JOIN flows fl ON fl.player_id = r.player_id AND fl.club_id = r.club_id
    LEFT JOIN comm cm ON cm.agent_user_id = r.agent_user_id AND cm.club_id = r.club_id
    LEFT JOIN seated st ON st.user_id = r.player_id AND st.club_id = r.club_id
   GROUP BY r.agent_user_id, pr.username, cl.name, a.role
   ORDER BY 8 DESC NULLS LAST;
END
$function$
;
DO $postimage$ BEGIN
 IF md5(pg_get_functiondef('smarter_private.initialize_agent_commission_report_frontier(uuid)'::regprocedure)) IS DISTINCT FROM 'b4cb0882e0036ad69dde434fce8e81a2'
 OR md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure)) IS DISTINCT FROM 'cfd722f72a01fd7fe8efc08dd2027f6a'
 OR md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure)) IS DISTINCT FROM '1a07fad61faa37c4f9c1c78835fb7843'
 OR md5(pg_get_functiondef('smarter_private.initialize_agent_commission_report_day(uuid,date)'::regprocedure)) IS DISTINCT FROM '5dd2776e3eac285f78f8dabed9225f51'
 OR md5(pg_get_functiondef('smarter_private.invalidate_agent_commission_report_days()'::regprocedure)) IS DISTINCT FROM '2a1cde231f6a8036f51179d630fbbd2d'

 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure,'public.trg_agent_commission_rollup_insert()'::regprocedure,'smarter_private.initialize_agent_commission_report_day(uuid,date)'::regprocedure,'smarter_private.initialize_agent_commission_report_frontier(uuid)'::regprocedure,'smarter_private.invalidate_agent_commission_report_days()'::regprocedure) AND (p.proowner<>'postgres'::regrole OR NOT p.prosecdef))
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure AND provolatile='s' AND proconfig=ARRAY['search_path=public','jit=off'])
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.trg_agent_commission_rollup_insert()'::regprocedure AND provolatile='v' AND proconfig=ARRAY['search_path=public'])
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid IN('smarter_private.initialize_agent_commission_report_day(uuid,date)'::regprocedure,'smarter_private.initialize_agent_commission_report_frontier(uuid)'::regprocedure,'smarter_private.invalidate_agent_commission_report_days()'::regprocedure) AND (a.grantee<>'postgres'::regrole OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']))
 OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN('smarter_private.agent_commission_report_days'::regclass,'smarter_private.agent_commission_report_daily'::regclass,'smarter_private.agent_commission_report_frontiers'::regclass) AND (c.relowner<>'postgres'::regrole OR a.grantee<>'postgres'::regrole))
 OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.agent_commissions'::regclass AND tgname IN('zz_commission_report_invalidate_update','zz_commission_report_invalidate_delete','zz_commission_report_invalidate_truncate') AND tgenabled='O' AND tgfoid='smarter_private.invalidate_agent_commission_report_days()'::regprocedure)<>3
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.agent_commissions'::regclass AND tgname='trg_agent_commission_rollup_ins' AND tgenabled='O' AND tgfoid='public.trg_agent_commission_rollup_insert()'::regprocedure AND tgnewtable='new_rows')
 THEN RAISE EXCEPTION 'COMMISSION_REPORT_POSTIMAGE_CHANGED';END IF;
END;$postimage$;
COMMIT;
