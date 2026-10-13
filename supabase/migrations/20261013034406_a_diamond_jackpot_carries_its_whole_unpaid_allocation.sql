-- Preserve every drop and carried entitlement in the original accepted hand.
-- Fractional residue remains [0,1); a clamped whole share is separately owed.
-- It is metadata, not a minted asset or a second financial request.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$
DECLARE f record;
BEGIN
 SELECT p.*,pg_get_userbyid(proowner) owner INTO f FROM pg_proc p
 WHERE oid=to_regprocedure('public.fn_poker_diamond_jackpot_allocate(uuid,bigint)');
 IF NOT FOUND OR md5(pg_get_functiondef(f.oid)) IS DISTINCT FROM 'e3a59243b2b04f7a8c2c6f60a8d9381b'
 OR f.owner IS DISTINCT FROM 'postgres' OR f.prosecdef IS DISTINCT FROM true
 OR f.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
 OR f.proacl::text IS DISTINCT FROM '{postgres=X/postgres}' THEN
 RAISE EXCEPTION 'diamond_whole_carry_preimage_changed'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_poker_diamond_jackpot_withdraw(uuid,uuid)'))) IS DISTINCT FROM 'b71c6d49d5d5d34ab8381b007ad5abc4'
 OR md5(pg_get_functiondef(to_regprocedure('public.fn_poker_diamond_jackpot_reseed(uuid)'))) IS DISTINCT FROM 'b7a50061e6aef8a4c5ebb8084002be0a' THEN
 RAISE EXCEPTION 'diamond_whole_carry_transition_changed'; END IF;
 IF (SELECT count(*) FROM pg_class c WHERE c.oid IN ('public.poker_diamond_jackpot_pools'::regclass,'public.poker_diamond_jackpot_ledger'::regclass)
 AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}'
 AND c.relrowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)) IS DISTINCT FROM 2 THEN
 RAISE EXCEPTION 'diamond_whole_carry_table_authority_changed'; END IF;
 IF (SELECT count(*) FROM supabase_migrations.schema_migrations
 WHERE version='20261012191143' AND cardinality(statements)=1
 AND md5(statements[1])='053330c6a02387f74bc8f3e17583f208') IS DISTINCT FROM 1
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations
 WHERE version='20261013021756' AND cardinality(statements)=1
 AND md5(statements[1])='4550b7577a9602c436c65869db8535ef') IS DISTINCT FROM 1 THEN
 RAISE EXCEPTION 'diamond_whole_carry_predecessor_history_changed'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
 RAISE EXCEPTION 'diamond_whole_carry_platform_frozen'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.poker_diamond_jackpot_pools'::regclass
 AND attname IN ('main_whole_carry','backup_whole_carry') AND NOT attisdropped) THEN
 RAISE EXCEPTION 'diamond_whole_carry_already_present'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.poker_diamond_jackpot_pools'::regclass
 AND convalidated AND ((conname='poker_diamond_jackpot_pools_main_residue_check'
 AND pg_get_constraintdef(oid)='CHECK (((main_residue >= (0)::numeric) AND (main_residue < (1)::numeric)))')
 OR (conname='poker_diamond_jackpot_pools_backup_residue_check'
 AND pg_get_constraintdef(oid)='CHECK (((backup_residue >= (0)::numeric) AND (backup_residue < (1)::numeric)))'))) IS DISTINCT FROM 2 THEN
 RAISE EXCEPTION 'diamond_whole_carry_fraction_contract_changed'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_poker_diamond_jackpot_drop(uuid,bigint,bigint,jsonb)'))) IS DISTINCT FROM '7f7942a5318b29b53293dc7355d85f68'
 OR md5(pg_get_functiondef(to_regprocedure('public.fn_poker_diamond_jackpot_bank(uuid,text)'))) IS DISTINCT FROM '16efb5d2bb9b95406b4307cffedfc77f'
 OR md5(pg_get_functiondef(to_regprocedure('public.fn_poker_diamond_jackpot_accept_hand()'))) IS DISTINCT FROM '0db3d6146f5e1118c570ded9bfb5261f' THEN
 RAISE EXCEPTION 'diamond_whole_carry_connected_source_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_atomic_commits'::regclass
 AND tgname='poker_diamond_jackpot_accept_hand' AND tgenabled='O'
 AND md5(pg_get_triggerdef(oid))='d520254027350e60b03aad1f1a73747a') THEN
 RAISE EXCEPTION 'diamond_whole_carry_trigger_changed'; END IF;
END $guard$;
ALTER TABLE public.poker_diamond_jackpot_pools
 ADD COLUMN main_whole_carry bigint NOT NULL DEFAULT 0 CHECK(main_whole_carry>=0),
 ADD COLUMN backup_whole_carry bigint NOT NULL DEFAULT 0 CHECK(backup_whole_carry>=0),
 ADD CONSTRAINT poker_diamond_jackpot_whole_carry_stays_active
 CHECK(status='active' OR(main_whole_carry=0 AND backup_whole_carry=0));
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_allocate(
  p_pool_id uuid, p_amount bigint,
  OUT o_main bigint, OUT o_backup bigint, OUT o_promotional bigint)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pool public.poker_diamond_jackpot_pools%ROWTYPE;
  v_main_share numeric; v_backup_share numeric; v_split text;
  v_exact_main numeric; v_exact_backup numeric;
  v_main_whole bigint; v_backup_whole bigint;
  v_main_balance bigint;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_must_be_a_whole_positive_diamond:%', p_amount
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_pool FROM public.poker_diamond_jackpot_pools
   WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  IF v_pool.status <> 'active' THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_not_active:%', v_pool.status USING ERRCODE = '23514';
  END IF;

  v_main_balance := public.fn_poker_diamond_jackpot_bank(p_pool_id, 'main');
  -- B18, read as one shares answer. Segment 1 is the standard regime,
  -- segment 2 the regime at and above the pivot, and `pivot_at` is the main
  -- balance that moves between them. One row, read strictly, no literal here.
  v_split := public.fn_ca_diamond_economic_text('bbj_pool_split');
  IF v_main_balance >= public.fn_poker_diamond_jackpot_share(v_split, 2, 'pivot_at') THEN
    v_main_share   := public.fn_poker_diamond_jackpot_share(v_split, 2, 'main');
    v_backup_share := public.fn_poker_diamond_jackpot_share(v_split, 2, 'backup');
  ELSE
    v_main_share   := public.fn_poker_diamond_jackpot_share(v_split, 1, 'main');
    v_backup_share := public.fn_poker_diamond_jackpot_share(v_split, 1, 'backup');
  END IF;
  IF v_main_share + v_backup_share > 100 THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_exceed_the_drop:%+%', v_main_share, v_backup_share
      USING ERRCODE = '23514';
  END IF;

  v_exact_main   := p_amount * v_main_share   / 100 + v_pool.main_residue + v_pool.main_whole_carry;
  v_exact_backup := p_amount * v_backup_share / 100 + v_pool.backup_residue + v_pool.backup_whole_carry;
  v_main_whole := floor(v_exact_main)::bigint;
  v_backup_whole := floor(v_exact_backup)::bigint;
  o_main := v_main_whole;
  o_backup := v_backup_whole;
  -- A bank is never asked for more than the drop, nor less than nothing: the
  -- same two clamps the chip allocator carries.
  o_main   := least(greatest(o_main, 0), p_amount);
  o_backup := least(greatest(o_backup, 0), p_amount - o_main);
  -- Promotional takes the remainder, so the three re-sum to the drop exactly.
  o_promotional := p_amount - o_main - o_backup;

  UPDATE public.poker_diamond_jackpot_pools
     SET main_residue   = v_exact_main - v_main_whole,
         backup_residue = v_exact_backup - v_backup_whole,
         main_whole_carry = v_main_whole - o_main,
         backup_whole_carry = v_backup_whole - o_backup,
         updated_at     = now()
   WHERE id = p_pool_id;

  IF o_main + o_backup + o_promotional <> p_amount THEN
    RAISE EXCEPTION 'diamond_jackpot_allocation_does_not_conserve' USING ERRCODE = '23514';
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_withdraw(
  p_pool_id uuid, p_into_pool_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_ref text; v_moved jsonb := '{}'::jsonb; v_b record; v_total bigint := 0;
BEGIN
  IF public.fn_ca_diamond_economic_text('bbj_withdrawal_destination')
     <> 'surviving_diamond_jackpot_pool' THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_destination_is_not_a_pool' USING ERRCODE = '23514';
  END IF;
  IF p_into_pool_id IS NULL THEN
    -- B22's second branch is recorded in the same row's basis, and paying
    -- every contributor pro rata is a distribution to named people. This door
    -- refuses rather than guessing at it, so the last pool cannot be withdrawn
    -- by accident and leave the Diamonds nowhere.
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_needs_a_surviving_pool:contributing_players_pro_rata'
      USING ERRCODE = '23514';
  END IF;
  IF p_into_pool_id = p_pool_id THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_into_itself' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.poker_diamond_jackpot_pools
   WHERE id IN (p_pool_id, p_into_pool_id) ORDER BY id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_pools
                  WHERE id = p_into_pool_id AND status = 'active') THEN
    RAISE EXCEPTION 'diamond_jackpot_surviving_pool_is_not_active' USING ERRCODE = '23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.poker_diamond_jackpot_pools WHERE id=p_pool_id
    AND (main_whole_carry>0 OR backup_whole_carry>0)) THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_has_whole_owed_carry' USING ERRCODE='23514';
  END IF;
  v_ref := 'bbjwithdraw:' || p_pool_id::text;
  FOR v_b IN SELECT b AS bank, public.fn_poker_diamond_jackpot_bank(p_pool_id, b) AS held
               FROM unnest(ARRAY['main', 'backup', 'promotional']) b LOOP
    CONTINUE WHEN v_b.held <= 0;
    INSERT INTO public.poker_diamond_jackpot_ledger(pool_id, bank, kind, amount, ref, note)
    VALUES (p_pool_id,      v_b.bank, 'merge_out', -v_b.held, v_ref,
            'the jackpot is withdrawn; this bank moves to the surviving pool'),
           (p_into_pool_id, v_b.bank, 'merge_in',   v_b.held, v_ref || ':in',
            'a withdrawn jackpot''s ' || v_b.bank || ' bank arrives');
    v_total := v_total + v_b.held;
    v_moved := v_moved || jsonb_build_object(v_b.bank, v_b.held);
  END LOOP;
  UPDATE public.poker_diamond_jackpot_pools
     SET status = 'retired_settled', merged_into_pool_id = p_into_pool_id, updated_at = now()
   WHERE id = p_pool_id;
  IF public.fn_poker_diamond_jackpot_bank(p_pool_id, 'main')
     + public.fn_poker_diamond_jackpot_bank(p_pool_id, 'backup')
     + public.fn_poker_diamond_jackpot_bank(p_pool_id, 'promotional') <> 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_left_diamonds_behind' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('pool_id', p_pool_id, 'into', p_into_pool_id,
                            'moved', v_moved, 'total', v_total, 'ref', v_ref);
END $fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_withdraw(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_allocate(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
DO $post$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_poker_diamond_jackpot_allocate(uuid,bigint)'::regprocedure)) IS DISTINCT FROM '29dab13e9396b3fa6be3e4198ecc09a5'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_poker_diamond_jackpot_withdraw(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '074fa57534baa02572e9ccacc12cbfb4' THEN RAISE EXCEPTION 'diamond_whole_carry_postimage_changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('public.fn_poker_diamond_jackpot_allocate(uuid,bigint)'::regprocedure,'public.fn_poker_diamond_jackpot_withdraw(uuid,uuid)'::regprocedure)
 AND (pg_get_userbyid(proowner) IS DISTINCT FROM 'postgres' OR prosecdef IS DISTINCT FROM true
 OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}')) THEN RAISE EXCEPTION 'diamond_whole_carry_post_security_changed'; END IF;

 IF EXISTS(SELECT 1 FROM public.poker_diamond_jackpot_pools WHERE main_whole_carry<>0 OR backup_whole_carry<>0) THEN RAISE EXCEPTION 'diamond_whole_carry_installation_moved_entitlement'; END IF;
END $post$;
COMMIT;
