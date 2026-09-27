-- Controls for fn_horse_stackoff_audit_step and its two helpers. Every
-- assertion fails loudly; a silent pass is not possible because the counters
-- are asserted alongside the rows.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.mk_hand(
  p_id uuid, p_hero uuid, p_villain uuid, p_variant text, p_bb numeric,
  p_hero_start numeric, p_villain_start numeric,
  p_hero_commit numeric, p_hero_won numeric,
  p_villain_commit numeric, p_villain_won numeric,
  p_hole jsonb, p_board text[], p_actions jsonb, p_when timestamptz
) RETURNS void LANGUAGE plpgsql AS $mk$
DECLARE payload jsonb;
BEGIN
  payload := jsonb_build_object('accepted_hand_facts', jsonb_build_object(
    'contributions', jsonb_build_object(p_hero::text, p_hero_commit, p_villain::text, p_villain_commit),
    'returned_uncalled', '{}'::jsonb));
  INSERT INTO public.hand_history(id, table_id, created_at, game_variant, big_blind, pot_size,
    players, winners, actions, hole_cards, community_cards, tournament_id)
  VALUES (p_id, '00000000-0000-0000-0000-0000000000ff', p_when, p_variant, p_bb,
    p_hero_commit + p_villain_commit,
    jsonb_build_array(
      jsonb_build_object('seat', 1, 'userId', p_hero::text,
                         'stack', p_hero_start - p_hero_commit + p_hero_won),
      jsonb_build_object('seat', 2, 'userId', p_villain::text,
                         'stack', p_villain_start - p_villain_commit + p_villain_won)),
    (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
       SELECT jsonb_build_object('userId', p_hero::text, 'amount', p_hero_won, 'potIndex', 0) x
         WHERE p_hero_won > 0
       UNION ALL
       SELECT jsonb_build_object('userId', p_villain::text, 'amount', p_villain_won, 'potIndex', 0)
         WHERE p_villain_won > 0) z),
    p_actions, p_hole, p_board, '00000000-0000-0000-0000-0000000000cc');
  INSERT INTO public.hand_atomic_commits(hand_id, table_id, post_commit_payload, post_commit_payload_hash)
  VALUES (p_id, '00000000-0000-0000-0000-0000000000ff', payload,
    encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex'));
END;
$mk$;

DO $seed$
DECLARE
  hero  uuid := '00000000-0000-0000-0000-00000000a001';
  villain uuid := '00000000-0000-0000-0000-00000000b002';
  d date := current_date - 2;
  ts timestamptz := (d::timestamp AT TIME ZONE 'UTC') + interval '6 hours';
  turn_acts jsonb := jsonb_build_array(
    jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','preflop','action','call','amount',50),
    jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','turn','action','all_in','amount',29950));
  river_acts jsonb := jsonb_build_array(
    jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','preflop','action','call','amount',50),
    jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','river','action','all_in','amount',29950));
  small_acts jsonb := jsonb_build_array(
    jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','turn','action','bet','amount',9000));
  qq jsonb := jsonb_build_object('00000000-0000-0000-0000-00000000a001',
    jsonb_build_array(jsonb_build_object('rank','Q','suit','hearts'), jsonb_build_object('rank','Q','suit','clubs')));
  aj jsonb := jsonb_build_object('00000000-0000-0000-0000-00000000a001',
    jsonb_build_array(jsonb_build_object('rank','A','suit','spades'), jsonb_build_object('rank','J','suit','clubs')));
  sevens jsonb := jsonb_build_object('00000000-0000-0000-0000-00000000a001',
    jsonb_build_array(jsonb_build_object('rank','7','suit','hearts'), jsonb_build_object('rank','7','suit','clubs')));
  low_board text[] := ARRAY['6diamonds','4clubs','Tspades','5hearts','7spades'];
  ace_board text[] := ARRAY['6spades','8diamonds','Aclubs','2clubs','7hearts'];
  set_board text[] := ARRAY['7spades','Kdiamonds','2clubs','5hearts','9spades'];
BEGIN
  INSERT INTO public.profiles VALUES (hero, true), (villain, false);
  INSERT INTO public.tournaments VALUES ('00000000-0000-0000-0000-0000000000cc', 'MTT');

  -- H1 overpair, 600bb effective, whole stack in on the turn, LOST.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000001', hero, villain, 'nlh', 50,
    30000, 30000, 30000, 0, 30000, 60000, qq, low_board, turn_acts, ts);
  -- H2 the same shape, WON: the mirror the denominator law requires.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000002', hero, villain, 'nlh', 50,
    30000, 30000, 30000, 60000, 30000, 0, qq, low_board, turn_acts, ts);
  -- H3 top pair with a JACK kicker on the river: outside V24's kicker<=9 gate.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000003', hero, villain, 'nlh', 50,
    30000, 30000, 30000, 0, 30000, 60000, aj, ace_board, river_acts, ts);
  -- H4 the same overpair stack-off at 100bb: NOT deep, must not be recorded.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000004', hero, villain, 'nlh', 50,
    5000, 5000, 5000, 0, 5000, 10000, qq, low_board, turn_acts, ts);
  -- H5 a SET at the same depth: recorded as the denominator, never tagged.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000005', hero, villain, 'nlh', 50,
    30000, 30000, 30000, 0, 30000, 60000, sevens, set_board, turn_acts, ts);
  -- H6 hole cards absent: named unreadable, still recorded, never tagged.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000006', hero, villain, 'nlh', 50,
    30000, 30000, 30000, 0, 30000, 60000, '{}'::jsonb, low_board, turn_acts, ts);
  -- H7 Omaha: out of scope, counted, never scored with the hold'em ladder.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000007', hero, villain, 'plo4', 50,
    30000, 30000, 30000, 0, 30000, 60000, qq, low_board, turn_acts, ts);
  -- H8 deep but only 30% of the effective stack: a big pot, not a stack-off.
  PERFORM pg_temp.mk_hand('00000000-0000-0000-0000-000000000008', hero, villain, 'nlh', 50,
    30000, 30000, 9000, 0, 9000, 18000, qq, low_board, small_acts, ts);

  -- H3 already carries a generic river tag; H1 has no review row at all.
  INSERT INTO public.horse_hand_reviews VALUES
    ('00000000-0000-0000-0000-000000000003', hero, ARRAY['river_aggr_lost']);
END;
$seed$;

DO $check$
DECLARE
  d date := current_date - 2;
  r jsonb; day_row public.horse_stackoff_audit_days%ROWTYPE; n int; t text;
BEGIN
  r := public.fn_horse_stackoff_audit_step(d);
  ASSERT r->>'status' = 'pass_complete', format('expected pass_complete, got %s', r);

  -- The pot pre-filter must stay strictly below the smallest commitment the
  -- detector can tag, or the sweep could skip a qualifying hand.
  ASSERT (r->>'deepBbFloor')::numeric * (r->>'commitFractionFloor')::numeric
         > (r->>'potFilterBb')::numeric,
    'the pot pre-filter is not strictly below deepBbFloor * commitFractionFloor';

  SELECT * INTO day_row FROM public.horse_stackoff_audit_days WHERE day = d;
  ASSERT day_row.candidate_hands = 8, format('candidate_hands=%s', day_row.candidate_hands);
  ASSERT day_row.out_of_scope_hands = 1, format('out_of_scope_hands=%s', day_row.out_of_scope_hands);
  ASSERT day_row.horse_seats = 7, format('horse_seats=%s', day_row.horse_seats);
  ASSERT day_row.deep_seats = 6, format('deep_seats=%s', day_row.deep_seats);
  ASSERT day_row.stackoff_seats = 5, format('stackoff_seats=%s', day_row.stackoff_seats);
  ASSERT day_row.tagged_seats = 3, format('tagged_seats=%s', day_row.tagged_seats);
  ASSERT day_row.unreadable_seats = 1, format('unreadable_seats=%s', day_row.unreadable_seats);
  ASSERT day_row.source_coverage = 'not_established', 'source coverage must never be claimed';

  SELECT count(*) INTO n FROM public.horse_stackoff_reviews;
  ASSERT n = 5, format('expected 5 recorded seats, got %s', n);

  SELECT detector_tag INTO t FROM public.horse_stackoff_reviews
    WHERE hand_id = '00000000-0000-0000-0000-000000000001';
  ASSERT t = 'deep_overpair_stackoff', format('H1 tag=%s', t);
  SELECT detector_tag INTO t FROM public.horse_stackoff_reviews
    WHERE hand_id = '00000000-0000-0000-0000-000000000002';
  ASSERT t = 'deep_overpair_stackoff_won', format('H2 tag=%s', t);
  SELECT detector_tag INTO t FROM public.horse_stackoff_reviews
    WHERE hand_id = '00000000-0000-0000-0000-000000000003';
  ASSERT t = 'deep_one_pair_stackoff', format('H3 tag=%s', t);

  -- The commit street decides the board, so the turn board is what QQ is read on.
  ASSERT (SELECT commit_street FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000001') = 'turn', 'H1 commit street';
  ASSERT (SELECT pair_class FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000003') = 'one_pair', 'H3 pair class';
  ASSERT (SELECT kicker FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000003') = 11, 'H3 kicker is the jack';

  -- A 100bb stack-off of the same hand is not this detector's business.
  ASSERT NOT EXISTS (SELECT 1 FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000004'), 'H4 must not be recorded';
  -- A set is the denominator: recorded, categorised, never tagged.
  ASSERT (SELECT hand_category FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000005') = 'trips', 'H5 category';
  ASSERT (SELECT detector_tag FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000005') IS NULL, 'H5 must not be tagged';
  -- Unreadable evidence is NAMED, not reported as a clean zero.
  ASSERT (SELECT detector_tag FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000006') IS NULL, 'H6 must not be tagged';
  ASSERT 'hole_cards_not_two' = ANY (SELECT unnest(reasons) FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000006'), 'H6 must name why it could not be read';
  -- Omaha is out of scope, not silently scored on the hold'em ladder.
  ASSERT NOT EXISTS (SELECT 1 FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000007'), 'H7 must not be recorded';
  ASSERT NOT EXISTS (SELECT 1 FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000008'), 'H8 must not be recorded';

  -- An existing review row is carried through; its absence is recorded as absence.
  ASSERT (SELECT review_row_present FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000003') IS TRUE, 'H3 review row present';
  ASSERT 'river_aggr_lost' = ANY (SELECT unnest(existing_leak_tags) FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000003'), 'H3 existing tags';
  ASSERT (SELECT review_row_present FROM public.horse_stackoff_reviews
          WHERE hand_id = '00000000-0000-0000-0000-000000000001') IS FALSE, 'H1 has no review row';
END;
$check$;

-- IDEMPOTENCE: a second pass over the same day rewrites the same answers.
CREATE TEMP TABLE before_second_pass AS
  SELECT hand_id, horse_user_id, detector_tag, pair_class, hand_category, effective_bb,
         committed_bb, commit_fraction, net_bb, commit_street, kicker
  FROM public.horse_stackoff_reviews;

DO $again$
DECLARE d date := current_date - 2; r jsonb; n int;
BEGIN
  r := public.fn_horse_stackoff_audit_step(d);
  ASSERT r->>'status' = 'pass_complete', format('second pass status=%s', r);
  ASSERT (r->>'taggedSeats')::int = 3, format('second pass taggedSeats=%s', r->>'taggedSeats');
  SELECT count(*) INTO n FROM (
    (SELECT * FROM before_second_pass)
    EXCEPT
    (SELECT hand_id, horse_user_id, detector_tag, pair_class, hand_category, effective_bb,
            committed_bb, commit_fraction, net_bb, commit_street, kicker
       FROM public.horse_stackoff_reviews)) x;
  ASSERT n = 0, format('%s rows changed on a second pass; the sweep is not idempotent', n);
  SELECT count(*) INTO n FROM public.horse_stackoff_reviews;
  ASSERT n = 5, format('second pass duplicated rows: %s', n);
  -- A second pass is pass 2, and its counters are the pass's, not a running total.
  ASSERT (SELECT pass FROM public.horse_stackoff_audit_days WHERE day = d) = 2, 'pass did not advance';
END;
$again$;

-- The classifier's own ladder, independent of the sweep.
DO $ladder$
DECLARE c jsonb;
BEGIN
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"A","suit":"hearts"},{"rank":"A","suit":"spades"}]'::jsonb,
    ARRAY['Kclubs','7diamonds','2spades']);
  ASSERT c->>'class' = 'overpair', 'aces over a king-high board are an overpair';
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"Q","suit":"hearts"},{"rank":"Q","suit":"spades"}]'::jsonb,
    ARRAY['Aclubs','Kdiamonds','2spades']);
  ASSERT c->>'class' = 'one_pair', 'queens under an ace-king board are not an overpair';
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"A","suit":"hearts"},{"rank":"K","suit":"spades"}]'::jsonb,
    ARRAY['Qclubs','Qdiamonds','2spades']);
  ASSERT c->>'class' = 'board_pair', 'a pair the board makes for everybody is not the hand''s own';
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"A","suit":"hearts"},{"rank":"A","suit":"spades"}]'::jsonb,
    ARRAY['2clubs','3diamonds','4spades','5hearts']);
  ASSERT c->>'category' = 'straight', 'the wheel is a straight, not a pair';
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"A","suit":"hearts"},{"rank":"K","suit":"hearts"}]'::jsonb,
    ARRAY['Qhearts','Jhearts','2hearts']);
  ASSERT c->>'category' = 'flush', 'five of a suit is a flush, not a pair';
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"A","suit":"hearts"},{"rank":"K","suit":"spades"}]'::jsonb,
    ARRAY['10clubs','Kdiamonds','2spades']);
  ASSERT (c->>'readable')::boolean IS FALSE, 'an unparseable board card must refuse, not guess';
  ASSERT c->>'reason' = 'board_card_unparsed', 'and must say which evidence it could not read';
  -- Four hole cards are Omaha and must never be scored on this ladder.
  c := public.fn_ca_holdem_commit_pair_class(
    '[{"rank":"A","suit":"h"},{"rank":"K","suit":"s"},{"rank":"2","suit":"d"},{"rank":"3","suit":"c"}]'::jsonb,
    ARRAY['Aclubs','Kdiamonds','2spades']);
  ASSERT c->>'reason' = 'hole_cards_not_two', 'four hole cards must be refused';
END;
$ladder$;

-- The commit street stands down for a trailing remainder call.
DO $street$
DECLARE s text;
BEGIN
  s := public.fn_ca_hand_commit_street(jsonb_build_array(
        jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','preflop','action','raise','amount',10000),
        jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','flop','action','call','amount',100)),
       '00000000-0000-0000-0000-00000000a001', 10100);
  ASSERT s = 'preflop', format('a sub-15%% remainder call must not move the commit street, got %s', s);
  s := public.fn_ca_hand_commit_street(jsonb_build_array(
        jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','preflop','action','raise','amount',1000),
        jsonb_build_object('userId','00000000-0000-0000-0000-00000000a001','stage','flop','action','call','amount',9000)),
       '00000000-0000-0000-0000-00000000a001', 10000);
  ASSERT s = 'flop', format('a real flop call is the commit street, got %s', s);
END;
$street$;

SELECT 'horse-stackoff-detector controls passed' AS result;
