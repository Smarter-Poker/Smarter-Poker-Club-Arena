-- ═══════════════════════════════════════════════════════════════════════════════
--  TOURNAMENT RAKE — ATTRIBUTION + CREATION-SIDE CAPS (2026-08-27, pass 2)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Second line-by-line pass over every place tournament rake is touched,
-- covering what the 2026-08-26 settlement-integrity migration did not. Four
-- defects, all verified against production:
--
--  1. TOURNAMENT FEES EARNED NOBODY ANYTHING. Three consumers attribute rake
--     to players, and every one of them was starved for tournament fees:
--       - trg_award_vip_points_from_rake ("1 pt per rake chip") reads
--         player_contributions — NULL on every tournament fee row;
--       - RakebackSettlerService (agent commissions + player_stats) filters
--         `player_contributions IS NOT NULL` — its own 2026-07-24 comment
--         says tournament/SNG fee rows are MEANT to credit agent commissions,
--         but the filter starves the very rows that fix targeted;
--       - player_stats.total_rake therefore never saw a tournament fee.
--     FIX: attribution happens at SETTLEMENT, inside fn_settle_tournament_rake
--     — fees are final there (unregister/cancel reversals already netted), the
--     settlement claim makes it exactly-once, and register/unregister cycles
--     can no longer farm points or commissions the way till-time attribution
--     would have allowed. Per-user net comes from rake_records metadata
--     user_id; user-less rows (Spin house rake) split equally across the
--     seats, mirroring fn_union_tournament_rake_by_user. Horses are excluded.
--     Applied going FORWARD; historical events are deliberately not
--     retro-credited (that is a policy decision, recorded in the audit doc).
--
--  2. fn_create_tournament BREACHED THE CAP AND BROKE x5 PRICES. Its fee was
--     `round(total * 0.1)` — round, not floor — so any owner-created event
--     priced 15/25/35/... computed a fee OVER the 10% cap and DIED on the
--     tournaments_rake_within_10_pct CHECK constraint with a raw SQL error.
--     116 over-cap rows in 14 days came from adjacent paths; owner creation
--     at those exact prices simply failed. It also charged SNGs 10% when Dan
--     set Heads-Up at 5% (2026-08-25: "HEADS UP EVENTS ARE ONLY A 5% RAKE").
--     FIX: cents floor, 5% for sng, 10% otherwise.
--
--  3. fn_collect_bounty PAID A HEAD FOR A PLAYER ROW THAT MAY NOT EXIST — a
--     missing eliminated-player row fell through to the tournament's default
--     bounty_amount instead of refusing.
--
--  4. fn_spin_sweep_unbooked CARRIED ITS OWN COPY OF THE SPIN RAKE BANDS —
--     the exact three-tables-that-disagree failure spinSpec.ts exists to
--     prevent. The bands now live in ONE SQL function, fn_spin_rake_rate.
--
-- Also checked and found sound in this pass: fn_union_weekly_rakeback_close
-- (keys on structured columns, unaffected by the new settlement note format;
-- solvent), tournament tickets (conserving escrow, idempotent),
-- fn_mystery_bounty_settle (conserving, idempotent),
-- fn_tournament_payout_reconcile (idempotent keys, no clawback, alert dedupe),
-- fn_upsert_tournament_schedule (fee derived downstream via buyInFor).
-- Known-dormant: pages/api/club-arena/horse-launch.js (WH) authors fee-on-top
-- splits but has never created a row — documented, not deployed against.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ONE SQL HOME FOR THE SPIN RAKE BANDS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_spin_rake_rate(p_buy_in numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  -- Mirror of SPIN_RAKE_BANDS in spinSpec.ts (client + server). An unknown
  -- stake defaults to the HIGHEST rake, never the lowest.
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
      -- 2026-08-27: fn_spin_rake_rate replaces a third, hand-inlined copy of
      -- the rake band table that this sweep used to carry.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. SETTLEMENT-TIME ATTRIBUTION — fees finally earn VIP points, agent
--    commissions and player rake stats, exactly once, net of reversals
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- THE CLAIM (see 20260826_tournament_rake_settlement_integrity).
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

  -- CLUB ACCUMULATOR PARITY (2026-08-27): the cash path bumps the club's
  -- period/lifetime rake counters in club_wallets; tournament rake never did,
  -- so club dashboards under-reported it. Counters only — no chip_balance
  -- movement here; the money itself landed above.
  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  -- ── ATTRIBUTION (2026-08-27) ────────────────────────────────────────────
  -- Per-payer net fee: rows carrying metadata user_id are direct; user-less
  -- rows (Spin house rake) split equally across the entrants — the same rule
  -- fn_union_tournament_rake_by_user already applies. Horses are excluded.
  -- Best-effort by design: a failure here must not roll back the wallet
  -- credit above, so it alerts instead of aborting. Every write inside is
  -- idempotent (ledger/commission/stats all carry conflict keys), and the
  -- settlement claim means this block runs at most once per tournament.
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

      -- VIP: 1 point per whole chip of rake generated — the same rule the
      -- cash trigger applies, keyed per (user, tournament) so it can never
      -- double-award.
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

      -- Agent commission on the player's tournament rake — the wiring the
      -- RakebackSettler's 2026-07-24 fix intended but never received (its
      -- feed filters on player_contributions, which fee rows do not carry).
      -- source_id is deterministic per (tournament, user), so the RPC's own
      -- (user_id, source_id, source_type) dedupe makes retries free.
      PERFORM public.credit_agent_commission_from_rake(
        v_att.uid, v_t.club_id, v_att.amt,
        'tournament_rake_settlement',
        md5('trs:' || p_tournament_id::text || ':' || v_att.uid::text)::uuid,
        'tournament rake settlement');

      -- Player rake stats. hands = 0: a fee is not a hand. Claimed through
      -- rakeback_stats_applied on (fee row id, user), so exactly-once.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. fn_create_tournament — cents floor, 5% for SNG, no more x5-price failures
-- ─────────────────────────────────────────────────────────────────────────────
-- Only the fee derivation changes; the rest of the body is the audited
-- original. The two lines were:
--   v_fee    := LEAST(v_total, GREATEST(0, round(v_total * 0.1)));
--   v_buy_in := v_total - v_fee;
-- round() breached the cap on any total with a 5 in the ones place, which the
-- tournaments_rake_within_10_pct CHECK then turned into a raw SQL error at
-- creation. And 'sng' paid 10% against Dan's 5% Heads-Up rule.

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. fn_collect_bounty — no head for a player row that does not exist
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ASSERTIONS
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ROLLBACK: re-apply the 20260826 fn_settle_tournament_rake body (attribution
-- block removed); restore fn_create_tournament / fn_collect_bounty /
-- fn_spin_sweep_unbooked from their previous definitions; DROP FUNCTION
-- public.fn_spin_rake_rate(numeric).
