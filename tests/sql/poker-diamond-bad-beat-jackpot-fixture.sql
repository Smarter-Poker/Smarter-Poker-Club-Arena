-- The delta the Diamond bad beat jackpot needs on top of the Phase 3 custody
-- base and the cash custody setup. Everything here exists in production; it is
-- restated at fixture scale so the migration under test meets the same shapes.
--
-- Nothing in this file is part of the migration. The migration is loaded
-- verbatim, unnarrowed, after this.

-- The arena switches. Production reads cash_games_enabled false and
-- tournaments_enabled true on 2026-10-05, and the migration asserts exactly
-- that pair, so the fixture carries it.
ALTER TABLE public.ca_arena_settings
  ADD COLUMN cash_games_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN tournaments_enabled boolean NOT NULL DEFAULT true;

-- A Diamond cash table has blinds. The base fixture's `tables` had none.
ALTER TABLE public.tables
  ADD COLUMN small_blind numeric,
  ADD COLUMN big_blind numeric;
UPDATE public.tables SET small_blind = 5000, big_blind = 10000
 WHERE id = '30000000-0000-0000-0000-000000000001';

-- A HORSE IS A PROFILE LIKE ANYBODY ELSE. The column exists here only so the
-- fixture can prove that a horse is paid a jackpot share on the same terms a
-- human is (CLAUDE.md 10.5). No Diamond jackpot door reads it, and the
-- migration's own final block refuses any door that does.
ALTER TABLE public.profiles ADD COLUMN is_horse boolean NOT NULL DEFAULT false;

-- The wallet credit key, as the chip credit claims it.
CREATE TABLE IF NOT EXISTS public.wallet_credit_idempotency(
  key text PRIMARY KEY, user_id uuid, amount numeric,
  created_at timestamptz NOT NULL DEFAULT now());

-- add_diamonds_to_balance is NOT restated here. The Phase 3 base loads the
-- real one from 20260909065458_poker_diamond_custody.sql, which already names
-- 'arena_withdraw' among its exact types, so the jackpot payout goes through
-- the estate's own credit door and not through a fixture stand-in.

-- ---------------------------------------------------------------------------
-- THE PRODUCTION PREIMAGES THE MIGRATION'S ASSERTED SUBSTITUTIONS MEET
-- ---------------------------------------------------------------------------
-- fn_poker_diamond_settle_cash_hand is edited IN PLACE by 20260912061500 and
-- 20260912070000, so the repository's own 20260910022036 text is two edits
-- behind what production runs (md5 70973e9f... here against 3aab9170... there),
-- and neither of those two migrations loads on this base without a large
-- amount of unrelated cluster scaffolding. The production text is therefore
-- installed VERBATIM below, read from kuklfnapbkmacvwxktbh on 2026-10-05
-- through pg_get_functiondef, and pinned by its md5. What the migration then
-- rewrites in this fixture is byte for byte what it rewrites in production.
--
-- fn_poker_diamond_cash_variant comes with it, because the settler calls it and
-- it arrives in 20260912070000.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cash_variant(p_variant text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* NULL-SAFE ON PURPOSE. `NULL IN (...)` is NULL, not false, so without the
     first clause an unset `game_variant` made the whole plain-cash rule return
     NULL rather than false: a row that is neither admitted nor refused. Every
     caller today happens to treat unknown as refusal, which is exactly the
     kind of accident that holds until one of them writes `IF fn(...) = false`.
     An unset game is not a game. */
  SELECT p_variant IS NOT NULL
     AND p_variant IN ('nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8');
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_settle_cash_hand(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid;
  v_request jsonb;
  v_stacks jsonb;
  v_prior public.poker_diamond_hand_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_seat public.table_seats%ROWTYPE;
  v_e jsonb;
  v_lot record;
  v_before bigint;
  v_after bigint;
  v_loss bigint;
  v_take bigint;
  v_written jsonb := '{}'::jsonb;
  v_result jsonb;
BEGIN
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_rake,0) <> 0 OR COALESCE(p_bbj,0) <> 0
     OR COALESCE(p_inflow,0) <> 0 THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'diamond_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_stacks) < 2 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
       OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'diamond_exact_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE NOT pg_input_is_valid(x->>'user_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_joined_at','timestamp with time zone')
       OR (x->>'stack')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack_before')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack')::numeric <> trunc((x->>'stack')::numeric)
       OR (x->>'stack_before')::numeric <> trunc((x->>'stack_before')::numeric)
  ) OR (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid)
         OR count(*) <> count(DISTINCT (x->>'seat_id')::uuid)
        FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'diamond_invalid_hand_amount_or_generation' USING ERRCODE='22023';
  END IF;
  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> 0 THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;

  SELECT t.club_id INTO v_arena FROM public.tables t
  JOIN public.clubs c ON c.id=t.club_id
  WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
    AND c.union_id IS NULL AND t.union_id IS NULL
    AND t.tournament_id IS NULL AND public.fn_poker_diamond_cash_variant(t.game_variant)
  FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'user_id',(x->>'user_id')::uuid, 'seat_id',(x->>'seat_id')::uuid,
    'seat_joined_at',(x->>'seat_joined_at')::timestamptz,
    'stack_before',(x->>'stack_before')::bigint, 'stack',(x->>'stack')::bigint)
    ORDER BY (x->>'user_id')::uuid) INTO v_stacks
    FROM jsonb_array_elements(p_stacks) x;
  v_request := jsonb_build_object('stacks',v_stacks,'ref',p_ref,
    'rake',p_rake,'bbj',p_bbj,'inflow',p_inflow);

  SELECT * INTO v_prior FROM public.poker_diamond_hand_receipts
    WHERE table_id=p_table_id AND hand_number=p_hand_number;
  IF FOUND THEN
    IF v_prior.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'diamond_hand_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replay',true);
  END IF;

  -- Match the wallet/refund lock order before touching purchase lots.
  PERFORM p.id FROM public.profiles p
    JOIN jsonb_array_elements(v_stacks) x ON (x->>'user_id')::uuid=p.id
    ORDER BY p.id FOR UPDATE OF p;
  -- Validate the entire roster while locks are held before changing one balance.
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO v_seat FROM public.table_seats
      WHERE id=(v_e->>'seat_id')::uuid AND table_id=p_table_id
        AND user_id=(v_e->>'user_id')::uuid
        AND joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND left_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_seat.stack IS DISTINCT FROM (v_e->>'stack_before')::numeric THEN
      RAISE EXCEPTION 'diamond_hand_stale_seat' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody
      WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
        AND seat_joined_at=v_seat.joined_at AND user_id=v_seat.user_id
        AND target_id=p_table_id AND arena_id=v_arena
        AND purpose='cash_seat' AND state='active' FOR UPDATE;
    IF NOT FOUND OR v_c.balance IS DISTINCT FROM (v_e->>'stack_before')::bigint THEN
      RAISE EXCEPTION 'diamond_hand_custody_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;

  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO STRICT v_c FROM public.poker_diamond_custody
      WHERE seat_id=(v_e->>'seat_id')::uuid
        AND seat_joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND user_id=(v_e->>'user_id')::uuid AND target_id=p_table_id AND state='active';
    v_before := (v_e->>'stack_before')::bigint;
    v_after := (v_e->>'stack')::bigint;
    v_loss := greatest(v_before-v_after,0);
    FOR v_lot IN
      SELECT l.id,r.amount-r.consumed AS held,
        greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
      WHERE r.custody_id=v_c.id AND r.released_at IS NULL
      ORDER BY l.created_at,l.id FOR UPDATE OF l,r
    LOOP
      EXIT WHEN v_loss=0;
      v_take := least(v_loss,v_lot.held);
      IF v_take>0 THEN
        -- A provider reversal may already have retired this liability.
        -- Remove the hold once; consume only liability still outstanding.
        UPDATE public.diamond_purchase_lots
          SET arena_reserved=arena_reserved-v_take,
              consumed=consumed+least(v_take,v_lot.outstanding)::integer
          WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations
          SET consumed=consumed+v_take
          WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss-v_take;
      END IF;
    END LOOP;
    UPDATE public.poker_diamond_custody SET balance=v_after WHERE id=v_c.id;
    UPDATE public.table_seats SET stack=v_after
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM public.table_seats
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL AND stack=v_after) THEN
      RAISE EXCEPTION 'diamond_hand_seat_write_failed' USING ERRCODE='23514';
    END IF;
    v_written := v_written || jsonb_build_object(v_c.user_id::text,v_after);
  END LOOP;
  v_result := jsonb_build_object('success',true,'asset','diamonds',
    'players',jsonb_array_length(v_stacks),'table_id',p_table_id,
    'hand_id',md5('ca-hand:'||p_table_id||':'||p_hand_number
      ||CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END)::uuid,
    'hand_number',p_hand_number,'net_deltas',0,'rake',p_rake,'bbj',p_bbj,
    'inflow',p_inflow,'mode','delta','rebased','{}'::jsonb,
    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'request',v_request);
  INSERT INTO public.poker_diamond_hand_receipts(table_id,hand_number,request,receipt)
    VALUES(p_table_id,p_hand_number,v_request,v_result);
  RETURN v_result;
END $function$
;

DO $pin$
DECLARE v_md5 text;
BEGIN
  v_md5 := md5(pg_get_functiondef(
    'public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure));
  IF v_md5 <> '3aab9170062e97840afc7d15999691ad' THEN
    RAISE EXCEPTION 'the fixture did not install the production preimage of the Diamond settler (md5 %)', v_md5;
  END IF;
  RAISE NOTICE 'PASS: the fixture carries the production preimage of fn_poker_diamond_settle_cash_hand, md5 3aab9170062e97840afc7d15999691ad';
END $pin$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- The arena float, as production defines it on 2026-10-05, byte for byte. The
-- migration's asserted substitution pins md5 86863a1208455e92803777829bc9a668
-- and the fixture base carries the older custody-only text, so the production
-- PREIMAGE is installed here. What the migration then rewrites in the fixture
-- is the same text it rewrites in production.
CREATE TABLE IF NOT EXISTS public.diamond_spin_days(
  id bigserial PRIMARY KEY, status text, pending_diamonds numeric);
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open');
$function$;
DO $pin$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_arena_diamonds()'::regprocedure))
     <> '86863a1208455e92803777829bc9a668' THEN
    RAISE EXCEPTION 'the fixture did not install the production preimage of fn_ca_arena_diamonds (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_arena_diamonds()'::regprocedure));
  END IF;
  RAISE NOTICE 'PASS: the fixture carries the production preimage of fn_ca_arena_diamonds, md5 86863a1208455e92803777829bc9a668';
END $pin$;

-- The two chip jackpot tables the migration fences. They accept a Diamond
-- Arena row today and hold 0 such rows; here they exist so the fence can be
-- attached and then PROVED to refuse one.
CREATE TABLE IF NOT EXISTS public.bbj_pools(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, union_id uuid,
  main_balance numeric DEFAULT 0, backup_balance numeric DEFAULT 0,
  promo_balance numeric DEFAULT 0, status text DEFAULT 'active');
CREATE TABLE IF NOT EXISTS public.bbj_contributions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, union_id uuid,
  amount numeric, created_at timestamptz DEFAULT now());

-- Two more seats, so a hand has four players dealt in and a hit has a loser, a
-- winner and a REST OF THE TABLE. One of them is a horse.
INSERT INTO public.profiles(id, diamonds, is_horse) VALUES
  ('10000000-0000-0000-0000-000000000003', 100000, false),
  ('10000000-0000-0000-0000-000000000004', 100000, true);
INSERT INTO public.diamond_purchase_lots(user_id, issued, created_at) VALUES
  ('10000000-0000-0000-0000-000000000003', 100000, now() - interval '30 days'),
  ('10000000-0000-0000-0000-000000000004', 100000, now() - interval '30 days');
CREATE TEMP TABLE bbj_extra_custody AS
 SELECT '10000000-0000-0000-0000-000000000003'::uuid AS user_id,
  public.fn_poker_diamond_reserve('10000000-0000-0000-0000-000000000003', 'cash_seat',
   '30000000-0000-0000-0000-000000000001', 'game-c', 300,
   '40000000-0000-0000-0000-000000000004') AS receipt;
INSERT INTO bbj_extra_custody
 SELECT '10000000-0000-0000-0000-000000000004'::uuid,
  public.fn_poker_diamond_reserve('10000000-0000-0000-0000-000000000004', 'cash_seat',
   '30000000-0000-0000-0000-000000000001', 'game-d', 300,
   '40000000-0000-0000-0000-000000000005');
INSERT INTO public.table_seats(id, table_id, user_id, seat_number, stack, joined_at, club_id)
 SELECT (receipt->>'custody_id')::uuid, '30000000-0000-0000-0000-000000000001',
        user_id, 2 + row_number() OVER (ORDER BY user_id), 300, '2026-09-10T01:00:00Z',
        '20000000-0000-0000-0000-000000000001'
   FROM bbj_extra_custody;
UPDATE public.poker_diamond_custody c SET state = 'active', seat_id = s.id,
       seat_joined_at = s.joined_at, occupancy_id = s.occupancy_id
  FROM public.table_seats s WHERE c.id = s.id AND c.state <> 'active';

-- ---------------------------------------------------------------------------
-- THE FIXTURE'S OWN MONEY IDENTITY
-- ---------------------------------------------------------------------------
-- The migration ends on fn_ca_diamond_register_vs_supply().difference = 0,
-- which is the assertion every Diamond migration ends on. The Phase 3 base
-- creates its profiles with balances and never registers them, so the fixture
-- owes the register the Diamonds its own players hold. One baseline mint row
-- per player, for everything that player holds right now - in the wallet and
-- in custody - makes the identity whole here the way it is already whole in
-- production (read 2026-10-05: register 5,357,442, players 5,324,242, house 0,
-- arena 33,200, difference 0). After this the assertion is measuring what it
-- is meant to measure: whether THIS MIGRATION broke the identity.
INSERT INTO public.ca_mint_ledger(op_id, action, asset, holder_type, holder_id, amount, reason)
SELECT 'fixture:bbj:baseline:' || p.id::text, 'mint', 'diamonds', 'player', p.id,
       p.diamonds + COALESCE(c.held, 0),
       'fixture baseline: the register learns what this player already holds'
  FROM public.profiles p
  LEFT JOIN (SELECT user_id, sum(balance) AS held FROM public.poker_diamond_custody
              WHERE state = 'active' GROUP BY user_id) c ON c.user_id = p.id
 WHERE p.diamonds + COALESCE(c.held, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.holder_id = p.id);
DO $identity$
DECLARE v_diff numeric;
BEGIN
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF COALESCE(v_diff, 0) <> 0 THEN
    RAISE EXCEPTION 'the fixture starts with a broken identity: difference %', v_diff;
  END IF;
  RAISE NOTICE 'PASS: the fixture starts with the Diamond identity whole, so the migration''s final assertion measures the migration';
END $identity$;
