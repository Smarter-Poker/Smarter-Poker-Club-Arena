-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827163550; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- HORSES ARE PLAYERS (Dan, 2026-08-27, BINDING LAW)
-- "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING! THEY MUST ALWAYS BE
--  TREATED LIKE REAL LIVE PLAYERS!"
-- Full rationale in repo: supabase/migrations/20260827_horses_are_players_law.sql

CREATE OR REPLACE FUNCTION public.fn_attribute_tournament_rake(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club uuid; v_att record; v_pts bigint; v_users integer := 0; v_chips numeric := 0;
BEGIN
  SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_club');
  END IF;

  FOR v_att IN
    WITH per_user AS (
      SELECT (r.metadata->>'user_id')::uuid AS uid,
             sum(r.rake_amount) AS amt, min(r.id::text)::uuid AS row_id
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id AND r.is_tournament
         AND r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ),
    userless AS (
      SELECT sum(r.rake_amount) AS amt, min(r.id::text)::uuid AS row_id
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id AND r.is_tournament
         AND (r.metadata->>'user_id') IS NULL
      HAVING sum(r.rake_amount) > 0
    ),
    members AS (
      SELECT tp.user_id FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    ),
    spread AS (
      SELECT m.user_id AS uid,
             round(u.amt / NULLIF((SELECT count(*) FROM members), 0), 2) AS amt,
             u.row_id
        FROM userless u CROSS JOIN members m
    )
    SELECT x.uid, round(sum(x.amt), 2) AS amt, min(x.row_id::text)::uuid AS row_id
      FROM (SELECT * FROM per_user UNION ALL SELECT * FROM spread) x
     WHERE x.uid IS NOT NULL
     GROUP BY x.uid
    HAVING round(sum(x.amt), 2) > 0
  LOOP
    v_users := v_users + 1;
    v_chips := v_chips + v_att.amt;

    v_pts := floor(v_att.amt)::bigint;
    IF v_pts > 0 THEN
      INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id)
      VALUES (v_att.uid, v_pts, 'Tournament rake generated', 'tournament_rake', p_tournament_id)
      ON CONFLICT (user_id, source_type, source_id) DO NOTHING;
      IF FOUND THEN
        INSERT INTO public.vip_points (user_id, current_points, lifetime_points)
        VALUES (v_att.uid, v_pts, v_pts)
        ON CONFLICT (user_id) DO UPDATE SET
          current_points  = public.vip_points.current_points + v_pts,
          lifetime_points = public.vip_points.lifetime_points + v_pts,
          updated_at = now();
      END IF;
    END IF;

    PERFORM public.credit_agent_commission_from_rake(
      v_att.uid, v_club, v_att.amt,
      'tournament_rake_settlement',
      md5('trs:' || p_tournament_id::text || ':' || v_att.uid::text)::uuid,
      'tournament rake settlement');

    PERFORM public.apply_rakeback_player_stats(
      v_att.row_id, v_att.uid, v_club, 0, v_att.amt);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'attributed_users', v_users,
                            'attributed_chips', round(v_chips, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb;
BEGIN
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_terminal', 'status', v_t.status);
  END IF;

  INSERT INTO public.tournament_rake_settlements (tournament_id, club_id, amount, destination, source)
  VALUES (p_tournament_id, v_t.club_id, 0, 'pending', COALESCE(p_source, 'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT amount, destination, settled_at INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at);
  END IF;

  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;

  IF v_net <= 0 OR v_t.club_id IS NULL THEN
    UPDATE public.tournament_rake_settlements
       SET amount = GREATEST(v_net, 0),
           destination = CASE WHEN v_t.club_id IS NULL THEN 'no_club' ELSE 'none' END,
           settled_at = now()
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

  IF v_union IS NOT NULL THEN
    v_res := public.increment_union_wallet(
      v_union, v_net, v_t.club_id,
      'Tournament rake: ' || COALESCE(v_t.name, 'tournament')
        || ' (' || COALESCE(v_t.current_players, 0) || ' entries)'
        || ' [tournament ' || p_tournament_id || ']');
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake: union wallet credit failed for %: %',
        p_tournament_id, v_res;
    END IF;
    v_dest := 'union:' || v_union;
  ELSE
    PERFORM public.credit_club_rake_to_treasury(v_t.club_id, v_net);
    v_dest := 'club_treasury:' || v_t.club_id;
  END IF;

  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  BEGIN
    v_att := public.fn_attribute_tournament_rake(p_tournament_id);
  EXCEPTION WHEN OTHERS THEN
    v_att := jsonb_build_object('ok', false, 'reason', SQLERRM);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_settle_tournament_rake',
            'Rake settled but attribution failed: ' || SQLERRM,
            jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net));
  END;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now()
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed_users', COALESCE(v_att->>'attributed_users', '0')::int);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE r record; v_done integer := 0; v_users integer := 0; v_res jsonb;
BEGIN
  FOR r IN
    SELECT s.tournament_id
      FROM public.tournament_rake_settlements s
     WHERE s.settled_at >= '2026-08-27T05:30:00Z'
       AND s.amount > 0
     ORDER BY s.settled_at ASC
  LOOP
    BEGIN
      v_res := public.fn_attribute_tournament_rake(r.tournament_id);
      v_done := v_done + 1;
      v_users := v_users + COALESCE((v_res->>'attributed_users')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'backfill failed for %: %', r.tournament_id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'horses-are-players backfill: % tournament(s), % attribution(s)', v_done, v_users;
END $$;

CREATE OR REPLACE FUNCTION public.fn_nit_evictions(p_table_id uuid)
 RETURNS TABLE(user_id uuid, vpip numeric, required integer, hands integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v jsonb;
BEGIN
  FOR r IN
    SELECT ts.user_id AS uid, ts.joined_at
      FROM public.table_seats ts
      JOIN public.profiles p ON p.id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
       -- HORSES ARE PLAYERS (Dan 2026-08-27). A horse-only predicate used to
       -- sit on this WHERE clause so the fleet could never be stood up by the
       -- maintain-VPIP rule. Same rules for everyone now; fn_nit_check's own
       -- sample floor spares a short sample, horses included.
  LOOP
    v := public.fn_nit_check(p_table_id, r.uid, r.joined_at);
    IF (v->>'ok')::boolean = false AND v->>'reason' = 'maintain_vpip' THEN
      user_id  := r.uid;
      vpip     := (v->>'vpip')::numeric;
      required := (v->>'required')::integer;
      hands    := (v->>'hands')::integer;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cash_tables_needing_engine(p_min integer DEFAULT 2)
 RETURNS TABLE(table_id uuid, player_count bigint, human_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ts.table_id,
         count(*) AS player_count,
         count(*) FILTER (WHERE p.is_horse IS NOT TRUE) AS human_count
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    LEFT JOIN profiles p ON p.id = ts.user_id
   WHERE ts.left_at IS NULL
     AND t.tournament_id IS NULL
     AND t.status IN ('waiting', 'running', 'active')
   GROUP BY ts.table_id
  -- HORSES ARE PLAYERS (Dan 2026-08-27). The old second clause gave a lone
  -- HUMAN an engine and denied one to a lone HORSE. Any occupied table
  -- qualifies now. p_min is kept in the signature but no longer gates.
  -- human_count stays in the result: "needs an engine" and "should be dealing"
  -- remain two different questions.
  HAVING count(*) >= 1;
$function$;

DO $$
BEGIN
  IF pg_get_functiondef('public.fn_attribute_tournament_rake(uuid)'::regprocedure) ILIKE '%is_horse%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: attribution still filters horses';
  END IF;
  IF pg_get_functiondef('public.fn_settle_tournament_rake(uuid, text)'::regprocedure) ILIKE '%is_horse%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: settler still filters horses';
  END IF;
  IF pg_get_functiondef('public.fn_nit_evictions(uuid)'::regprocedure) ILIKE '%is_horse, false) = false%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: nit evictions still exempt horses';
  END IF;
  IF pg_get_functiondef('public.cash_tables_needing_engine(integer)'::regprocedure)
       ILIKE '%NOT TRUE) >= 1%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: lone horse still denied an engine';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM table_seats ts
      JOIN tables t ON t.id = ts.table_id
      LEFT JOIN profiles p ON p.id = ts.user_id
     WHERE ts.left_at IS NULL AND t.tournament_id IS NULL
       AND t.status IN ('waiting','running','active')
     GROUP BY ts.table_id
    HAVING count(*) = 1 AND count(*) FILTER (WHERE p.is_horse IS NOT TRUE) = 0
  ) AND NOT EXISTS (
    SELECT 1 FROM public.cash_tables_needing_engine(2) e
     WHERE e.player_count = 1 AND e.human_count = 0
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: lone-horse tables exist but the function returns none';
  END IF;
END $$;
