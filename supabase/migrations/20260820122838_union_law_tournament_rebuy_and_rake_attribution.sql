-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820122838 "union_law_tournament_rebuy_and_rake_attribution"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cdf6776015246bc7065327586eaaef42 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — TOURNAMENT REBUY/RE-ENTRY/ADD-ON + ENTRY-FEE ATTRIBUTION
-- (2026-08-20, pass 3)
--
-- Completes club scoping for tournaments: chip purchases inside a tournament
-- draw on the club that paid the entry, and entry-fee rake is attributed to
-- that club instead of falling back to first-joined membership.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_p record; v_balance numeric; v_ratio numeric;
  v_base numeric; v_fee numeric; v_total numeric;
  v_add integer; v_new_chips integer; v_seat record;
  v_key text; v_inserted integer; v_cap integer; v_level integer; v_cat text;
  v_club uuid;
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
         max_reentries, addon_cost, addon_chips, addon_levels, current_level, prize_pool
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)', v_t.status;
  END IF;

  SELECT id, chips, status, rebuys, add_on, table_id, club_id INTO v_p
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not registered in this tournament'; END IF;
  v_club := v_p.club_id;

  v_level := COALESCE(v_t.current_level, COALESCE(p_current_level, 0));
  v_cat   := CASE WHEN p_rebuy_type = 'addon' THEN 'addon' ELSE 'rebuy' END;

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
    IF v_cap > 0 AND v_level > v_cap THEN
      RAISE EXCEPTION 'Add-on period has closed (level % > %)', v_level, v_cap; END IF;
    v_base := COALESCE(NULLIF(v_t.addon_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.addon_chips,0), v_t.starting_chips, 0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament'; END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament'; END IF;
    v_cap := COALESCE(NULLIF(v_t.rebuy_levels,0), NULLIF(v_t.late_reg_levels,0), 0);
    IF v_cap > 0 AND v_level > v_cap THEN
      RAISE EXCEPTION 'Rebuy period has closed (level % > %)', v_level, v_cap; END IF;
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

  v_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) > 0 AND COALESCE(v_t.buy_in_fee,0) > 0
                  THEN v_t.buy_in_fee / v_t.buy_in_amount ELSE 0.1 END;
  v_base := round(v_base::numeric,2); v_fee := round(v_base*v_ratio,2); v_total := v_base+v_fee;
  IF p_cost IS NOT NULL AND abs(p_cost - v_total) > 0.01 THEN
    RAISE EXCEPTION 'Price mismatch: client quoted %, server computed % (base % + fee %)',
      p_cost, v_total, v_base, v_fee;
  END IF;

  -- UNION LAW: buy chips from the club that paid for this entry.
  IF v_club IS NOT NULL THEN
    SELECT chip_balance INTO v_balance FROM club_members
     WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
    IF v_balance IS NULL OR v_balance < v_total THEN
      RAISE EXCEPTION 'Insufficient club chips: need % (incl. % fee), have %',
        v_total, v_fee, COALESCE(v_balance,0);
    END IF;
    UPDATE club_members SET chip_balance = chip_balance - v_total, updated_at = now()
     WHERE user_id = p_user_id AND club_id = v_club;
  ELSE
    SELECT balance INTO v_balance FROM wallets
     WHERE user_id=p_user_id AND wallet_type='PLAYER' FOR UPDATE;
    IF v_balance IS NULL OR v_balance < v_total THEN
      RAISE EXCEPTION 'Insufficient chips: need % (incl. % fee), have %',
        v_total, v_fee, COALESCE(v_balance,0);
    END IF;
    UPDATE wallets SET balance = balance - v_total, updated_at = now()
     WHERE user_id=p_user_id AND wallet_type='PLAYER';
  END IF;

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

  SELECT s.id, s.stack INTO v_seat FROM table_seats s JOIN tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id LIMIT 1;
  IF FOUND THEN
    UPDATE table_seats
       SET stack = CASE WHEN p_rebuy_type='reentry' THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id;
    UPDATE tournament_players
       SET chips=(SELECT stack FROM table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
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
      ||' ('||v_base||' + '||v_fee||' fee)'
      ||CASE WHEN v_club IS NOT NULL THEN ' [club chips]' ELSE '' END,
    p_tournament_id, v_balance-v_total);

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips,
    'rebuy_type', p_rebuy_type, 'chips_added', v_add, 'cost', v_total, 'fee', v_fee);
END;
$function$;

-- Entry fees attribute to the club that paid the entry ----------------------
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_by_club(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(club_id uuid, rake_share numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH legacy AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  ut AS (SELECT id FROM tables WHERE union_id = p_union_id AND tournament_id IS NULL),
  cash AS (
    SELECT
      COALESCE(
        (SELECT ts.club_id
           FROM table_seats ts
          WHERE ts.table_id = r.table_id
            AND ts.user_id = (e.key)::uuid
            AND ts.club_id IS NOT NULL
            AND ts.joined_at <= r.created_at
            AND (ts.left_at IS NULL OR ts.left_at >= r.created_at)
          ORDER BY ts.joined_at DESC
          LIMIT 1),
        l.club_id
      ) AS club_id,
      SUM(r.rake_amount * (e.value::numeric) / c.total) AS rake
      FROM rake_records r
      JOIN ut ON ut.id = r.table_id
      CROSS JOIN LATERAL (
        SELECT SUM(t.value::numeric) AS total
          FROM jsonb_each_text(r.player_contributions) AS t(key, value)
      ) c
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) AS e(key, value)
      LEFT JOIN legacy l ON l.user_id = (e.key)::uuid
     WHERE r.created_at >= p_start AND r.created_at < p_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
       AND c.total > 0
     GROUP BY 1
  ),
  tourney AS (
    -- UNION LAW: the club that paid the entry owns the entry fee.
    SELECT COALESCE(tp.club_id, l.club_id) AS club_id,
           SUM(COALESCE(t.buy_in_fee, 0)) AS rake
      FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id AND t.union_id = p_union_id
      LEFT JOIN legacy l ON l.user_id = tp.user_id
     WHERE tp.registered_at >= p_start AND tp.registered_at < p_end
     GROUP BY 1
  )
  SELECT club_id, round(SUM(rake), 2) AS rake_share
    FROM (SELECT club_id, rake FROM cash
          UNION ALL
          SELECT club_id, rake FROM tourney) x
   WHERE club_id IS NOT NULL
   GROUP BY club_id;
$function$;

