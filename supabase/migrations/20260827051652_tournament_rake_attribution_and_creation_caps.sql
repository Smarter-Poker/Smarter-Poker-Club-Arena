-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827051652; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TOURNAMENT RAKE — ATTRIBUTION + CREATION-SIDE CAPS (2026-08-27, pass 2)
-- Full rationale in repo: supabase/migrations/20260827_tournament_rake_attribution_and_creation_caps.sql

CREATE OR REPLACE FUNCTION public.fn_spin_rake_rate(p_buy_in numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN COALESCE(p_buy_in, 0) <= 5  THEN 0.08
              WHEN p_buy_in <= 10 THEN 0.07
              WHEN p_buy_in <= 50 THEN 0.06
              ELSE 0.05 END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t record; v_n integer := 0; v_fail integer := 0; v_res jsonb; v_repair jsonb;
BEGIN
  BEGIN
    v_repair := public.fn_spin_repair_missing_multiplier(p_lookback_mins);
  EXCEPTION WHEN OTHERS THEN
    v_repair := jsonb_build_object('ok', false, 'reason', SQLERRM);
  END;

  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.current_players, t.spin_multiplier
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      AND COALESCE(t.current_players, 0) > 0
      AND t.started_at > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
  LOOP
    BEGIN
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, v_t.current_players, v_t.spin_multiplier,
        public.fn_spin_rake_rate(v_t.buy_in_amount));
      IF COALESCE((v_res->>'ok')::boolean, false) THEN v_n := v_n + 1;
      ELSE v_fail := v_fail + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'lookback_mins', p_lookback_mins,
                            'multiplier_repair', v_repair);
END; $function$;

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
  v_claimed integer; v_prior record;
  v_att record; v_pts bigint; v_att_users integer := 0;
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
         AND NOT COALESCE((SELECT p.is_horse FROM public.profiles p WHERE p.id = x.uid), false)
       GROUP BY x.uid
      HAVING round(sum(x.amt), 2) > 0
    LOOP
      v_att_users := v_att_users + 1;

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
        v_att.uid, v_t.club_id, v_att.amt,
        'tournament_rake_settlement',
        md5('trs:' || p_tournament_id::text || ':' || v_att.uid::text)::uuid,
        'tournament rake settlement');

      PERFORM public.apply_rakeback_player_stats(
        v_att.row_id, v_att.uid, v_t.club_id, 0, v_att.amt);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_settle_tournament_rake',
            'Rake settled but attribution failed: ' || SQLERRM,
            jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net));
  END;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now()
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed_users', v_att_users);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_create_tournament';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_create_tournament missing';
  END IF;
  IF position('v_fee    := LEAST(v_total, GREATEST(0, round(v_total * 0.1)));' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_create_tournament fee line not found — body drifted, refusing to patch blind';
  END IF;
  v_new := replace(v_src,
    'v_fee    := LEAST(v_total, GREATEST(0, round(v_total * 0.1)));',
    'v_fee    := LEAST(v_total, GREATEST(0, '
      || 'trunc(v_total * (CASE WHEN COALESCE(p_config->>''type'', ''mtt'') = ''sng'' '
      || 'THEN 0.05 ELSE 0.1 END) * 100 + 0.000001) / 100));');
  EXECUTE v_new;
END $do$;

DO $do$
DECLARE v_src text; v_new text; v_anchor text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_collect_bounty';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_collect_bounty missing'; END IF;
  v_anchor := 'FOR UPDATE;' || E'\n\n' || '  v_mode :=';
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_collect_bounty anchor not found — body drifted, refusing to patch blind';
  END IF;
  v_new := replace(v_src, v_anchor,
    'FOR UPDATE;' || E'\n'
    || '  -- 2026-08-27: a knockout of a player with NO row must refuse, not fall' || E'\n'
    || '  -- through to the tournament''s default head and pay a bounty for a ghost.' || E'\n'
    || '  IF NOT FOUND THEN' || E'\n'
    || '    RETURN jsonb_build_object(''ok'', false, ''reason'', ''eliminated_player_not_in_tournament'');' || E'\n'
    || '  END IF;' || E'\n\n'
    || '  v_mode :=');
  EXECUTE v_new;
END $do$;

DO $$
BEGIN
  IF to_regprocedure('public.fn_spin_rake_rate(numeric)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_spin_rake_rate missing';
  END IF;
  IF public.fn_spin_rake_rate(5) <> 0.08 OR public.fn_spin_rake_rate(5.01) <> 0.07
     OR public.fn_spin_rake_rate(50) <> 0.06 OR public.fn_spin_rake_rate(51) <> 0.05 THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_spin_rake_rate bands wrong';
  END IF;
  IF pg_get_functiondef('public.fn_settle_tournament_rake(uuid, text)'::regprocedure)
       NOT LIKE '%credit_agent_commission_from_rake%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: settlement attribution missing';
  END IF;
  IF pg_get_functiondef('public.fn_create_tournament(uuid, jsonb)'::regprocedure)
       LIKE '%round(v_total * 0.1)%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_create_tournament still rounds the fee';
  END IF;
  IF pg_get_functiondef('public.fn_collect_bounty(uuid, uuid, uuid)'::regprocedure)
       NOT LIKE '%eliminated_player_not_in_tournament%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_collect_bounty ghost guard missing';
  END IF;
  IF pg_get_functiondef('public.fn_spin_sweep_unbooked(integer)'::regprocedure)
       NOT LIKE '%fn_spin_rake_rate%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: spin sweep still carries its own band table';
  END IF;
END $$;
