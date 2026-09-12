-- A Diamond table may straddle.
--
-- A straddle is the one optional cash feature that needs nothing from the chip
-- economy. StraddleEngine prices it at exactly two times the current blind, and
-- every Diamond guard already refuses a table whose blinds are not whole
-- positive integers, so a Diamond straddle is whole by construction with no
-- division anywhere on the path. There is no counterparty, no ledger and no
-- obligation: the units leave one stack and enter the pot, which the
-- accepted-hand guard already requires to be whole. HandController never
-- refused a straddle for Diamond either; it validates every straddle amount as
-- a non-negative safe integer and says nothing more about them. The only two
-- places that refused one were the table-load boundary and this door.
--
-- seven_deuce_enabled is NOT a straddle and stays refused: it is a side bet
-- paid between players at a table-configured amount, which is a separate money
-- fact this phase has not certified.
--
-- The body below is the September 10 admission door with exactly three clauses
-- removed, straddle_enabled, auto_utg_straddle and voluntary_straddle. Nothing
-- else in it changed, and the preflight refuses to apply if the function it is
-- editing is not the one this was derived from.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure) IS DISTINCT FROM 'f9a98897558d101de6a010dbfbeb938c' THEN
  RAISE EXCEPTION 'diamond_straddle_prerequisite_changed:fn_poker_diamond_buyin';
 END IF;
END $preflight$;

-- The admission door is already a registered money writer in production; this
-- states it rather than asserting it, so the same file also loads into the
-- isolated fixture, whose registry is seeded separately. The estate's own
-- registry guard is what actually enforces this on the CREATE below.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
 ('fn_poker_diamond_buyin','approved',
  'Diamond cash seat admission. Reserves settled Diamonds into custody and inserts the seat in one transaction.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_buyin(
 p_user_id uuid,p_table_id uuid,p_seat_number integer,p_amount numeric,
 p_auto_rebuy boolean,p_club_id uuid,p_idempotency_key uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_t public.tables%ROWTYPE;
 v_seat_id uuid:=gen_random_uuid();
 v_custody jsonb;
 v_taken integer;
 v_holds integer;
BEGIN
 IF p_idempotency_key IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
    OR p_seat_number IS NULL OR p_seat_number<1 OR p_auto_rebuy IS DISTINCT FROM false
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647
    OR p_amount<>trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_cash_purchase' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000';
 END IF;
 IF v_t.game_variant IS DISTINCT FROM 'nlh' OR v_t.tournament_id IS NOT NULL
    OR v_t.cluster_id IS NOT NULL
    OR coalesce(v_t.is_template,false) OR v_t.status NOT IN ('waiting','running','playing','active')
    OR coalesce(v_t.rake_percent,0)<>0 OR coalesce(v_t.bbj_percent,0)<>0
    OR coalesce(v_t.insurance_enabled,false) OR coalesce(v_t.bomb_pot_enabled,false)
    OR coalesce(v_t.run_it_twice_enabled,false) OR coalesce(v_t.run_it_twice,false)
    OR coalesce(v_t.allow_run_it_twice,false)
    OR coalesce(v_t.seven_deuce_enabled,false) OR coalesce(v_t.nit_game,false)
    OR coalesce(v_t.all_in_or_fold,false) OR coalesce(v_t.pineapple_holdem,false)
    OR coalesce(v_t.cap_enabled,false) THEN
   RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- Match the shared engine load boundary before reserving any Diamonds.
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647
        OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
   RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 IF p_club_id IS NOT NULL AND p_club_id<>v_t.club_id THEN
   RAISE EXCEPTION 'diamond_purchase_arena_mismatch' USING ERRCODE='22023';
 END IF;
 IF v_t.max_players IS NULL OR p_seat_number>v_t.max_players THEN
   RAISE EXCEPTION 'TABLE_SIZE: invalid Diamond seat' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.blacklists WHERE user_id=p_user_id
     AND club_id=v_t.club_id AND (expires_at IS NULL OR expires_at>now())) THEN
   RAISE EXCEPTION 'Banned from this club' USING ERRCODE='42501';
 END IF;
 IF coalesce(v_t.is_vip_only,false) AND NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=p_user_id AND p.is_vip IS TRUE
      AND (p.vip_expires_at IS NULL OR p.vip_expires_at>now())) THEN
   RAISE EXCEPTION 'VIP_ONLY: this table requires VIP membership' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL
           AND (user_id=p_user_id OR seat_number=p_seat_number)) THEN
   RAISE EXCEPTION 'Diamond seat or player is already seated' USING ERRCODE='23505';
 END IF;
 SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
 SELECT count(*) INTO v_holds FROM public.table_waitlist
   WHERE table_id=p_table_id AND status='notified' AND user_id<>p_user_id
     AND coalesce(hold_expires_at,notified_at+interval '60 seconds')>now();
 IF v_taken>=v_t.max_players OR v_taken+v_holds>=v_t.max_players THEN
   RAISE EXCEPTION 'SEAT_RESERVED: table capacity is taken or held' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL AND t.tournament_id IS NULL
       AND t.status NOT IN ('closed','deleted'))>=4 THEN
   RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at four cash tables' USING ERRCODE='55000';
 END IF;

 v_custody:=public.fn_poker_diamond_reserve(p_user_id,'cash_seat',p_table_id,
   'seat:'||v_seat_id,p_amount,p_idempotency_key);
 PERFORM set_config('app.money_path','atomic_table_buyin',true);
 DELETE FROM public.table_seats WHERE table_id=p_table_id
   AND seat_number=p_seat_number AND left_at IS NOT NULL;
 INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,auto_rebuy,club_id)
   VALUES(v_seat_id,p_table_id,p_seat_number,p_user_id,p_amount,'active',false,v_t.club_id);
 -- The after-insert binder sees the final occupancy stamped by the shared trigger.
 IF NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.table_seats s ON s.id=c.seat_id AND s.joined_at=c.seat_joined_at
       AND s.occupancy_id=c.occupancy_id
     WHERE c.id=(v_custody->>'custody_id')::uuid AND c.state='active'
       AND s.id=v_seat_id AND s.left_at IS NULL AND s.stack=c.balance) THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 UPDATE public.table_waitlist SET status='seated'
   WHERE table_id=p_table_id AND user_id=p_user_id AND status IN ('waiting','notified');
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

-- The staff door that turns straddles on for a table that already exists.
--
-- The seventeen live arena tables were opened with every optional feature
-- explicitly false, which was correct then and is what this changes. It is the
-- same authority as the creation door, fn_is_platform_admin(), and it refuses
-- any table the Diamond boundary would not admit afterwards, so the flag can
-- never be the thing that makes a table unplayable. The engine re-reads these
-- columns on its own refresh and re-validates the row against the boundary
-- before applying it, so a table that is already running picks the change up
-- without a restart.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
 ('fn_poker_diamond_set_table_straddle','system',
  'Moves no money. Flips straddle_enabled and auto_utg_straddle on one platform Diamond cash table, staff only, and refuses a table the Diamond boundary would not admit.')
ON CONFLICT (proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_straddle(
 p_table_id uuid,p_enabled boolean,p_auto_utg boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_t public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL OR p_auto_utg IS NULL THEN
  RAISE EXCEPTION 'diamond_straddle_requires_explicit_flags' USING ERRCODE='22023';
 END IF;
 IF p_auto_utg AND NOT p_enabled THEN
  RAISE EXCEPTION 'diamond_straddle_auto_requires_straddles' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 IF v_t.game_variant IS DISTINCT FROM 'nlh' OR v_t.tournament_id IS NOT NULL
    OR v_t.cluster_id IS NOT NULL OR coalesce(v_t.is_template,false)
    OR coalesce(v_t.rake_percent,0)<>0 OR coalesce(v_t.rake_cap_bb,0)<>0
    OR coalesce(v_t.bbj_percent,0)<>0
    OR coalesce(v_t.insurance_enabled,false) OR coalesce(v_t.bomb_pot_enabled,false)
    OR coalesce(v_t.run_it_twice_enabled,false) OR v_t.run_it_twice IS DISTINCT FROM false
    OR v_t.allow_run_it_twice IS DISTINCT FROM false
    OR coalesce(v_t.seven_deuce_enabled,false) OR coalesce(v_t.nit_game,false)
    OR coalesce(v_t.all_in_or_fold,false) OR coalesce(v_t.pineapple_holdem,false)
    OR coalesce(v_t.cap_enabled,false) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET straddle_enabled=p_enabled,
       auto_utg_straddle=CASE WHEN p_enabled THEN p_auto_utg ELSE false END,
       voluntary_straddle=CASE WHEN p_enabled THEN NOT p_auto_utg ELSE false END
 WHERE id=p_table_id;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)
 TO authenticated;
COMMENT ON FUNCTION public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean) IS
 'Turns straddles on or off for one platform Diamond cash table. Platform staff only. Refuses any table the Diamond boundary would not admit afterwards, and moves no money.';

COMMIT;
