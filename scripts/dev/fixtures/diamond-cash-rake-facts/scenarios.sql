\set ON_ERROR_STOP on
\set VERBOSITY verbose

-- ═══════════════════════════════════════════════════════════════════════════
--  A DIAMOND CASH HAND SETTLES, AND THE RAKE IS THE OWNER'S NUMBER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every payload below is the shape the engine now builds in
-- server/src/engine/ServerTableEngineSettlement.ts (the three rake-fact keys
-- from engine/diamondCashRakeFacts.ts), fed to the settler definition
-- extracted verbatim from migration 20261005183028. The rake is never
-- asserted as a literal alone: each scenario states the schedule it comes
-- from and the assertion recomputes it from the economics rows, so a changed
-- setting moves the expectation with it instead of leaving a stale number.

CREATE FUNCTION pg_temp.assert(p_ok boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_what; END IF;
  RAISE NOTICE 'PASS: %', p_what;
END $a$;

/* One table, N seats, all at one stack. Seat/occupancy ids are derived from
   the table id so each scenario is isolated from every other. */
CREATE FUNCTION pg_temp.stand_up(p_table uuid, p_bb bigint, p_users uuid[], p_stack bigint)
RETURNS void LANGUAGE plpgsql AS $s$
DECLARE i integer;
BEGIN
  INSERT INTO public.tables (id, club_id, big_blind, union_id, tournament_id, game_variant)
  VALUES (p_table,'11111111-1111-1111-1111-111111111111',p_bb,NULL,NULL,'nlh');
  FOR i IN 1..array_length(p_users,1) LOOP
    PERFORM pg_temp.seat(
      p_table, p_users[i],
      md5(p_table::text||':seat:'||i::text)::uuid,
      md5(p_table::text||':occ:'||i::text)::uuid,
      '2026-10-05T01:00:00.000Z'::timestamptz, p_stack, i);
  END LOOP;
END $s$;

/* One roster element in exactly the engine's shape. */
CREATE FUNCTION pg_temp.el(
  p_table uuid, p_index integer, p_user uuid,
  p_before bigint, p_after bigint,
  p_contributed bigint, p_dealt_in boolean, p_saw_flop boolean)
RETURNS jsonb LANGUAGE sql AS $e$
  SELECT jsonb_build_object(
    'user_id', p_user,
    'seat_id', md5(p_table::text||':seat:'||p_index::text)::uuid,
    'seat_joined_at', '2026-10-05T01:00:00.000Z',
    'stack_before', p_before,
    'stack', p_after,
    'contributed', p_contributed,
    'dealt_in', p_dealt_in,
    'hand_saw_flop', p_saw_flop)
$e$;

/* The owner's schedule, recomputed here so the assertions below never carry a
   literal the settings could drift away from. Deliberately a SECOND reading of
   the published rows rather than a copy of the settler's arithmetic: if the two
   disagree, that is the finding. */
CREATE FUNCTION pg_temp.scheduled_rake(p_bb bigint, p_pot bigint, p_dealt integer, p_saw_flop boolean)
RETURNS bigint LANGUAGE plpgsql AS $r$
DECLARE
  v_key text := CASE WHEN p_dealt <= 2 THEN '_heads_up'
                     WHEN p_dealt = 3 THEN '_three_handed' ELSE '' END;
BEGIN
  IF p_dealt < 2 THEN RETURN 0; END IF;
  IF NOT p_saw_flop AND public.fn_ca_diamond_economic_on('cash_rake_no_flop_no_drop','all') THEN
    RETURN 0;
  END IF;
  IF p_pot < public.fn_ca_diamond_economic('cash_rake_min_pot','all') THEN RETURN 0; END IF;
  RETURN least(
    trunc(p_pot::numeric * public.fn_ca_diamond_economic('cash_rake_percent'||v_key,'all') / 100),
    public.fn_ca_diamond_economic('cash_rake_cap'||v_key,'bb:'||p_bb::text))::bigint;
END $r$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCENARIO 1. Three-handed, 1/2, a flop, a pot of 80.
--   percent (three-handed) 10, cap (three-handed, bb:2) 30
--   -> trunc(80 * 10 / 100) = 8, under the cap. Rake 8.
-- The attribution divides evenly: 30/40/10 of 80 -> 3/4/1.
-- ─────────────────────────────────────────────────────────────────────────
SELECT pg_temp.stand_up('aaaa0001-0000-0000-0000-00000000aaaa'::uuid, 2,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002',
        'cccccccc-0000-0000-0000-000000000003']::uuid[], 100);

DO $scenario_1$
DECLARE
  v_t uuid := 'aaaa0001-0000-0000-0000-00000000aaaa';
  v_expected bigint := pg_temp.scheduled_rake(2, 80, 3, true);
  v_stacks jsonb;
  v_receipt jsonb;
BEGIN
  PERFORM pg_temp.assert(v_expected = 8,
    'the published 1/2 three-handed schedule rakes 8 of a flopped pot of 80 (got '||v_expected||')');
  v_stacks := jsonb_build_array(
    pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100, 70,30,true,true),
    pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100,132,40,true,true),
    pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100, 90,10,true,true));
  v_receipt := public.fn_poker_diamond_settle_cash_hand(v_t, 1000001, v_stacks, v_expected, 0, NULL, 0);

  PERFORM pg_temp.assert((v_receipt->>'success')::boolean, 'the hand settles');
  PERFORM pg_temp.assert((v_receipt->>'rake')::bigint = 8, 'the receipt states the rake it took');
  PERFORM pg_temp.assert((v_receipt->>'net_deltas')::bigint = -8,
    'the stacks are short by exactly the rake');
  PERFORM pg_temp.assert((v_receipt->>'rake_accrued')::bigint = 8,
    'every Diamond of rake is attributed to a contributor');
  PERFORM pg_temp.assert(v_receipt->'request'->'rake_facts'->>'pot' = '80',
    'the receipt records the pot the facts declared');
  PERFORM pg_temp.assert(v_receipt->'request'->'rake_facts'->>'dealt' = '3',
    'the receipt records how many were dealt in');
  PERFORM pg_temp.assert(v_receipt->'request'->'rake_facts'->>'saw_flop' = 'true',
    'the receipt records that the hand saw a flop');

  -- The stacks that were written, and the custody that backs them.
  PERFORM pg_temp.assert((SELECT count(*) = 3 FROM public.table_seats ts
    WHERE ts.table_id = v_t AND (
      (ts.user_id='aaaaaaaa-0000-0000-0000-000000000001' AND ts.stack=70) OR
      (ts.user_id='bbbbbbbb-0000-0000-0000-000000000002' AND ts.stack=132) OR
      (ts.user_id='cccccccc-0000-0000-0000-000000000003' AND ts.stack=90))),
    'all three seats hold what the hand said they would');
  PERFORM pg_temp.assert((SELECT count(*) = 3 FROM public.poker_diamond_custody c
    WHERE c.target_id = v_t AND c.balance = (SELECT ts.stack FROM public.table_seats ts
      WHERE ts.id = c.seat_id)), 'custody and seat agree on every balance');

  -- The accrual rows, by WEIGHTED_CONTRIBUTED.
  PERFORM pg_temp.assert((SELECT jsonb_agg(jsonb_build_object('u',user_id,'a',amount) ORDER BY user_id)
      = jsonb_build_array(
          jsonb_build_object('u','aaaaaaaa-0000-0000-0000-000000000001','a',3),
          jsonb_build_object('u','bbbbbbbb-0000-0000-0000-000000000002','a',4),
          jsonb_build_object('u','cccccccc-0000-0000-0000-000000000003','a',1))
     FROM public.ca_diamond_rake_accrual
    WHERE table_id = v_t AND hand_number = 1000001 AND kind = 'rake'),
    'the rake is accrued 3/4/1 in proportion to 30/40/10 of the pot');
  PERFORM pg_temp.assert((SELECT COALESCE(sum(amount),0) = 8
     FROM public.ca_diamond_rake_accrual WHERE table_id = v_t AND hand_number = 1000001),
    'the accrual sums to the rake exactly');

  -- A REDELIVERY MOVES NOTHING TWICE.
  v_receipt := public.fn_poker_diamond_settle_cash_hand(v_t, 1000001, v_stacks, v_expected, 0, NULL, 0);
  PERFORM pg_temp.assert((v_receipt->>'replay')::boolean,
    'the same hand delivered twice returns the first receipt');
  PERFORM pg_temp.assert((SELECT count(*) = 3 FROM public.ca_diamond_rake_accrual
    WHERE table_id = v_t AND hand_number = 1000001), 'the replay accrues nothing a second time');
END $scenario_1$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCENARIO 2. The remainder rule, stated so it can be pinned.
--   Three-handed, 1/2, a flop, a pot of 33 -> trunc(3.3) = 3.
--   Shares: floor(3*10/33)=0, floor(3*13/33)=1, floor(3*10/33)=0 -> 1 placed,
--   2 left over, handed one each by largest remainder (30, 30, 6) with the tie
--   broken by user_id ascending: A and C. Final 1 / 1 / 1.
-- ─────────────────────────────────────────────────────────────────────────
SELECT pg_temp.stand_up('aaaa0002-0000-0000-0000-00000000aaaa'::uuid, 2,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002',
        'cccccccc-0000-0000-0000-000000000003']::uuid[], 100);

DO $scenario_2$
DECLARE
  v_t uuid := 'aaaa0002-0000-0000-0000-00000000aaaa';
  v_expected bigint := pg_temp.scheduled_rake(2, 33, 3, true);
  v_receipt jsonb;
BEGIN
  PERFORM pg_temp.assert(v_expected = 3, 'a flopped pot of 33 rakes 3 (got '||v_expected||')');
  v_receipt := public.fn_poker_diamond_settle_cash_hand(v_t, 1000002,
    jsonb_build_array(
      pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100, 90,10,true,true),
      pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100,117,13,true,true),
      pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100, 90,10,true,true)),
    v_expected, 0, NULL, 0);
  PERFORM pg_temp.assert((v_receipt->>'rake_accrued')::bigint = 3, 'the whole rake is attributed');
  PERFORM pg_temp.assert((SELECT jsonb_agg(amount ORDER BY user_id) = '[1,1,1]'::jsonb
     FROM public.ca_diamond_rake_accrual WHERE table_id = v_t AND hand_number = 1000002),
    'the two leftover Diamonds go to the largest remainders, tie broken by user_id');
END $scenario_2$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCENARIO 3. The one rung that FLOORS. Heads-up at 2/5:
--   percent (heads-up) 5, cap (heads-up, bb:5) 37.
--   A pot of 1000 would pay 50 by percent; the cap holds it to 37.
-- ─────────────────────────────────────────────────────────────────────────
SELECT pg_temp.stand_up('aaaa0003-0000-0000-0000-00000000aaaa'::uuid, 5,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002']::uuid[], 1000);

DO $scenario_3$
DECLARE
  v_t uuid := 'aaaa0003-0000-0000-0000-00000000aaaa';
  v_expected bigint := pg_temp.scheduled_rake(5, 1000, 2, true);
  v_receipt jsonb;
BEGIN
  PERFORM pg_temp.assert(
    trunc(1000 * public.fn_ca_diamond_economic('cash_rake_percent_heads_up','all') / 100) = 50,
    'the heads-up percent alone would have taken 50');
  PERFORM pg_temp.assert(v_expected = 37,
    'the heads-up cap at bb:5 floors the rake at 37 (got '||v_expected||')');
  v_receipt := public.fn_poker_diamond_settle_cash_hand(v_t, 1000003,
    jsonb_build_array(
      pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',1000,1463,500,true,true),
      pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',1000, 500,500,true,true)),
    v_expected, 0, NULL, 0);
  PERFORM pg_temp.assert((v_receipt->>'rake')::bigint = 37, 'the capped rake is what was taken');
  PERFORM pg_temp.assert((v_receipt->>'rake_accrued')::bigint = 37, 'and all of it is attributed');
  PERFORM pg_temp.assert((SELECT jsonb_agg(amount ORDER BY user_id) = '[19,18]'::jsonb
     FROM public.ca_diamond_rake_accrual WHERE table_id = v_t AND hand_number = 1000003),
    'an odd Diamond of a two-way split goes to the lower user_id');
END $scenario_3$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCENARIO 4. NO FLOP, NO DROP. The owner's answer is yes, so a hand that
-- ended before the flop is raked nothing - and this is the case the three
-- keys make verifiable: a zero nobody can check is not a verified zero.
-- ─────────────────────────────────────────────────────────────────────────
SELECT pg_temp.stand_up('aaaa0004-0000-0000-0000-00000000aaaa'::uuid, 2,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002',
        'cccccccc-0000-0000-0000-000000000003']::uuid[], 100);

DO $scenario_4$
DECLARE
  v_t uuid := 'aaaa0004-0000-0000-0000-00000000aaaa';
  v_expected bigint := pg_temp.scheduled_rake(2, 20, 3, false);
  v_receipt jsonb;
BEGIN
  PERFORM pg_temp.assert(v_expected = 0, 'an unflopped pot of 20 rakes nothing');
  v_receipt := public.fn_poker_diamond_settle_cash_hand(v_t, 1000004,
    jsonb_build_array(
      pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100,110,10,true,false),
      pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100, 90,10,true,false),
      pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100,100, 0,true,false)),
    v_expected, 0, NULL, 0);
  PERFORM pg_temp.assert((v_receipt->>'success')::boolean, 'the unraked hand settles');
  PERFORM pg_temp.assert((v_receipt->>'rake')::bigint = 0, 'and takes nothing');
  PERFORM pg_temp.assert((v_receipt->'request'->'rake_facts'->>'saw_flop') = 'false',
    'the receipt records that no flop was dealt');
  PERFORM pg_temp.assert((SELECT count(*) = 0 FROM public.ca_diamond_rake_accrual
    WHERE table_id = v_t AND hand_number = 1000004), 'no accrual row is written for a zero rake');
END $scenario_4$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCENARIO 5. EVERY REFUSAL BRANCH FIRES, AND WRITES NOTHING.
-- The same conserving, correctly-raked hand is used throughout; one fact at a
-- time is removed or corrupted, and the refusal is matched BY NAME.
-- ─────────────────────────────────────────────────────────────────────────
SELECT pg_temp.stand_up('aaaa0005-0000-0000-0000-00000000aaaa'::uuid, 2,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002',
        'cccccccc-0000-0000-0000-000000000003']::uuid[], 100);

CREATE FUNCTION pg_temp.refuses(p_hand bigint, p_stacks jsonb, p_rake numeric, p_name text)
RETURNS void LANGUAGE plpgsql AS $ref$
DECLARE
  v_t uuid := 'aaaa0005-0000-0000-0000-00000000aaaa';
  v_err text;
BEGIN
  BEGIN
    PERFORM public.fn_poker_diamond_settle_cash_hand(v_t, p_hand, p_stacks, p_rake, 0, NULL, 0);
    RAISE EXCEPTION 'FAIL: the settler accepted a hand it must refuse (%)', p_name;
  EXCEPTION WHEN raise_exception OR check_violation OR invalid_parameter_value THEN
    v_err := SQLERRM;
    IF v_err LIKE 'FAIL:%' THEN RAISE; END IF;
    IF position(p_name in v_err) = 0 THEN
      RAISE EXCEPTION 'FAIL: expected % but the settler said: %', p_name, v_err;
    END IF;
  END;
  PERFORM pg_temp.assert((SELECT count(*) = 0 FROM public.poker_diamond_hand_receipts
    WHERE table_id = v_t AND hand_number = p_hand)
    AND (SELECT count(*) = 0 FROM public.ca_diamond_rake_accrual
    WHERE table_id = v_t AND hand_number = p_hand),
    p_name||' refuses and writes nothing');
END $ref$;

DO $scenario_5$
DECLARE
  v_t uuid := 'aaaa0005-0000-0000-0000-00000000aaaa';
  v_good jsonb;
BEGIN
  v_good := jsonb_build_array(
    pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100, 70,30,true,true),
    pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100,132,40,true,true),
    pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100, 90,10,true,true));

  -- (a) a missing key - one per key, each on a different element
  PERFORM pg_temp.refuses(1000101,
    jsonb_set(v_good,'{0}', (v_good->0) - 'contributed'), 8,
    'diamond_cash_rake_facts_required');
  PERFORM pg_temp.refuses(1000102,
    jsonb_set(v_good,'{1}', (v_good->1) - 'dealt_in'), 8,
    'diamond_cash_rake_facts_required');
  PERFORM pg_temp.refuses(1000103,
    jsonb_set(v_good,'{2}', (v_good->2) - 'hand_saw_flop'), 8,
    'diamond_cash_rake_facts_required');
  -- (b) a key of the wrong type, and a contribution that is not whole
  PERFORM pg_temp.refuses(1000104,
    jsonb_set(v_good,'{0,dealt_in}','"yes"'::jsonb), 8,
    'diamond_cash_rake_facts_required');
  PERFORM pg_temp.refuses(1000105,
    jsonb_set(v_good,'{0,contributed}','30.5'::jsonb), 8,
    'diamond_cash_rake_facts_required');
  PERFORM pg_temp.refuses(1000106,
    jsonb_set(v_good,'{0,contributed}','-1'::jsonb), 8,
    'diamond_cash_rake_facts_required');

  -- (c) the elements disagree about the HAND'S own fact. Refused, not resolved.
  PERFORM pg_temp.refuses(1000107,
    jsonb_set(v_good,'{2,hand_saw_flop}','false'::jsonb), 8,
    'diamond_cash_rake_facts_disagree');

  -- (d) a player who contributed cannot have been sitting out
  PERFORM pg_temp.refuses(1000108,
    jsonb_set(v_good,'{0,dealt_in}','false'::jsonb), 8,
    'diamond_cash_rake_facts_disagree');

  -- (e) a player cannot lose more than they put in
  PERFORM pg_temp.refuses(1000109,
    jsonb_set(v_good,'{0,contributed}','29'::jsonb), 8,
    'diamond_cash_rake_facts_disagree');

  -- (f) THE ENGINE'S NUMBER IS NOT TAKEN ON TRUST. Each of these payloads
  -- CONSERVES at the rake it declares - the stacks are short by exactly that
  -- much - so the only thing wrong with it is that the owner's schedule says
  -- a different number for this pot. Conservation is checked first, so a
  -- payload that did not conserve would fail for the wrong reason and prove
  -- nothing about the recompute.
  PERFORM pg_temp.refuses(1000110, jsonb_build_array(
      pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100, 70,30,true,true),
      pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100,133,40,true,true),
      pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100, 90,10,true,true)),
    7, 'diamond_cash_rake_disagrees');
  PERFORM pg_temp.refuses(1000111, jsonb_build_array(
      pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100, 70,30,true,true),
      pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100,131,40,true,true),
      pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100, 90,10,true,true)),
    9, 'diamond_cash_rake_disagrees');
  -- An engine that silently stopped raking is refused as loudly as one that
  -- raked too much. This is the whole reason the facts are required whenever
  -- the switch is on rather than only when p_rake is non-zero.
  PERFORM pg_temp.refuses(1000112, jsonb_build_array(
      pg_temp.el(v_t,1,'aaaaaaaa-0000-0000-0000-000000000001',100, 70,30,true,true),
      pg_temp.el(v_t,2,'bbbbbbbb-0000-0000-0000-000000000002',100,140,40,true,true),
      pg_temp.el(v_t,3,'cccccccc-0000-0000-0000-000000000003',100, 90,10,true,true)),
    0, 'diamond_cash_rake_disagrees');

  -- (g) and the good payload, on this same table, still settles - so every
  -- refusal above is the fact under test and not the fixture.
  PERFORM pg_temp.assert(
    (public.fn_poker_diamond_settle_cash_hand(v_t,1000113,v_good,8,0,NULL,0)->>'rake_accrued')::bigint = 8,
    'the unmutated payload settles on the very table every refusal was tried on');
END $scenario_5$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCENARIO 6. THE FACTS ARE REQUIRED BECAUSE THE SWITCH IS ON, not because a
-- rake was taken. A hand that would be raked nothing anyway is STILL refused
-- without them: an engine that silently stopped sending them would otherwise
-- settle every hand without a word.
-- ─────────────────────────────────────────────────────────────────────────
SELECT pg_temp.stand_up('aaaa0006-0000-0000-0000-00000000aaaa'::uuid, 2,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002']::uuid[], 100);

DO $scenario_6$
DECLARE
  v_t uuid := 'aaaa0006-0000-0000-0000-00000000aaaa';
  v_err text;
BEGIN
  BEGIN
    PERFORM public.fn_poker_diamond_settle_cash_hand(v_t, 1000201,
      jsonb_build_array(
        jsonb_build_object('user_id','aaaaaaaa-0000-0000-0000-000000000001',
          'seat_id', md5(v_t::text||':seat:1')::uuid,
          'seat_joined_at','2026-10-05T01:00:00.000Z','stack_before',100,'stack',90),
        jsonb_build_object('user_id','bbbbbbbb-0000-0000-0000-000000000002',
          'seat_id', md5(v_t::text||':seat:2')::uuid,
          'seat_joined_at','2026-10-05T01:00:00.000Z','stack_before',100,'stack',110)),
      0, 0, NULL, 0);
    RAISE EXCEPTION 'FAIL: a zero-rake hand settled without its facts';
  EXCEPTION WHEN raise_exception OR check_violation OR invalid_parameter_value THEN
    v_err := SQLERRM;
    IF v_err LIKE 'FAIL:%' THEN RAISE; END IF;
    PERFORM pg_temp.assert(position('diamond_cash_rake_facts_required' in v_err) > 0,
      'the roster the engine sent BEFORE this change is refused by name (got: '||v_err||')');
  END;
END $scenario_6$;

\echo 'PASS: the engine payload settles a Diamond cash hand, the rake is the owner''s number, and every refusal branch fires'
