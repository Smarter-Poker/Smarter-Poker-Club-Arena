-- 20260911145935_a_tournament_chip_grant_cannot_mint.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A TOURNAMENT CHIP GRANT CANNOT MINT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE INCIDENT. ca_drift_incidents 8b8fe26c-f2f9-458f-a275-a19508b55b58 has
-- been open since 2026-09-09 19:52 and has fired 43 times. Two RUNNING
-- tournaments hold more chips on the felt than they ever issued:
--
--   7aa16fa7 "$100 Freeroll - 12:00 PM"   expected 2,505,000  actual 2,515,000  +10,000
--   a5aa6984 "Early Bird Freeroll (NLH)"  expected   317,500  actual   320,000   +2,500
--
-- Both overages are exact multiples of the tournament's own starting stack
-- (2 x 5,000 and 1 x 2,500), which is the signature of a chip GRANT, not of
-- play: play moves chips between seats and cannot change the total.
--
-- WHERE THE CHIPS WERE CREATED, read from ca_tournament_conservation_samples
-- (the 10-minute series, retained 7 days) rather than assumed:
--
--   a5aa6984  2026-09-09 18:00  drift -22,500 -> 18:10  +2,500   (+25,000)
--   7aa16fa7  2026-09-09 22:40  drift -105,000 -> 22:50 +10,000  (+115,000)
--
-- Both jumps are a whole number of starting stacks, both land in a window in
-- which seats were being re-created wholesale after the field had been torn
-- down (7aa16fa7: 29 seats across 7 tables inserted in ONE transaction at
-- 2026-09-09 22:39:42.210959, identical to the microsecond), and neither
-- window contains a hand that could have moved that many chips. Both
-- tournaments also received a batch of seats at 2026-09-09 22:34:25.081124 -
-- the same instant named in fn_ca_assign_tournament_player_seat_locked's own
-- 2026-09-10 note about Night Owl Special b84f312f, where "a move at 22:34:25
-- wrote 448,000 over a felt of 256,000".
--
-- So the class is settled: a tournament seat was funded from the
-- tournament_players.chips MIRROR instead of from the felt. That half was
-- found and fixed by another agent on 2026-09-10, inside
-- fn_ca_assign_tournament_player_seat_locked ("THE FELT IS THE BANK ON A
-- MOVE"), together with a per-assignment conservation gate and the
-- a0_tournament_live_seat_root_guard trigger, which now refuses ANY tournament
-- live-seat acquisition that does not hold the tournament's exclusive lane.
-- Nothing in this migration touches that work.
--
-- WHAT IS STILL OPEN, AND IS WHAT THIS MIGRATION CLOSES.
--
-- Chips can enter a running tournament in exactly two ways: a live seat
-- appears holding chips, or an existing seat's stack is raised. Surveyed
-- against the live catalogue on 2026-09-11:
--
--   * seat APPEARS  - a0_tournament_live_seat_root_guard forces every such
--     write through a canonical RPC. fn_ca_assign_tournament_player_seat_locked
--     carries the 2026-09-10 conservation gate; fn_move_tournament_player
--     conserves by construction (it zeroes the source, carries v_source.stack
--     to the destination, and asserts the roster mirror agrees within 0.5).
--   * seat stack is RAISED - that trigger does NOT fire on UPDATE OF stack.
--     The only place that deliberately raises a tournament seat stack is
--     fn_ca_process_tournament_chip_purchase_money_v1, the money core behind
--     process_tournament_rebuy (rebuy / re-entry / add-on). IT HAD NO
--     CONSERVATION CHECK AT ALL. Hand settlement also writes stacks, but it
--     redistributes within a table and can never raise the tournament total.
--
-- That is the asymmetry this closes: the door where chips are BOUGHT was the
-- one door with no guard on how many chips exist afterwards. Guarding one door
-- at a time is how this incident happened; so the rule is written ONCE here,
-- in fn_ca_assert_tournament_chip_grant, for every future door to call.
--
-- THE INVARIANT: sum(live table_seats.stack) <= chips the roster has bought.
-- It is true at every instant, including mid-hand - chips in a pot have left
-- the stacks, so the felt can only be at or below the supply, never above.
-- An EXISTING overage is tolerated and only GROWTH is refused, the same shape
-- as the 2026-09-10 gate and this estate's NOT VALID constraints: the two
-- tournaments above are history and this migration does not make them
-- unfixable, it stops the next one.
--
-- SECOND DEFECT, same statement, fixed here. The re-entry branch REPLACES the
-- seat stack (stack = v_add) while the roster gains rebuys + 1, so the check's
-- expected side gains rebuy_chips. A re-entry taken while the player still
-- holds a live stack therefore DESTROYS that stack and inflates expected at
-- the same time. The rebuy branch has guarded this since it was written
-- ("Stack too high for a rebuy"); the re-entry branch never did.
--
-- THE CHECK AND THE GUARD NOW SHARE ONE DEFINITION OF SUPPLY.
-- fn_tournament_chip_conservation_check computed the entitlement inline with
-- COALESCE(rebuy_chips,0) / COALESCE(addon_chips,0), while the grant computes
-- it with COALESCE(NULLIF(rebuy_chips,0), starting_chips, 0). A tournament
-- offering rebuys with rebuy_chips = 0 would therefore be GRANTED a starting
-- stack per rebuy and CHECKED against zero - guaranteed drift with no defect
-- behind it. Measured on production before writing this: 0 of 154,372
-- tournaments are in that state, so this changes no number today. It is here
-- so the checker and the invariant cannot drift apart later. This is NOT a
-- tolerance change: p_tolerance_per_player is untouched, and the assertions
-- below prove both live findings still report exactly 10,000 and 2,500.
--
-- ROLLBACK (Tier 3). Restore the four functions from the previous definitions:
--   fn_tournament_chip_conservation_check      -> inline COALESCE(rebuy_chips,0) arithmetic
--   fn_ca_process_tournament_chip_purchase_money_v1 -> drop the PERFORM assert
--                                                      and the re-entry guard
--   DROP FUNCTION public.fn_ca_assert_tournament_chip_grant(uuid,uuid,uuid,numeric,text);
--   DROP FUNCTION public.fn_ca_tournament_felt_total(uuid);
--   DROP FUNCTION public.fn_ca_tournament_chip_supply(uuid);
-- Nothing here writes a row, so a rollback loses no data.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. ONE definition of what a tournament has issued.
--    Modelled on what the GRANT actually computes, not on what a reader might
--    assume: fn_ca_process_tournament_chip_purchase_money_v1 resolves its
--    grant as COALESCE(NULLIF(rebuy_chips,0), starting_chips, 0), so this does
--    too. A checker that models the grant differently from the grant is a
--    false alarm generator.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_chip_supply(
  p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(r.entrants,0)*COALESCE(t.starting_chips,0)
       + COALESCE(r.rebuys,0)
         *COALESCE(NULLIF(t.rebuy_chips,0),t.starting_chips,0)
       + COALESCE(r.addons,0)
         *COALESCE(NULLIF(t.addon_chips,0),t.starting_chips,0)
    FROM public.tournaments t
    LEFT JOIN LATERAL (
      SELECT count(*) AS entrants,
             COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0) AS rebuys,
             count(*) FILTER (WHERE tp.add_on) AS addons
        FROM public.tournament_players tp
       WHERE tp.tournament_id=t.id
    ) r ON true
   WHERE t.id=p_tournament_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_chip_supply(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_chip_supply(uuid)
  TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What is actually on the felt right now.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_total(
  p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(ts.stack),0)
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id=ts.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND ts.left_at IS NULL;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_total(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_total(uuid)
  TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. THE INVARIANT, written once so every door can call it.
--
--    p_seat_id is the seat about to be written and p_new_stack the value it
--    is about to hold. The seat's CURRENT stack is subtracted before the new
--    one is added, so an ordinary top-up that stays inside the supply cannot
--    trip it, and a move that carries a stack unchanged cannot either.
--
--    Refuses only GROWTH past the cap. A tournament already over its cap
--    (7aa16fa7 and a5aa6984 are, by 10,000 and 2,500) keeps playing; what it
--    may not do is get further over.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_assert_tournament_chip_grant(
  p_tournament_id uuid,
  p_user_id uuid,
  p_seat_id uuid,
  p_new_stack numeric,
  p_source text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_felt numeric;
  v_own numeric;
  v_supply numeric;
  v_after numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_new_stack IS NULL THEN
    RAISE EXCEPTION 'tournament chip grant assertion needs a tournament and a stack'
      USING ERRCODE='22023';
  END IF;
  IF p_new_stack::text IN ('NaN','Infinity','-Infinity') OR p_new_stack<0 THEN
    RAISE EXCEPTION 'TOURNAMENT_CHIP_GRANT_INVALID: % proposed stack %',
      COALESCE(p_source,'grant'),p_new_stack
      USING ERRCODE='22023';
  END IF;

  v_supply:=public.fn_ca_tournament_chip_supply(p_tournament_id);
  v_felt:=public.fn_ca_tournament_felt_total(p_tournament_id);
  SELECT COALESCE(ts.stack,0) INTO v_own
    FROM public.table_seats ts
   WHERE ts.id=p_seat_id AND ts.left_at IS NULL;
  v_after:=v_felt-COALESCE(v_own,0)+p_new_stack;

  IF v_after>v_felt AND v_after>v_supply THEN
    RAISE EXCEPTION
      'TOURNAMENT_CHIP_GRANT_WOULD_MINT: % for player % would leave % chips on the felt in tournament % against % ever bought in (felt now %, this seat holds %) - Aborting So No Charge Is Made',
      COALESCE(p_source,'grant'),p_user_id,v_after,p_tournament_id,v_supply,
      v_felt,COALESCE(v_own,0)
      USING ERRCODE='55000';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_assert_tournament_chip_grant(
  uuid,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_assert_tournament_chip_grant(
  uuid,uuid,uuid,numeric,text) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. THE MONEY CORE CALLS IT.
--
--    fn_ca_process_tournament_chip_purchase_money_v1 is the one statement on
--    this platform that deliberately RAISES a tournament seat stack, and the
--    only one the a0_tournament_live_seat_root_guard trigger does not see
--    (that trigger fires on INSERT and on UPDATE OF table_id/user_id/
--    seat_number/left_at - never on stack).
--
--    Two changes, both marked CONSERVATION below; everything else is the
--    2026-09-10 body verbatim:
--
--      (a) a re-entry is refused while the entry still holds chips, because
--          the write below REPLACES the stack and would destroy them while
--          rebuys + 1 raises the expected side. The rebuy branch has always
--          had this guard; the re-entry branch never did.
--      (b) the intended stack is asserted against the tournament's supply
--          BEFORE it is written. The roster update above has already booked
--          this purchase's rebuys/add_on, so the cap being compared against
--          already includes what is being bought - the felt must land inside
--          the cap the buyer just paid to raise.
--
--    Raising aborts the whole transaction, which unwinds the wallet debit
--    with it. That is this function's existing idiom, not a new one: it
--    already says "Aborting So No Charge Is Made" in three places.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_p record;
  v_balance numeric;
  v_ratio numeric;
  v_is_bounty boolean;
  v_bounty_head numeric;
  v_base numeric;
  v_fee numeric;
  v_total numeric;
  v_add integer;
  v_new_chips integer;
  v_seat record;
  v_key text;
  v_inserted integer;
  v_cat text;
  v_club uuid;
  v_stack_after numeric;
  v_expected numeric;
  v_fee_ratio numeric;
  v_was_seated boolean:=false;
  v_rows integer;
  v_led_cat text;
  v_led_cp text;
  v_led_ent text;
  v_led_tid text;
BEGIN
  IF NOT (COALESCE(auth.role(),'service_role')='service_role')
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF p_client_token IS NULL OR length(btrim(p_client_token))=0
     OR length(btrim(p_client_token))>128 THEN
    RAISE EXCEPTION 'exact tournament chip-purchase token is required'
      USING ERRCODE='22023';
  END IF;

  SELECT id,name,club_id,status,buy_in_amount,buy_in_fee,starting_chips,
         is_rebuy,is_reentry,add_on_available,addon_period_triggered,
         rebuy_cost,rebuy_chips,rebuy_levels,late_reg_levels,max_rebuys,
         max_reentries,addon_cost,addon_chips,addon_levels,current_level,
         prize_pool,is_bounty,is_pko,is_mystery_bounty,bounty_amount
    INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)',v_t.status;
  END IF;

  SELECT id,chips,status,prize,rebuys,add_on,table_id,club_id
    INTO v_p
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;
  IF v_p.status='eliminated' AND COALESCE(v_p.prize,0)>0 THEN
    RAISE EXCEPTION
      'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result';
  END IF;
  v_club:=v_p.club_id;
  IF v_club IS NULL THEN
    RAISE EXCEPTION
      'Tournament entry funding club is missing; refusing a substituted wallet'
      USING ERRCODE='P0404';
  END IF;

  v_cat:=CASE WHEN p_rebuy_type='addon' THEN 'addon' ELSE 'rebuy' END;
  v_key:=CASE WHEN p_rebuy_type='addon'
    THEN 'tourney:'||p_tournament_id::text||':addon:'||p_user_id::text
    ELSE 'tourney:'||p_tournament_id::text||':'||p_rebuy_type||':'||
         p_user_id::text||':tok:'||btrim(p_client_token)
  END;

  IF p_rebuy_type='addon' THEN
    PERFORM 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL
       AND tb.tournament_id=p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No Live Seat For This % - Aborting So No Charge Is Made',p_rebuy_type;
    END IF;
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament';
    END IF;
    IF COALESCE(v_p.add_on,false) THEN
      RAISE EXCEPTION 'Add-on already taken';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.addon_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips,0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament';
    END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament';
    END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)',v_p.rebuys,v_t.max_rebuys;
    END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_reentries THEN
      RAISE EXCEPTION
        'Re-entry limit reached (% of %)',v_p.rebuys,v_t.max_reentries;
    END IF;
    IF p_rebuy_type='rebuy'
       AND COALESCE(v_p.chips,0)>COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy';
    END IF;
    /* CONSERVATION (a) 2026-09-11. A re-entry REPLACES the seat stack below
       (stack = v_add) while the roster gains rebuys + 1, so the conservation
       check's expected side gains rebuy_chips at the same moment. Taken while
       the entry still holds chips, that destroys them AND inflates expected.
       A re-entry follows a bust, so the live population for this is zero; it
       is refused rather than left to silently unbalance the event. */
    IF p_rebuy_type='reentry' AND COALESCE(v_p.chips,0)>0 THEN
      RAISE EXCEPTION
        'A Re-Entry Starts A New Stack And This Entry Still Holds % Chips - Aborting So No Charge Is Made',
        v_p.chips
        USING ERRCODE='55000';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.rebuy_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips,0)::integer;
  END IF;

  v_fee_ratio:=CASE
    WHEN COALESCE(v_t.buy_in_amount,0)+COALESCE(v_t.buy_in_fee,0)>0
         AND COALESCE(v_t.buy_in_fee,0)>0
      THEN v_t.buy_in_fee/(v_t.buy_in_amount+v_t.buy_in_fee)
    ELSE 0.1
  END;
  v_ratio:=CASE WHEN p_rebuy_type='addon' THEN 0 ELSE v_fee_ratio END;
  v_total:=round(v_base::numeric);
  -- The total stays a whole chip, while the house cut is floored to cents.
  -- Fractional fees are deliberate: a 1-chip entry pays 0.10 and a 5-chip
  -- entry pays 0.50 without ever exceeding the ten-percent ceiling.
  v_fee:=CASE WHEN v_ratio>0 AND v_total>0
    THEN LEAST(trunc(v_total*v_ratio*100+0.000001)/100,
               trunc(v_total*0.1*100+0.000001)/100)
    ELSE 0
  END;
  v_base:=round(v_total-v_fee,2);
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
    OR COALESCE(v_t.is_pko,false)
    OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type<>'addon' THEN
    v_bounty_head:=LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_base);
    v_base:=v_base-v_bounty_head;
  ELSE
    v_bounty_head:=0;
  END IF;
  IF p_cost IS NOT NULL AND abs(p_cost-v_total)>0.01 THEN
    RAISE EXCEPTION
      'Price mismatch: client quoted %, server computed %',p_cost,v_total
      USING ERRCODE='22023';
  END IF;
  IF v_add<=0 OR v_total<0 OR v_fee<0 OR v_base<0 OR v_bounty_head<0
     OR round(v_base+v_bounty_head+v_fee,2)<>round(v_total,2) THEN
    RAISE EXCEPTION 'Tournament chip-purchase quote does not conserve'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_total)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN
    RETURN jsonb_build_object(
      'success',true,'idempotent',true,'new_stack',v_p.chips,
      'rebuy_type',p_rebuy_type);
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;

  v_led_cat:=current_setting('app.ledger_category',true);
  v_led_cp:=current_setting('app.ledger_counterparty',true);
  v_led_ent:=current_setting('app.ledger_counterparty_entity',true);
  v_led_tid:=current_setting('app.ledger_tournament',true);
  PERFORM set_config('app.ledger_category',v_cat,true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;
  PERFORM set_config('app.ledger_category',COALESCE(v_led_cat,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_led_cp,''),true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_led_ent,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_led_tid,''),true);

  IF p_rebuy_type='reentry' THEN
    UPDATE public.tournament_players
       SET chips=v_add,status='playing',eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,status='playing',
           eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;
  IF v_new_chips IS NULL THEN
    RAISE EXCEPTION 'Locked tournament roster changed during chip grant'
      USING ERRCODE='40001';
  END IF;

  IF v_bounty_head>0 THEN
    UPDATE public.tournament_players
       SET current_bounty=CASE WHEN p_rebuy_type='reentry'
         THEN v_bounty_head
         ELSE COALESCE(current_bounty,0)+v_bounty_head END
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
  END IF;

  SELECT s.id,s.stack INTO v_seat
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC,
            s.joined_at DESC NULLS LAST,s.id DESC
   LIMIT 1;
  IF FOUND THEN
    v_was_seated:=true;
    v_expected:=CASE WHEN p_rebuy_type='reentry'
      THEN v_add ELSE COALESCE(v_seat.stack,0)+v_add END;
    /* CONSERVATION (b) 2026-09-11. The roster above has already booked this
       purchase, so the supply this is measured against already contains the
       chips being bought. The felt must land inside it. An event that is
       already over its cap keeps playing; it may not get further over.
       See ca_drift_incidents 8b8fe26c and this migration's header. */
    PERFORM public.fn_ca_assert_tournament_chip_grant(
      p_tournament_id,p_user_id,v_seat.id,v_expected,
      'tournament '||p_rebuy_type);
    UPDATE public.table_seats
       SET stack=CASE WHEN p_rebuy_type='reentry'
         THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
     RETURNING stack INTO v_stack_after;
    IF v_stack_after IS NULL OR v_stack_after<>v_expected THEN
      RAISE EXCEPTION
        'Chip Grant Did Not Land: % Expected Stack %, Seat % Holds % - Aborting So No Charge Is Made',
        p_rebuy_type,v_expected,v_seat.id,v_stack_after;
    END IF;
    UPDATE public.tournament_players
       SET chips=(SELECT stack FROM public.table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    RAISE EXCEPTION
      'Seat Disappeared During % - Aborting So No Charge Is Made',p_rebuy_type;
  END IF;

  UPDATE public.tournaments
     SET prize_pool=COALESCE(prize_pool,0)+v_base,
         bounty_pool=COALESCE(bounty_pool,0)+v_bounty_head
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Tournament vanished during chip-purchase pool booking'
      USING ERRCODE='40001';
  END IF;

  IF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,
      'process_tournament_rebuy',jsonb_build_object(
        'kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
        'entry_club_id',v_club));
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  END IF;

  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')||
      ' ('||v_base||' prize + '||v_bounty_head||' bounty + '||v_fee||
      ' fee) [club wallet]',
    p_tournament_id,v_balance-v_total);

  RETURN jsonb_build_object(
    'success',true,'new_stack',v_new_chips,'rebuy_type',p_rebuy_type,
    'chips_added',v_add,'cost',v_total,'fee',v_fee,'seated',v_was_seated,
    'bounty_head_funded',v_bounty_head);
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The checker reads the SAME supply the guard enforces.
--
--    Previously this computed the entitlement inline. Two copies of one rule
--    is how a checker ends up accusing a grant of a drift the grant was
--    configured to create. There is now one copy, and section 1 says why it
--    is spelled the way the grant spells it.
--
--    "EVERY REGISTRANT IS DEALT IN" (2026-09-09) is preserved exactly:
--    fn_ca_tournament_chip_supply counts every tournament_players row, not
--    the players currently visible in table_seats. Seats are recycled as
--    players bust and tables consolidate, so that set is who last sat in each
--    chair, not who was dealt in.
--
--    p_tolerance_per_player is UNCHANGED. The assertions below prove both
--    live findings still report their exact drift after this replacement.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_tournament_chip_conservation_check(p_tolerance_per_player numeric DEFAULT 1)
 RETURNS TABLE(tournament_id uuid, name text, players bigint, expected_chips numeric, actual_chips numeric, drift numeric, drift_per_player numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH calc AS (
    SELECT t.id,
           t.name,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS players,
           public.fn_ca_tournament_chip_supply(t.id) AS expected_chips,
           public.fn_ca_tournament_felt_total(t.id)  AS actual_chips
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
  )
  SELECT c.id, c.name, c.players,
         round(c.expected_chips, 2),
         round(c.actual_chips, 2),
         round(c.actual_chips - c.expected_chips, 2),
         round((c.actual_chips - c.expected_chips) / NULLIF(c.players, 0), 3)
    FROM calc c
   WHERE c.players > 0
     AND abs(c.actual_chips - c.expected_chips)
         > (GREATEST(p_tolerance_per_player, 0) * c.players)
   ORDER BY abs(c.actual_chips - c.expected_chips) DESC;
$function$;

-- Operator and engine telemetry, not player surface: none of these four is an
-- RLS policy helper (checked against pg_policy before revoking), and all four
-- are SECURITY DEFINER, so an anon or authenticated EXECUTE grant would read
-- the whole tournament estate past RLS. PUBLIC is named alongside the roles
-- because anon inherits whatever PUBLIC holds, so revoking anon alone reads as
-- a fix and does nothing. fn_tournament_chip_conservation_check keeps its live
-- ACL across CREATE OR REPLACE, but a rebuild from this file would create it
-- wide open, so it is stated here too.
REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_chip_conservation_check(numeric)
  TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. POST-APPLY ASSERTIONS. Each one aborts this migration if the assumption
--    it names is not true of production at apply time. Nothing below writes.
-- ───────────────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_bad integer;
  v_t1 numeric;
  v_t2 numeric;
  v_seat uuid;
  v_stack numeric;
  v_raised boolean;
BEGIN
  -- 6a. The shared supply must equal the arithmetic the checker used before,
  --     for every RUNNING tournament. If this fails, the replacement changed a
  --     live number and must not ship.
  SELECT count(*) INTO v_bad
    FROM public.tournaments t
    LEFT JOIN LATERAL (
      SELECT count(*) AS entrants,
             COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0) AS rebuys,
             count(*) FILTER (WHERE tp.add_on) AS addons
        FROM public.tournament_players tp
       WHERE tp.tournament_id=t.id
    ) r ON true
   WHERE t.status='RUNNING'
     AND public.fn_ca_tournament_chip_supply(t.id) IS DISTINCT FROM
         ( COALESCE(r.entrants,0)*COALESCE(t.starting_chips,0)
         + COALESCE(r.rebuys,0)*COALESCE(t.rebuy_chips,0)
         + COALESCE(r.addons,0)*COALESCE(t.addon_chips,0) );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'ABORT: the shared chip supply disagrees with the previous inline arithmetic on % RUNNING tournament(s); this migration may not change a live expected value',
      v_bad;
  END IF;

  -- 6b. The two open findings must still report EXACTLY what they reported
  --     before. A guard that quiets its own alarm is the failure mode this
  --     whole incident is about.
  SELECT drift INTO v_t1 FROM public.fn_tournament_chip_conservation_check(1)
   WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d';
  SELECT drift INTO v_t2 FROM public.fn_tournament_chip_conservation_check(1)
   WHERE tournament_id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd';
  IF COALESCE(v_t1,-1) <> 10000 OR COALESCE(v_t2,-1) <> 2500 THEN
    RAISE EXCEPTION
      'ABORT: the open findings changed under this migration (7aa16fa7 reported %, expected 10000; a5aa6984 reported %, expected 2500). Either the board moved or the checker was weakened.',
      v_t1, v_t2;
  END IF;

  -- 6c. The invariant actually refuses a mint, proved against a real seat in
  --     an event that is already at its cap. Read-only: no row is written.
  SELECT ts.id, ts.stack INTO v_seat, v_stack
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id=ts.table_id
   WHERE tb.tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'
     AND ts.left_at IS NULL
   ORDER BY ts.stack DESC
   LIMIT 1;
  IF v_seat IS NULL THEN
    RAISE EXCEPTION
      'ABORT: 7aa16fa7 has no live seat to prove the invariant against';
  END IF;

  -- the stack it already holds is not growth, so it must pass
  PERFORM public.fn_ca_assert_tournament_chip_grant(
    '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d',NULL,v_seat,v_stack,'selftest:noop');

  -- one chip more than it holds IS growth past a cap already exceeded
  v_raised := false;
  BEGIN
    PERFORM public.fn_ca_assert_tournament_chip_grant(
      '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d',NULL,v_seat,v_stack+1,
      'selftest:mint');
  EXCEPTION WHEN OTHERS THEN
    v_raised := (SQLERRM LIKE 'TOURNAMENT_CHIP_GRANT_WOULD_MINT%');
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION
      'ABORT: fn_ca_assert_tournament_chip_grant did not refuse a grant that would push the felt further past the supply';
  END IF;

  -- 6d. The money core must actually call the invariant. A later
  --     CREATE OR REPLACE that drops the call is the regression this names.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname='fn_ca_process_tournament_chip_purchase_money_v1'
       AND pg_get_functiondef(p.oid) LIKE '%fn_ca_assert_tournament_chip_grant%')
  THEN
    RAISE EXCEPTION
      'ABORT: the tournament chip-purchase money core does not call fn_ca_assert_tournament_chip_grant';
  END IF;

  -- 6e. and it must still refuse a re-entry taken on a stack that has chips.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname='fn_ca_process_tournament_chip_purchase_money_v1'
       AND pg_get_functiondef(p.oid) LIKE '%A Re-Entry Starts A New Stack%')
  THEN
    RAISE EXCEPTION
      'ABORT: the re-entry branch lost its stack guard';
  END IF;
END;
$assert$;

COMMIT;
