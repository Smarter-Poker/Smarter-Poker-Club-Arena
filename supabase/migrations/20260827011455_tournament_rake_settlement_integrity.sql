-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827011455; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════════
--  TOURNAMENT RAKE SETTLEMENT INTEGRITY (2026-08-26)
--  Full header/rationale in repo: supabase/migrations/20260826_tournament_rake_settlement_integrity.sql
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tournament_rake_settlements (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  club_id       uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  union_id      uuid,
  amount        numeric(15,2) NOT NULL DEFAULT 0,
  destination   text NOT NULL DEFAULT 'pending',
  source        text NOT NULL DEFAULT 'engine',
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);

COMMENT ON TABLE public.tournament_rake_settlements IS
  'One row per terminal tournament: proof its fee-ledger net was credited to a wallet (or was zero). The PK is the idempotency claim for fn_settle_tournament_rake.';

ALTER TABLE public.tournament_rake_settlements ENABLE ROW LEVEL SECURITY;

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

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now()
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_sweep_unsettled_tournament_rake(
  p_since_days integer DEFAULT 45,
  p_limit integer DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record; v_res jsonb;
  v_settled integer := 0; v_chips numeric := 0; v_scanned integer := 0; v_failed integer := 0;
BEGIN
  FOR v_row IN
    SELECT t.id
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND t.ended_at IS NOT NULL
       AND t.ended_at > now() - make_interval(days => GREATEST(p_since_days, 1))
       AND t.ended_at < now() - interval '10 minutes'
       AND EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.tournament_id = t.id AND r.is_tournament)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements s
                        WHERE s.tournament_id = t.id)
     ORDER BY t.ended_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      v_res := public.fn_settle_tournament_rake(v_row.id, 'sweep');
      IF COALESCE((v_res->>'ok')::boolean, false)
         AND NOT COALESCE((v_res->>'already_settled')::boolean, false) THEN
        v_settled := v_settled + 1;
        v_chips := v_chips + COALESCE((v_res->>'amount')::numeric, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_sweep_unsettled_tournament_rake',
              'Sweep could not settle tournament rake: ' || SQLERRM,
              jsonb_build_object('tournament_id', v_row.id));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned,
    'settled', v_settled, 'chips', round(v_chips, 2), 'failed', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_sweep_unsettled_tournament_rake(integer, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record; v_p record; v_balance numeric; v_ratio numeric;
  v_is_bounty boolean; v_bounty_head numeric;
  v_base numeric; v_fee numeric; v_total numeric;
  v_add integer; v_new_chips integer; v_seat record;
  v_key text; v_inserted integer; v_cap integer; v_level integer; v_cat text;
  v_club uuid; v_legacy_ratio numeric; v_legacy_total numeric;
  v_stack_after numeric; v_expected numeric; v_fee_ratio numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE = '42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %', p_rebuy_type;
  END IF;

  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee, starting_chips,
         is_rebuy, is_reentry, add_on_available, addon_period_triggered,
         rebuy_cost, rebuy_chips, rebuy_levels, late_reg_levels, max_rebuys,
         max_reentries, addon_cost, addon_chips, addon_levels, current_level, prize_pool,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)', v_t.status;
  END IF;

  SELECT id, chips, status, rebuys, add_on, table_id, club_id INTO v_p
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not registered in this tournament'; END IF;
  v_club := COALESCE(v_p.club_id, public.fn_player_home_club(p_user_id, NULL));
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this tournament purchase';
  END IF;

  v_level := COALESCE(v_t.current_level, COALESCE(p_current_level, 0));
  v_cat   := CASE WHEN p_rebuy_type = 'addon' THEN 'addon' ELSE 'rebuy' END;

  IF p_rebuy_type <> 'reentry' THEN
    PERFORM 1 FROM table_seats s
      JOIN tables tb ON tb.id = s.table_id
     WHERE s.user_id = p_user_id AND s.left_at IS NULL
       AND tb.tournament_id = p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No live seat for this % — refusing to charge for chips that would be overwritten by the seat sync', p_rebuy_type;
    END IF;
  END IF;

  IF p_rebuy_type = 'addon' THEN
    v_key := 'tourney:' || p_tournament_id || ':addon:' || p_user_id;
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (v_key, p_user_id, COALESCE(p_cost, 0)) ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true,
                                'new_stack', v_p.chips, 'rebuy_type', p_rebuy_type);
    END IF;
  ELSIF EXISTS (
      SELECT 1 FROM wallet_transactions w
       WHERE w.user_id = p_user_id AND w.related_entity_id = p_tournament_id
         AND w.category = v_cat AND w.created_at > now() - interval '30 seconds') THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
                              'new_stack', v_p.chips, 'rebuy_type', p_rebuy_type);
  END IF;

  IF p_rebuy_type = 'addon' THEN
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament'; END IF;
    IF COALESCE(v_p.add_on,false) THEN RAISE EXCEPTION 'Add-on already taken'; END IF;
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels,0), NULLIF(v_t.rebuy_levels,0), 0)
             + COALESCE(v_t.addon_levels,1);
    IF v_cap > 0 AND v_level >= v_cap THEN
      RAISE EXCEPTION 'Add-on period has closed (level % of %)', v_level, v_cap; END IF;
    v_base := COALESCE(NULLIF(v_t.addon_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.addon_chips,0), v_t.starting_chips, 0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament'; END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament'; END IF;
    v_cap := COALESCE(NULLIF(v_t.rebuy_levels,0), NULLIF(v_t.late_reg_levels,0), 0);
    IF v_cap > 0 AND COALESCE(v_t.add_on_available,false) THEN
      v_cap := v_cap + COALESCE(NULLIF(v_t.addon_levels,0),1); END IF;
    IF v_cap > 0 AND v_level >= v_cap THEN
      RAISE EXCEPTION 'Rebuy period has closed (level % of %)', v_level, v_cap; END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0) >= v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)', v_p.rebuys, v_t.max_rebuys; END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0) >= v_t.max_reentries THEN
      RAISE EXCEPTION 'Re-entry limit reached (% of %)', v_p.rebuys, v_t.max_reentries; END IF;
    IF p_rebuy_type='rebuy' AND COALESCE(v_p.chips,0) > COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy'; END IF;
    v_base := COALESCE(NULLIF(v_t.rebuy_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.rebuy_chips,0), v_t.starting_chips, 0)::integer;
  END IF;

  -- CAP FIX 2026-08-26: fee floors to CENTS at ratio fee/(prize+fee), hard
  -- 10% ceiling, no minimum-1-chip floor and no round-up. (The old line
  -- overcharged 879 rebuy fees by 729.20 chips in 30 days.)
  v_legacy_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) > 0 AND COALESCE(v_t.buy_in_fee,0) > 0
                         THEN v_t.buy_in_fee / v_t.buy_in_amount ELSE 0.1 END;
  v_fee_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) + COALESCE(v_t.buy_in_fee,0) > 0
                           AND COALESCE(v_t.buy_in_fee,0) > 0
                      THEN v_t.buy_in_fee / (v_t.buy_in_amount + v_t.buy_in_fee)
                      ELSE 0.1 END;
  v_ratio := CASE WHEN p_rebuy_type = 'addon' THEN 0 ELSE v_fee_ratio END;

  v_total := round(v_base::numeric);
  v_fee := CASE WHEN v_ratio > 0 AND v_total > 0
                THEN LEAST(trunc(v_total * v_ratio * 100 + 0.000001) / 100,
                           trunc(v_total * 0.1 * 100 + 0.000001) / 100)
                ELSE 0 END;
  v_base := round(v_total - v_fee, 2);
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
                 OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type <> 'addon' THEN
    v_bounty_head := LEAST(GREATEST(0, round(COALESCE(v_t.bounty_amount,0))), v_base);
    v_base := v_base - v_bounty_head;
  ELSE
    v_bounty_head := 0;
  END IF;

  IF p_cost IS NOT NULL AND abs(p_cost - v_total) > 0.01 THEN
    v_legacy_total := v_total + round(v_total * v_legacy_ratio, 2);
    IF abs(p_cost - v_legacy_total) > 0.01 THEN
      RAISE EXCEPTION 'Price mismatch: client quoted %, server computed % (base % + fee %)',
        p_cost, v_total, v_base, v_fee;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
  SELECT chip_balance INTO v_balance FROM club_members
   WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need % (incl. % fee), have %',
      v_total, v_fee, COALESCE(v_balance,0);
  END IF;
  UPDATE club_members SET chip_balance = chip_balance - v_total, updated_at = now()
   WHERE user_id = p_user_id AND club_id = v_club;

  IF p_rebuy_type='reentry' THEN
    UPDATE tournament_players SET chips=v_add, status='playing', eliminated_at=NULL,
           position=NULL, rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE tournament_players SET chips=COALESCE(chips,0)+v_add, add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE tournament_players SET chips=COALESCE(chips,0)+v_add, status='playing',
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  END IF;

  IF v_bounty_head > 0 THEN
    UPDATE tournament_players
       SET current_bounty = CASE WHEN p_rebuy_type = 'reentry' THEN v_bounty_head
                                 ELSE COALESCE(current_bounty, 0) + v_bounty_head END
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
  END IF;

  SELECT s.id, s.stack INTO v_seat
    FROM table_seats s JOIN tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC, s.joined_at DESC NULLS LAST, s.id DESC
   LIMIT 1;
  IF FOUND THEN
    UPDATE table_seats
       SET stack = CASE WHEN p_rebuy_type='reentry' THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
    RETURNING stack INTO v_stack_after;

    v_expected := CASE WHEN p_rebuy_type='reentry' THEN v_add
                       ELSE COALESCE(v_seat.stack,0) + v_add END;
    IF v_stack_after IS NULL OR v_stack_after <> v_expected THEN
      RAISE EXCEPTION
        'Chip grant did not land: % expected stack % (% + %), seat % holds % — aborting so no charge is made',
        p_rebuy_type, v_expected, COALESCE(v_seat.stack,0), v_add, v_seat.id, v_stack_after;
    END IF;

    UPDATE tournament_players
       SET chips=(SELECT stack FROM table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type <> 'reentry' THEN
    RAISE EXCEPTION 'Seat disappeared during % — aborting so no charge is made', p_rebuy_type;
  END IF;

  UPDATE tournaments SET prize_pool=COALESCE(prize_pool,0)+v_base WHERE id=p_tournament_id;

  IF v_fee > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
      bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,'process_tournament_rebuy',
      jsonb_build_object('kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
                         'entry_club_id', v_club));
    UPDATE tournaments SET total_rake=COALESCE(total_rake,0)+v_fee WHERE id=p_tournament_id;
  END IF;

  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description,
    related_entity_id, balance_after)
  VALUES (p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')
      ||' ('||v_base||' + '||v_fee||' fee) [club wallet]',
    p_tournament_id, v_balance-v_total);

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips,
    'rebuy_type', p_rebuy_type, 'chips_added', v_add, 'cost', v_total, 'fee', v_fee);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_t       record;
  v_reg_id  uuid;
  v_amount  numeric;
  v_split   record;
  v_is_bounty boolean;
  v_ms      numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, bounty_amount,
         is_bounty, is_pko, is_mystery_bounty,
         start_time, current_players, club_id, name
    INTO v_t
  FROM public.tournaments
  WHERE id = p_tournament_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  IF v_t.start_time IS NOT NULL THEN
    v_ms := EXTRACT(EPOCH FROM (v_t.start_time - now())) * 1000;
    IF v_ms <= 60000 AND v_ms > -300000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_close_to_start');
    END IF;
  END IF;

  DELETE FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = v_uid
     AND status = 'registered'
  RETURNING id INTO v_reg_id;

  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_registered_or_seated');
  END IF;

  -- POOL SYMMETRY 2026-08-26: reverse the exact fn_tournament_entry_split
  -- components registration added (prize/bounty/rake), not the raw buy_in.
  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  v_amount := v_split.charge;

  IF v_amount > 0 THEN
    PERFORM public.credit_player_wallet(v_uid, v_amount, 'tourn_unreg:' || v_reg_id::text);
  END IF;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES
      (NULL, NULL, v_t.club_id, -v_split.rake, v_split.rake, 1,
       0, true, p_tournament_id, 'fn_unregister_from_tournament',
       jsonb_build_object('kind', 'tournament_fee_refund', 'user_id', v_uid,
                          'registration_id', v_reg_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 1) - 1, 0),
         prize_pool  = GREATEST(COALESCE(prize_pool, 0)  - v_split.prize, 0),
         bounty_pool = GREATEST(COALESCE(bounty_pool, 0) - v_split.bounty, 0),
         total_rake  = GREATEST(COALESCE(total_rake, 0)  - v_split.rake, 0)
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'refunded', v_amount, 'registration_id', v_reg_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_t RECORD; v_player RECORD;
    v_paid NUMERIC; v_fee_net NUMERIC; v_ok boolean;
    v_refunded_count INT := 0; v_total_refunded NUMERIC := 0; v_fees_reversed NUMERIC := 0;
BEGIN
    SELECT * INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;

    IF v_uid IS NOT NULL AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
        RAISE EXCEPTION 'Only a club admin may cancel a tournament' USING ERRCODE = '42501';
    END IF;

    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
        RAISE EXCEPTION 'Tournament is already %', v_t.status;
    END IF;

    UPDATE tournaments
       SET status='CANCELLED', ended_at=NOW(), updated_at=NOW(),
           prize_pool=0, bounty_pool=0
     WHERE id=p_tournament_id;

    FOR v_player IN (
      SELECT tp.id, tp.user_id FROM tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    )
    LOOP
        SELECT round(COALESCE(sum(
                 CASE WHEN w.type='debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      WHEN w.type='credit' AND w.category='refund' THEN -w.amount
                      ELSE 0 END), 0), 2)
          INTO v_paid
          FROM wallet_transactions w
         WHERE w.user_id = v_player.user_id AND w.related_entity_id = p_tournament_id;

        IF v_paid > 0 THEN
            v_ok := public.fn_credit_and_log(
              v_player.user_id, v_paid,
              'tourney:' || p_tournament_id || ':cancelrefund:' || v_player.id,
              'refund',
              'Tournament cancellation refund: ' || COALESCE(v_t.name,'Unknown'),
              p_tournament_id);
            IF COALESCE(v_ok, false) THEN
                v_refunded_count := v_refunded_count + 1;
                v_total_refunded := v_total_refunded + v_paid;
            END IF;
        END IF;

        IF v_t.club_id IS NOT NULL THEN
            SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_fee_net
              FROM rake_records r
             WHERE r.tournament_id = p_tournament_id AND r.is_tournament
               AND r.metadata->>'user_id' = v_player.user_id::text;
            IF v_fee_net > 0 THEN
                INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size,
                  num_players, bbj_contribution, is_tournament, tournament_id, source, metadata)
                VALUES (NULL, NULL, v_t.club_id, -v_fee_net, v_fee_net, 1, 0, true,
                  p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind','tournament_fee_refund','user_id',v_player.user_id));
                v_fees_reversed := v_fees_reversed + v_fee_net;
            END IF;
        END IF;
    END LOOP;

    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake,0) - v_fees_reversed)
         WHERE id = p_tournament_id;
    END IF;

    UPDATE tournament_players SET status='eliminated', eliminated_at=NOW()
     WHERE tournament_id = p_tournament_id AND status IN ('registered','playing');
    UPDATE tables SET status='closed', current_players=0 WHERE tournament_id = p_tournament_id;

    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;

GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.atomic_tournament_register(uuid, uuid, text, numeric, numeric, numeric, boolean, uuid) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.record_tournament_buyin_rake(uuid, numeric, uuid);

DO $$
DECLARE pass integer; v_inserted integer; v_total integer := 0;
BEGIN
  FOR pass IN 1..3 LOOP
    WITH terminal AS (
      SELECT t.id, t.club_id, c.union_id, t.ended_at,
             (SELECT round(COALESCE(sum(r.rake_amount),0),2) FROM rake_records r
               WHERE r.tournament_id = t.id AND r.is_tournament) AS net
        FROM tournaments t JOIN clubs c ON c.id = t.club_id
       WHERE upper(COALESCE(t.status,'')) = 'COMPLETED'
         AND t.ended_at > now() - interval '60 days'
         AND NOT EXISTS (SELECT 1 FROM tournament_rake_settlements s WHERE s.tournament_id = t.id)
    ),
    credits AS (
      SELECT u.id, u.union_id, u.club_id, u.amount, u.created_at
        FROM union_wallet_transactions u
       WHERE u.tx_type = 'rake' AND u.direction = 'credit'
         AND u.notes LIKE 'Tournament rake:%'
         AND u.created_at > now() - interval '61 days'
         AND NOT EXISTS (SELECT 1 FROM tournament_rake_settlements s
                          WHERE s.destination = 'utx:' || u.id)
    ),
    pairs AS (
      SELECT t.id AS tid, t.club_id, u.union_id, u.id AS uid, t.net,
             row_number() OVER (PARTITION BY t.id
               ORDER BY abs(extract(epoch FROM (u.created_at - t.ended_at)))) AS rt,
             row_number() OVER (PARTITION BY u.id
               ORDER BY abs(extract(epoch FROM (u.created_at - t.ended_at)))) AS ru
        FROM terminal t
        JOIN credits u
          ON u.club_id = t.club_id
         AND u.amount = t.net
         AND u.created_at BETWEEN t.ended_at - interval '10 minutes'
                              AND t.ended_at + interval '2 hours'
       WHERE t.net > 0
    )
    INSERT INTO tournament_rake_settlements
      (tournament_id, club_id, union_id, amount, destination, source, settled_at)
    SELECT tid, club_id, union_id, net, 'utx:' || uid, 'backfill_matched', now()
      FROM pairs WHERE rt = 1 AND ru = 1
    ON CONFLICT (tournament_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_total := v_total + v_inserted;
    EXIT WHEN v_inserted = 0;
  END LOOP;
  RAISE NOTICE 'tournament rake settlement backfill matched % tournaments', v_total;
END $$;

DO $$
BEGIN
  IF to_regclass('public.tournament_rake_settlements') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: tournament_rake_settlements missing';
  END IF;
  IF to_regprocedure('public.record_tournament_buyin_rake(uuid, numeric, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: record_tournament_buyin_rake still exists';
  END IF;
  IF has_function_privilege('authenticated',
       'public.atomic_tournament_register(uuid, uuid, text, numeric, numeric, numeric, boolean, uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAILED: atomic_tournament_register still executable by authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.atomic_cancel_tournament(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAILED: atomic_cancel_tournament not executable by authenticated';
  END IF;
  IF pg_get_functiondef('public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer)'::regprocedure)
       LIKE '%GREATEST(1, round(v_total%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: rebuy minimum-fee bug still present';
  END IF;
  IF pg_get_functiondef('public.atomic_cancel_tournament(uuid, uuid)'::regprocedure)
       NOT LIKE '%is_club_admin%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: cancel authorisation check missing';
  END IF;
END $$;
