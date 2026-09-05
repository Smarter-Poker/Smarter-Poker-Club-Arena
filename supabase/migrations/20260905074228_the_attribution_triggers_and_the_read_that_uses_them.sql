-- ═══════════════════════════════════════════════════════════════════════════
--  THE ATTRIBUTION TRIGGERS, AND THE READ THAT USES THEM
--  Club Operations upgrade, phase 7 of 8. The half of 20260905073943 that
--  needs the maintenance freeze.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20260905073943` created `ca_club_rake_daily_user`, its two writers and its
-- backfill, and deliberately changed no behaviour: nothing read the table.
--
-- This is the half that switches the live edge over, and it is applied INSIDE
-- THE `:55` MAINTENANCE FREEZE (CLAUDE.md 13) because `CREATE TRIGGER` takes a
-- SHARE ROW EXCLUSIVE lock on `rake_attributions`, and that table takes a row
-- for every player in every raked hand. Holding that lock during play stops
-- the engine writing rake. During the freeze every table is parked at a hand
-- boundary and nothing is writing, which is what the window is for.
--
-- THE TRIGGERS AND THE READ LAND TOGETHER, in one transaction, and that is the
-- whole reason the split falls here rather than anywhere else. A read that
-- switched to the rollup before the triggers existed would lose every hand
-- raked in between, and would lose it silently.
--
-- The backfill is repeated for the unsealed days, because rake carried on
-- being written between the two migrations. It is the same exact recompute,
-- and it runs while nothing is writing, so what it writes is final.
--
-- WHY THIS EXISTS AT ALL, restated because the measurement is the point:
-- bounding the live scan to one day fixed the read at 04:00 and not at 19:00.
-- A busy day is a third of a million attribution rows, so `fn_ca_rake_by_agent`
-- measured 490ms at 03:55 and 3,402ms at 07:37 on the same club with nothing
-- changed, and `ca_rake_snapshot` went back to a 500 after 8,155ms. The panel
-- would have healed every morning and failed every evening.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

-- ───────────────────────────────────────────────────────────────────────────
--  4. The three triggers, each of which swallows its own failure
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_user_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_ids uuid[];
BEGIN
  SELECT array_agg(n.id) INTO v_ids
    FROM new_rows n
   WHERE n.club_id IS NOT NULL AND n.player_id IS NOT NULL AND n.rake_amount > 0;
  IF v_ids IS NOT NULL THEN
    PERFORM public.fn_ca_club_rake_daily_user_apply(v_ids);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never fail a raked hand for a reporting table.
  RAISE WARNING 'ca_club_rake_daily_user insert rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_user_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  -- An UPDATE or DELETE recomputes the affected keys exactly rather than
  -- subtracting a delta: it is rare, and a recompute cannot drift.
  FOR r IN
    SELECT DISTINCT club_id, day, user_id FROM (
      SELECT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date AS day, o.player_id AS user_id
        FROM old_rows o WHERE o.club_id IS NOT NULL AND o.player_id IS NOT NULL
      UNION
      SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, n.player_id
        FROM new_rows n WHERE n.club_id IS NOT NULL AND n.player_id IS NOT NULL
    ) k
  LOOP
    PERFORM public.fn_ca_club_rake_daily_user_rebuild_day(r.club_id, r.day, r.user_id);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily_user change rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_user_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date AS day, o.player_id AS user_id
      FROM old_rows o WHERE o.club_id IS NOT NULL AND o.player_id IS NOT NULL
  LOOP
    PERFORM public.fn_ca_club_rake_daily_user_rebuild_day(r.club_id, r.day, r.user_id);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily_user delete rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_user_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_user_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_user_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ca_club_rake_daily_user_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_ca_club_rake_daily_user_change() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_ca_club_rake_daily_user_delete() TO service_role;

DROP TRIGGER IF EXISTS trg_ca_club_rake_daily_user_ins ON public.rake_attributions;
DROP TRIGGER IF EXISTS trg_ca_club_rake_daily_user_upd ON public.rake_attributions;
DROP TRIGGER IF EXISTS trg_ca_club_rake_daily_user_del ON public.rake_attributions;

CREATE TRIGGER trg_ca_club_rake_daily_user_ins
  AFTER INSERT ON public.rake_attributions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_rake_daily_user_insert();

CREATE TRIGGER trg_ca_club_rake_daily_user_upd
  AFTER UPDATE ON public.rake_attributions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_rake_daily_user_change();

CREATE TRIGGER trg_ca_club_rake_daily_user_del
  AFTER DELETE ON public.rake_attributions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_club_rake_daily_user_delete();

-- ───────────────────────────────────────────────────────────────────────────
--  5. The read
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_uid  uuid    := auth.uid();
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
  v_over boolean := EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = p_club_id
                               AND public.fn_is_union_overseer(uc.union_id, v_uid));
  v_q    text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_out  jsonb;
BEGIN
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    SELECT rc.day FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), from_live AS (
    -- THE DAYS NOT YET SEALED, read from the incremental rollup the triggers
    -- on rake_attributions keep exact. This used to scan the attributions
    -- themselves, which is fine at 04:00 and a third of a million rows by
    -- midnight - the panel healed every morning and failed every evening.
    -- Same cents, same rounding, same source table as the sealed days.
    SELECT du.user_id,
           du.rake_cents::numeric / 100 AS rake,
           du.hands
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = p_club_id
       AND du.day >= date_trunc('day', v_from)::date
       -- A DAY IS IN RANGE WHEN ITS OWN MIDNIGHT IS BEFORE THE EXCLUSIVE END,
       -- never `<= date_trunc('day', v_to)`. v_to is either a midnight (ask
       -- for a range ending yesterday and it is TODAY's midnight) or now()
       -- itself (ask for a range ending today). The inclusive form got the
       -- second case right and the first case wrong, and put TODAY's rake into
       -- a report for YESTERDAY. Caught by comparing old against new under one
       -- snapshot before this shipped; four ranges agreed and that one did not.
       AND du.day::timestamptz < v_to
       AND NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), commission AS (
    SELECT ac.user_id,
           SUM(ac.amount)                                          AS earned,
           SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL)     AS outstanding,
           SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL) AS settled
      FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.created_at >= v_from AND ac.created_at < v_to
     GROUP BY ac.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a WHERE a.club_id = p_club_id AND a.status='active'
  ), direct AS (
    SELECT cm.agent_id, COUNT(*) AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake,0) <> 0) AS active,
           COALESCE(SUM(e.rake),0) AS rake, COALESCE(SUM(e.hands),0)::bigint AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth+1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id, COALESCE(SUM(d.rake),0) AS rake,
           COALESCE(SUM(d.players),0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), unlisted AS (
    SELECT SUM(cs.earned) AS earned, SUM(cs.outstanding) AS outstanding,
           SUM(cs.settled) AS settled, count(*)::int AS recipients
      FROM commission cs
     WHERE NOT EXISTS (SELECT 1 FROM club_agents ca WHERE ca.user_id = cs.user_id)
  ), listed AS (
    SELECT ca.user_id AS agent_user_id,
           COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                         pr.first_name, pr.last_name, pr.full_name),
                    pr.username, 'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0) AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           CASE WHEN v_cost THEN round(COALESCE(cs.earned,0),2)      END AS commission_earned,
           CASE WHEN v_cost THEN round(COALESCE(cs.outstanding,0),2) END AS commission_outstanding,
           CASE WHEN v_cost THEN round(COALESCE(cs.settled,0),2)     END AS commission_settled,
           -- The same three conditions the downline walker enforces.
           (v_cost OR v_over OR ca.user_id = v_uid
            OR public.fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)) AS can_drill,
           false AS is_unassigned, false AS is_residual
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           false, true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           false, true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), totals AS (
    -- Before the filter. The denominator is the club, not the search result.
    SELECT COALESCE(SUM(l.direct_rake),0) AS total_direct,
           SUM(l.commission_earned)       AS total_commission
      FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE v_q IS NULL OR l.name ILIKE '%' || public.fn_like_escape(v_q) || '%' ESCAPE '\'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC) AS rn
      FROM filtered f
  ), sliced AS (
    SELECT r.* FROM ranked r ORDER BY r.rn
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn) FROM sliced s), '[]'::jsonb),
    -- Counted, not taken from a window over the page: ask for an offset past
    -- the end and a windowed count would answer "nothing matches".
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', (SELECT t.total_commission FROM totals t))
    INTO v_out;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text)
  TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
--  The days that were still open while the first half was landing
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r record; v_keys bigint := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ra.club_id, (ra.created_at AT TIME ZONE 'UTC')::date AS day
      FROM public.rake_attributions ra
     WHERE ra.club_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.club_rake_rollup_complete rc
                        WHERE rc.club_id = ra.club_id
                          AND rc.day = (ra.created_at AT TIME ZONE 'UTC')::date)
  LOOP
    v_keys := v_keys + public.fn_ca_club_rake_daily_user_rebuild_day(r.club_id, r.day, NULL);
  END LOOP;
  RAISE NOTICE 'refreshed % (club, day, player) rows on the unsealed days', v_keys;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
--  7. Assertions
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_src   text;
  v_club  uuid;
  v_day   date;
  v_a     numeric;
  v_b     numeric;
BEGIN
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_rake_by_agent'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%public.ca_club_rake_daily_user du%' THEN
    RAISE EXCEPTION 'the live edge is not reading the incremental rollup';
  END IF;
  IF v_src LIKE '%FROM public.rake_attributions%' THEN
    RAISE EXCEPTION 'the live edge still scans the attributions directly';
  END IF;
  IF v_src NOT LIKE '%NOT EXISTS (SELECT 1 FROM ok_days o%' THEN
    RAISE EXCEPTION 'the live edge no longer excludes the sealed days';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'rake_attributions'
                    AND t.tgname = 'trg_ca_club_rake_daily_user_ins') THEN
    RAISE EXCEPTION 'nothing keeps the rollup current';
  END IF;

  -- The rollup must equal the attributions for a day both can answer for.
  SELECT du.club_id, du.day INTO v_club, v_day
    FROM public.ca_club_rake_daily_user du
   GROUP BY du.club_id, du.day
   ORDER BY sum(du.hands) DESC LIMIT 1;

  IF v_club IS NOT NULL THEN
    SELECT SUM(du.rake_cents)::numeric / 100 INTO v_a
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = v_club AND du.day = v_day;

    SELECT COALESCE(SUM(round(ra.rake_amount * 100)), 0)::numeric / 100 INTO v_b
      FROM public.rake_attributions ra
     WHERE ra.club_id = v_club
       AND ra.player_id IS NOT NULL
       AND ra.rake_amount > 0
       AND ra.created_at >= v_day::timestamptz
       AND ra.created_at <  (v_day + 1)::timestamptz;

    IF COALESCE(v_a,0) <> COALESCE(v_b,0) THEN
      RAISE EXCEPTION 'the rollup for % on % totals % where the attributions total %',
        v_club, v_day, v_a, v_b;
    END IF;
    RAISE NOTICE 'rollup agrees with the attributions for % on %: % chips', v_club, v_day, v_a;
  END IF;
END $$;

COMMIT;
