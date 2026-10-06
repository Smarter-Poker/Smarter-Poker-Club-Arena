\set ON_ERROR_STOP on
\set VERBOSITY verbose

-- ═══════════════════════════════════════════════════════════════════════════
--  THE HANDS THE ENGINE AND THE SETTLER ARE BOTH ASKED TO PRICE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Each row is one Diamond cash hand, stated by its FACTS - the stake, what
-- every seat put in, who was dealt a hand and whether a flop came - and by
-- nothing else. The rake is deliberately absent: the whole point of the pass
-- that follows is that the ENGINE supplies it (server/src/domain/
-- diamondCashRakeSchedule.ts, run over these same published rows) and the
-- SETTLER recomputes it, and the two have to be the same number or the hand
-- refuses.
--
-- The stacks are built FROM the engine's rake in pg_temp.drive below, so a
-- wrong rake does not quietly become a non-conserving payload that would fail
-- for the wrong reason. Every hand conserves at whatever number it is given.

CREATE TABLE public.ca_probe_scenario (
  label        text PRIMARY KEY,
  hand_number  bigint NOT NULL,
  bb           bigint NOT NULL,
  contributed  bigint[] NOT NULL,
  dealt_in     boolean[] NOT NULL,
  saw_flop     boolean NOT NULL,
  start_stack  bigint NOT NULL
);

/* The engine's answer, loaded between the two passes. */
CREATE TABLE public.ca_probe_engine_rake (label text PRIMARY KEY, rake bigint NOT NULL);
/* And the engine's reading of each published answer. */
CREATE TABLE public.ca_probe_engine_reading (name text, scope text, value numeric,
  PRIMARY KEY (name, scope));

/* pot = sum(contributed); dealt = count of dealt_in. Stated once. */
CREATE FUNCTION pg_temp.scenario_pot(p_label text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT COALESCE(sum(c),0) FROM unnest(contributed) c) FROM public.ca_probe_scenario WHERE label = p_label
$$;
CREATE FUNCTION pg_temp.scenario_dealt(p_label text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM unnest(dealt_in) d WHERE d)::integer FROM public.ca_probe_scenario WHERE label = p_label
$$;

INSERT INTO public.ca_probe_scenario
  (label, hand_number, bb, contributed, dealt_in, saw_flop, start_stack) VALUES
  -- A flopped multiway pot, comfortably under every cap.
  ('multiway under the cap, 1/2 six-handed',
     2000001, 2, '{20,20,10,10,10,10}', '{t,t,t,t,t,t}', true, 100),
  ('multiway under the cap, 1/2 four-handed',
     2000002, 2, '{30,30,10,10}', '{t,t,t,t}', true, 100),
  -- Three-handed: its own percent and its own cap.
  ('three-handed under the cap, 1/2',
     2000003, 2, '{30,40,10}', '{t,t,t}', true, 100),
  ('three-handed over the cap, 1/2',
     2000004, 2, '{400,400,400}', '{t,t,t}', true, 500),
  ('three-handed over the cap, 2/5',
     2000005, 5, '{900,900,900}', '{t,t,t}', true, 1000),
  ('three-handed over the cap, 5000/10000',
     2000006, 10000, '{90000,90000,90000}', '{t,t,t}', true, 100000),
  -- Four-or-more: the unsuffixed percent and cap, over the cap at each rung.
  ('multiway over the cap, 1/2',
     2000007, 2, '{400,400,400,400}', '{t,t,t,t}', true, 500),
  ('multiway over the cap, 2/5',
     2000008, 5, '{900,900,900,900}', '{t,t,t,t}', true, 1000),
  ('multiway over the cap, 5000/10000',
     2000009, 10000, '{90000,90000,90000,90000}', '{t,t,t,t}', true, 100000),
  -- Heads-up: the lower percent, and the one rung whose cap FLOORS.
  ('heads-up under the cap, 1/2',
     2000010, 2, '{50,50}', '{t,t}', true, 100),
  ('heads-up over the cap, 1/2',
     2000011, 2, '{400,400}', '{t,t}', true, 500),
  ('heads-up at the bb:5 rung that floors',
     2000012, 5, '{500,500}', '{t,t}', true, 1000),
  ('heads-up over the cap, 5000/10000',
     2000013, 10000, '{90000,90000}', '{t,t}', true, 100000),
  -- No flop, no drop: the owner's answer is yes, so nothing is taken.
  ('no flop, no drop, 1/2 three-handed',
     2000014, 2, '{10,10,0}', '{t,t,t}', false, 100),
  ('no flop, no drop, 2/5 heads-up on a big pot',
     2000015, 5, '{500,500}', '{t,t}', false, 1000),
  -- A pot too small for the percent to yield one whole Diamond.
  ('a pot too small to rake one Diamond, 1/2 three-handed',
     2000016, 2, '{3,3,3}', '{t,t,t}', true, 100),
  ('a pot one Diamond short of raking, heads-up 1/2',
     2000017, 2, '{10,9}', '{t,t}', true, 100),
  -- A seat at the table that was not dealt in: it carries the facts, counts
  -- for nothing, and must not move the bracket.
  ('an undealt seat does not change the bracket, 1/2',
     2000018, 2, '{30,40,10,0}', '{t,t,t,f}', true, 100);

-- ── the probe's own helpers, in public so they outlive this session ───────
-- The engine runs between two psql sessions (it is TypeScript, not SQL), so
-- anything the agreement pass needs has to persist. Fixture plumbing only:
-- no money rule is stated here.

INSERT INTO public.profiles (id)
SELECT md5('probe:player:'||i)::uuid FROM generate_series(1,8) i;

CREATE FUNCTION public.probe_seat(
  p_table uuid, p_user uuid, p_seat uuid, p_occupancy uuid,
  p_joined timestamptz, p_stack bigint, p_seat_number integer)
RETURNS void LANGUAGE plpgsql AS $seat$
DECLARE v_custody uuid := gen_random_uuid(); v_lot uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.table_seats (id,table_id,user_id,joined_at,left_at,stack,occupancy_id,seat_number)
  VALUES (p_seat,p_table,p_user,p_joined,NULL,p_stack,p_occupancy,p_seat_number);
  INSERT INTO public.poker_diamond_custody
    (id,user_id,arena_id,purpose,target_id,balance,state,seat_id,seat_joined_at,occupancy_id)
  VALUES (v_custody,p_user,(SELECT club_id FROM public.tables WHERE id=p_table),
          'cash_seat',p_table,p_stack,'active',p_seat,p_joined,p_occupancy);
  INSERT INTO public.diamond_purchase_lots
    (id,user_id,issued,consumed,refunded,arena_reserved,created_at)
  VALUES (v_lot,p_user,p_stack,0,0,p_stack,now());
  INSERT INTO public.poker_diamond_lot_reservations
    (custody_id,lot_id,amount,released_at,consumed)
  VALUES (v_custody,v_lot,p_stack,NULL,0);
END $seat$;

CREATE FUNCTION public.probe_assert(p_ok boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_what; END IF;
  RAISE NOTICE 'PASS: %', p_what;
END $a$;

/* The owner's schedule, read a SECOND time from the published rows. Not a
   copy of the settler's arithmetic and not a copy of the engine's: a third
   reading, so a probe that passes has three independent agreements rather
   than one expectation written twice. */
CREATE FUNCTION public.probe_scheduled_rake(
  p_bb bigint, p_pot bigint, p_dealt integer, p_saw_flop boolean)
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

/**
 * Drive one scenario through the settler at a stated rake.
 *
 * The stacks are built FROM that rake - every seat loses what it contributed,
 * the first seat is paid the pot less the rake - so the payload conserves at
 * whatever number it is given. A rake that is wrong therefore fails on the
 * RECOMPUTE and not on conservation, which is what makes the comparison
 * meaningful: conservation is checked first in the settler, and a payload
 * that did not conserve would refuse for the wrong reason and prove nothing.
 *
 * `p_hand_offset` lets the same scenario be driven more than once (the
 * one-Diamond-either-side refusals below) without colliding on hand number.
 */
CREATE FUNCTION public.probe_drive(p_label text, p_rake bigint, p_hand_offset bigint DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $d$
DECLARE
  s public.ca_probe_scenario%ROWTYPE;
  v_table uuid;
  v_pot bigint;
  v_stacks jsonb := '[]'::jsonb;
  i integer;
  v_stack bigint;
BEGIN
  SELECT * INTO s FROM public.ca_probe_scenario WHERE label = p_label;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: no such scenario %', p_label; END IF;
  v_pot := (SELECT COALESCE(sum(c),0) FROM unnest(s.contributed) c);
  v_table := md5('probe:table:'||p_label||':'||p_hand_offset::text)::uuid;
  INSERT INTO public.tables (id, club_id, big_blind, union_id, tournament_id, game_variant)
  VALUES (v_table,'11111111-1111-1111-1111-111111111111',s.bb,NULL,NULL,'nlh');
  FOR i IN 1..array_length(s.contributed,1) LOOP
    PERFORM public.probe_seat(
      v_table, md5('probe:player:'||i)::uuid,
      md5(v_table::text||':seat:'||i::text)::uuid,
      md5(v_table::text||':occ:'||i::text)::uuid,
      '2026-10-06T01:00:00.000Z'::timestamptz, s.start_stack, i);
    v_stack := s.start_stack - s.contributed[i] + CASE WHEN i = 1 THEN v_pot - p_rake ELSE 0 END;
    v_stacks := v_stacks || jsonb_build_array(jsonb_build_object(
      'user_id', md5('probe:player:'||i)::uuid,
      'seat_id', md5(v_table::text||':seat:'||i::text)::uuid,
      'seat_joined_at', '2026-10-06T01:00:00.000Z',
      'stack_before', s.start_stack,
      'stack', v_stack,
      'contributed', s.contributed[i],
      'dealt_in', s.dealt_in[i],
      'hand_saw_flop', s.saw_flop));
  END LOOP;
  RETURN public.fn_poker_diamond_settle_cash_hand(
    v_table, s.hand_number + p_hand_offset, v_stacks, p_rake, 0, NULL, 0);
END $d$;

/** The same drive, expected to refuse, matched BY NAME. */
CREATE FUNCTION public.probe_refuses(p_label text, p_rake bigint, p_hand_offset bigint, p_name text)
RETURNS void LANGUAGE plpgsql AS $ref$
DECLARE v_err text;
BEGIN
  BEGIN
    PERFORM public.probe_drive(p_label, p_rake, p_hand_offset);
    RAISE EXCEPTION 'FAIL: % was accepted at a rake of % (%)', p_label, p_rake, p_name;
  EXCEPTION WHEN raise_exception OR check_violation OR invalid_parameter_value THEN
    v_err := SQLERRM;
    IF v_err LIKE 'FAIL:%' THEN RAISE; END IF;
    IF position(p_name in v_err) = 0 THEN
      RAISE EXCEPTION 'FAIL: expected % for % but the settler said: %', p_name, p_label, v_err;
    END IF;
  END;
  PERFORM public.probe_assert(true, format(
    '%s: a rake of %s is refused by %s, so the accepted number was checked',
    p_label, p_rake, p_name));
END $ref$;
