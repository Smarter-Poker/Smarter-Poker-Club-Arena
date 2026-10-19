-- 20261007015026_a_diamond_jackpot_hit_pays_every_diamond_it_announces.sql
--
-- OWNER DECISION 5 OF THE LAUNCH CHECKLIST: THE DIAMOND PAYOUT LADDER'S
-- LEFTOVERS. Decided by Claude under CLAUDE.md 10.9 on Dan's delegation
-- ("THESE ARE ALL YOURS TO FINISH UP AND DECIDE", 2026-10-07).
--
-- WHAT WAS LEFT OVER. fn_poker_diamond_jackpot_pay (20261005152000) floors
-- the loser's half, the winner's quarter and each table share separately and
-- left whatever the floors could not allocate in the main pool. Its own
-- acceptance case shows it: a hit announced as 105 Diamonds paid 104 and kept
-- 1. The chip jackpot never does that: bbj_atomic_payout_v2 pays the whole
-- announced total and gives the table remainder to the losing hand.
--
-- THE DECISION. A Diamond hit pays every Diamond it announces, by the chip
-- rule: the paid total is floored once from the main pool (that floor is the
-- only rounding, and what it leaves is still the jackpot, never a person's),
-- the winner's share and each table share floor, and every leftover Diamond
-- goes to the losing hand. Horses are paid on the same terms (CLAUDE.md 10.5).
-- The door now refuses to finish a hit that paid anything other than its
-- announced total.
--
-- WHAT IS OWED HISTORICALLY: NOTHING. poker_diamond_jackpot_ledger held no
-- payout row on 2026-10-07 (read before this was written), so no hit has ever
-- been paid short and nobody is owed a back payment.
--
-- ASSERTED SUBSTITUTION. The live body is the 20261005152000 body, md5
-- 24b540141853cc8c246cd4dfc121ebc4 (read 2026-10-07). This file refuses to
-- replace anything else. CREATE OR REPLACE keeps the ACL {postgres=X/postgres}.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])'::regprocedure)
     IS DISTINCT FROM '24b540141853cc8c246cd4dfc121ebc4' THEN
    RAISE EXCEPTION 'fn_poker_diamond_jackpot_pay is not the 20261005152000 body this file replaces';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_pay(
  p_table_id uuid, p_hand_number bigint, p_pot numeric, p_players_dealt integer,
  p_loser_user_id uuid, p_winner_user_id uuid, p_table_user_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pool uuid; v_ref text; v_bb numeric; v_variant text; v_scope text;
  v_main bigint; v_pct numeric; v_paid bigint; v_shares text;
  v_loser bigint; v_winner bigint; v_table_total bigint;
  v_others uuid[]; v_n integer; v_each bigint; v_remainder bigint;
  v_rec record; v_credit jsonb; v_key text; v_inserted integer;
  v_paid_out bigint := 0; v_legs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_ca_diamond_economic_on('bbj_enabled') THEN
    RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE = '55000';
  END IF;
  IF p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'diamond_jackpot_needs_a_loser_and_a_winner' USING ERRCODE = '23514';
  END IF;

  SELECT t.big_blind, t.game_variant INTO v_bb, v_variant
    FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE = '23514';
  END IF;
  v_scope := public.fn_poker_diamond_jackpot_stake_scope(v_bb);

  -- B16: a game with no jackpot can never win one.
  IF NOT public.fn_poker_diamond_jackpot_game_qualifies(v_variant) THEN
    RAISE EXCEPTION 'diamond_jackpot_game_has_no_jackpot:%', v_variant USING ERRCODE = '23514';
  END IF;
  -- B15's symmetry: a stake that drops nothing can never hit.
  IF public.fn_ca_diamond_economic('bbj_drop_per_hand', v_scope) <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_stake_drops_nothing:%', v_scope USING ERRCODE = '23514';
  END IF;
  -- B17, the payout gates. The pot floor is a payout floor and only ever that.
  IF p_players_dealt IS NULL
     OR p_players_dealt < public.fn_ca_diamond_economic('bbj_min_dealt_in') THEN
    RAISE EXCEPTION 'diamond_jackpot_too_few_dealt_in:%', p_players_dealt USING ERRCODE = '23514';
  END IF;
  -- bbj_min_pot is recorded in DIAMONDS, per stake: ten big blinds of a
  -- whole-Diamond blind is a whole number of Diamonds, so the floor is stored
  -- as the figure the door compares against rather than as a multiplier the
  -- door would have to apply.
  IF p_pot IS NULL
     OR p_pot <= public.fn_ca_diamond_economic('bbj_min_pot', v_scope) THEN
    RAISE EXCEPTION 'diamond_jackpot_pot_below_the_payout_floor:%', p_pot USING ERRCODE = '23514';
  END IF;

  v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id = v_pool FOR UPDATE;
  v_ref := 'bbjpay:' || p_table_id::text || ':' || p_hand_number::text;

  -- A REPLAY RETURNS WHAT IT PAID THE FIRST TIME AND PAYS NOTHING.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_ledger
              WHERE ref = v_ref AND kind = 'payout') THEN
    SELECT jsonb_build_object('replay', true, 'pool_id', v_pool, 'ref', v_ref,
             'paid', -COALESCE(sum(amount), 0),
             'legs', COALESCE(jsonb_agg(jsonb_build_object('role', recipient_role,
                        'user_id', recipient_user_id, 'amount', -amount) ORDER BY id), '[]'::jsonb))
      INTO v_credit FROM public.poker_diamond_jackpot_ledger
     WHERE ref = v_ref AND kind = 'payout';
    RETURN v_credit;
  END IF;

  v_main := public.fn_poker_diamond_jackpot_bank(v_pool, 'main');
  -- B19 is one shares answer per stake: what is paid, and how it divides.
  v_shares := public.fn_ca_diamond_economic_text('bbj_hit_shares', v_scope);
  v_pct  := public.fn_poker_diamond_jackpot_share(v_shares, 1, 'paid');
  -- B19, in whole Diamonds. The paid total is floored once, and then EVERY
  -- Diamond of it is paid: the winner's share and each table share floor,
  -- and whatever the floors leave goes to the losing hand, the chip jackpot's
  -- own rule (bbj_atomic_payout_v2 adds the table remainder to the loser).
  -- A hit that announces 105 pays 105 (owner decision, 2026-10-07).
  v_paid   := floor(v_main * v_pct / 100)::bigint;
  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_pays_nothing_yet:main=%', v_main USING ERRCODE = '23514';
  END IF;
  v_loser  := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'loser')  / 100)::bigint;
  v_winner := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'winner') / 100)::bigint;
  v_table_total := v_paid - v_loser - v_winner;

  -- The rest of the table: everybody dealt in who is neither the loser nor the
  -- winner. Horses among them, on the same terms, never filtered out.
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), '{}'::uuid[]) INTO v_others
    FROM unnest(COALESCE(p_table_user_ids, '{}'::uuid[])) u
   WHERE u IS DISTINCT FROM p_loser_user_id AND u IS DISTINCT FROM p_winner_user_id;
  v_n := COALESCE(array_length(v_others, 1), 0);
  IF v_n > 0 THEN
    v_each := (v_table_total / v_n)::bigint;
  ELSE
    v_each := 0;
  END IF;
  v_remainder := v_table_total - v_each * v_n;
  -- The leftover Diamonds of the ladder are the losing hand's, as in chips.
  v_loser := v_loser + v_remainder;

  -- One credit and one ledger leg per recipient.
  FOR v_rec IN
    SELECT p_loser_user_id AS user_id, 'loser'::text AS role, v_loser AS amount
    UNION ALL SELECT p_winner_user_id, 'winner', v_winner
    UNION ALL SELECT u, 'table', v_each FROM unnest(v_others) u
  LOOP
    CONTINUE WHEN v_rec.amount <= 0;
    v_key := v_ref || ':' || v_rec.role || ':' || v_rec.user_id::text;
    INSERT INTO public.wallet_credit_idempotency(key, user_id, amount)
    VALUES (v_key, v_rec.user_id, v_rec.amount) ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_key_already_claimed:%', v_key USING ERRCODE = '23505';
    END IF;
    v_credit := public.add_diamonds_to_balance(
      v_rec.user_id, v_rec.amount::integer, 'arena_withdraw',
      'Diamond Arena Bad Beat Jackpot', v_key);
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE
       OR NULLIF(v_credit->>'transaction_id', '') IS NULL THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_failed:%', v_credit->>'error' USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.poker_diamond_jackpot_ledger(
      pool_id, bank, kind, amount, table_id, hand_number,
      recipient_user_id, recipient_role, wallet_journal_id, ref, note)
    VALUES (v_pool, 'main', 'payout', -v_rec.amount, p_table_id, p_hand_number,
            v_rec.user_id, v_rec.role, (v_credit->>'transaction_id')::uuid, v_ref,
            'bad beat jackpot hit, ' || v_rec.role || ' share');
    v_paid_out := v_paid_out + v_rec.amount;
    v_legs := v_legs || jsonb_build_object('role', v_rec.role, 'user_id', v_rec.user_id,
                                           'amount', v_rec.amount);
  END LOOP;

  IF v_paid_out <> v_paid THEN
    RAISE EXCEPTION 'diamond_jackpot_paid_other_than_it_announced:% of %', v_paid_out, v_paid
      USING ERRCODE = '23514';
  END IF;
  IF public.fn_poker_diamond_jackpot_bank(v_pool, 'main') < 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_main_bank_went_negative' USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'pool_id', v_pool, 'ref', v_ref, 'main_before', v_main, 'payout_percent', v_pct,
    'paid_total', v_paid, 'paid_out', v_paid_out,
    'left_in_main_pool', v_paid - v_paid_out,
    'loser', v_loser, 'winner', v_winner, 'table_total', v_table_total,
    'table_each', v_each, 'table_remainder_to_loser', v_remainder,
    'qualifying_hand', public.fn_poker_diamond_jackpot_qualifying_hand(v_variant),
    'legs', v_legs);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_pay(uuid, bigint, numeric, integer, uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE v_src text; v_acl text;
BEGIN
  SELECT prosrc, proacl::text INTO v_src, v_acl FROM pg_proc
   WHERE oid = 'public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])'::regprocedure;
  IF position('v_loser := v_loser + v_remainder;' IN v_src) = 0
     OR position('diamond_jackpot_paid_other_than_it_announced' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the leftover rule did not land';
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'fn_poker_diamond_jackpot_pay ACL moved: %', v_acl;
  END IF;
END $post$;

COMMIT;
