BEGIN;
ALTER TABLE public.poker_diamond_jackpot_pools ADD COLUMN main_whole_carry bigint NOT NULL DEFAULT 0 CHECK(main_whole_carry>=0), ADD COLUMN backup_whole_carry bigint NOT NULL DEFAULT 0 CHECK(backup_whole_carry>=0);
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

COMMIT;
