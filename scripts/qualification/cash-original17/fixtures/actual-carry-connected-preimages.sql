BEGIN;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_share(
  p_shares text, p_segment integer, p_key text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $fn$
DECLARE v_seg text; v_hit text[];
BEGIN
  IF p_shares IS NULL OR p_segment IS NULL OR p_segment < 1 OR p_key IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_unreadable' USING ERRCODE = '22023';
  END IF;
  v_seg := btrim(split_part(p_shares, ';', p_segment));
  IF v_seg = '' THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_have_no_segment_%:%', p_segment, p_shares
      USING ERRCODE = '22023';
  END IF;
  IF v_seg !~ '^[a-z_]+=[0-9]+(,[a-z_]+=[0-9]+)*$' THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_malformed:%', v_seg USING ERRCODE = '22023';
  END IF;
  v_hit := regexp_match(v_seg, '(?:^|,)' || p_key || '=([0-9]+)(?:,|$)');
  IF v_hit IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_missing:%/%', p_key, v_seg USING ERRCODE = '22023';
  END IF;
  RETURN v_hit[1]::numeric;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_share(text, integer, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_stake_scope(p_big_blind numeric)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_big_blind IS NULL OR p_big_blind <= 0 OR p_big_blind <> trunc(p_big_blind) THEN
    RAISE EXCEPTION 'diamond_jackpot_stake_is_not_whole_diamonds:%', p_big_blind
      USING ERRCODE = '23514';
  END IF;
  RETURN 'bb:' || trunc(p_big_blind)::bigint::text;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_stake_scope(numeric)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_drop_due(p_table_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_bb numeric; v_variant text;
BEGIN
  SELECT t.big_blind, t.game_variant INTO v_bb, v_variant
    FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE = '23514';
  END IF;
  -- A game with no jackpot drops nothing and can never win one (B16).
  IF NOT public.fn_poker_diamond_jackpot_game_qualifies(v_variant) THEN
    RETURN 0;
  END IF;
  RETURN public.fn_ca_diamond_economic('bbj_drop_per_hand',
           public.fn_poker_diamond_jackpot_stake_scope(v_bb))::bigint;
END $fn$;

-- A SECURITY DEFINER READER IS NOT HARMLESS BECAUSE IT IS A READER. This one
-- runs past RLS and never asks who is calling, so no pre-login role and no
-- logged-in player may reach it: what a stake owes the jackpot is published on
-- the table, not read out of a money door.
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_drop_due(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_drop(
  p_table_id uuid, p_hand_number bigint, p_amount bigint, p_stacks jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pool uuid; v_ref text;
  v_main bigint; v_backup bigint; v_promotional bigint;
  v_losses numeric;
  v_shares jsonb := '{}'::jsonb; v_rows integer := 0;
  v_bank_of jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_must_be_a_whole_positive_diamond:%', p_amount
      USING ERRCODE = '23514';
  END IF;
  v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  v_ref := 'bbjdrop:' || p_table_id::text || ':' || p_hand_number::text;

  SELECT * INTO v_main, v_backup, v_promotional
    FROM public.fn_poker_diamond_jackpot_allocate(v_pool, p_amount);
  v_bank_of := jsonb_build_object('main', v_main, 'backup', v_backup, 'promotional', v_promotional);

  SELECT COALESCE(sum(greatest((x->>'stack_before')::numeric - (x->>'stack')::numeric, 0)), 0)
    INTO v_losses FROM jsonb_array_elements(p_stacks) x;
  IF v_losses <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_has_no_payer' USING ERRCODE = '23514';
  END IF;

  -- One ledger row per payer per bank. Every bank's rows sum to that bank's
  -- share of the drop, and the three shares sum to the drop. The remainder of
  -- each bank's division goes to the largest loser first, ties by the lower
  -- user_id: deterministic, and the same order the settler's roster carries.
  INSERT INTO public.poker_diamond_jackpot_ledger(
    pool_id, bank, kind, amount, table_id, hand_number, payer_user_id, ref, note)
  SELECT v_pool, a.bank, 'drop', a.share, p_table_id, p_hand_number, a.user_id, v_ref,
         'bad beat jackpot drop, attributed by loss'
    FROM (
      SELECT p.bank, p.user_id,
             p.floored
             + CASE WHEN p.rank <= p.bank_amount - p.floored_total THEN 1 ELSE 0 END AS share
        FROM (
          SELECT b.bank, b.bank_amount, s.user_id,
                 floor(b.bank_amount * s.loss / v_losses)::bigint AS floored,
                 sum(floor(b.bank_amount * s.loss / v_losses)::bigint)
                   OVER (PARTITION BY b.bank) AS floored_total,
                 row_number() OVER (PARTITION BY b.bank ORDER BY s.loss DESC, s.user_id) AS rank
            FROM (SELECT key AS bank, value::text::bigint AS bank_amount
                    FROM jsonb_each(v_bank_of) WHERE value::text::bigint > 0) b
            CROSS JOIN (
              SELECT (x->>'user_id')::uuid AS user_id,
                     greatest((x->>'stack_before')::numeric - (x->>'stack')::numeric, 0) AS loss
                FROM jsonb_array_elements(p_stacks) x
               WHERE greatest((x->>'stack_before')::numeric - (x->>'stack')::numeric, 0) > 0) s
        ) p
    ) a
   WHERE a.share > 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF (SELECT COALESCE(sum(l.amount), 0) FROM public.poker_diamond_jackpot_ledger l
       WHERE l.ref = v_ref AND l.kind = 'drop') <> p_amount THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_does_not_conserve' USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_object_agg(l.bank, s) INTO v_shares
    FROM (SELECT bank, sum(amount) AS s FROM public.poker_diamond_jackpot_ledger
           WHERE ref = v_ref AND kind = 'drop' GROUP BY bank) l(bank, s);

  RETURN jsonb_build_object('pool_id', v_pool, 'amount', p_amount, 'ref', v_ref,
                            'banks', COALESCE(v_shares, '{}'::jsonb), 'rows', v_rows);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_drop(uuid, bigint, bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_bank(p_pool_id uuid, p_bank text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
  SELECT COALESCE(sum(l.amount), 0)::bigint
    FROM public.poker_diamond_jackpot_ledger l
   WHERE l.pool_id = p_pool_id AND l.bank = p_bank;
$fn$;

-- Every Diamond the jackpot holds, over every pool and every bank. This is the
-- number fn_ca_arena_diamonds() adds, so the identity sees the pool.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_diamonds()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
  SELECT COALESCE(sum(l.amount), 0)::numeric FROM public.poker_diamond_jackpot_ledger l;
$fn$;

-- The pool a Diamond cash table drops into: its arena's one active pool. A
-- table that is not a plain Diamond cash table has no pool, and the caller
-- refuses rather than inventing one.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_pool_for_table(p_table_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
  SELECT j.id
    FROM public.tables t
    JOIN public.clubs c ON c.id = t.club_id
    JOIN public.poker_diamond_jackpot_pools j ON j.arena_id = c.id AND j.status = 'active'
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
$fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_bank(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_diamonds() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_pool_for_table(uuid) FROM PUBLIC, anon, authenticated;
COMMIT;
