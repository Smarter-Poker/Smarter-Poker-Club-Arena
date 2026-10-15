-- RULING. Dan, 2026-10-15 10:23 Central, in his own words: "swap the 25
-- tournament-only pilot horses for 25 cash-only horses funded to 200 from the
-- pilot treasury".
--
-- WHY. 20261015032740 admitted 72 horses by id order without reading their
-- assigned game lane (profiles.horse_profile->>'lane'). 25 were 'events' (never
-- seated at cash by the fleet), 22 'both' and 25 'cash', so the pilot could not
-- reach the 18 / 27 live players Phase 3 needs (4 and 4 seated at 15:09 UTC).
-- Choosing the roster without the lane was the error; this corrects it.
--
-- CHANGE, one transaction, after 20261015152535 switched pilot Spins off:
--   1. Each pilot horse whose lane is 'events' leaves through the maintained
--      door fn_member_leave_to_treasury(pilot, horse): its wallet is emptied
--      into the pilot treasury under the door's declared leg and the
--      membership row is removed holding no chips. The door refuses a horse
--      still seated in the pilot, so the apply refuses whole until the last
--      pilot Spin has settled.
--   2. The same number of idle active 'cash'-lane horses (no live seat
--      anywhere, under the club cap) join as ordinary active players through
--      the join_club membership source and fn_join_club's column list, chosen
--      by id.
--   3. fn_seed_horses_to_floor(pilot, 200) funds every pilot horse below 200
--      from the pilot treasury (the joiners from 0, plus any member whose play
--      took it under 200, which Dan's earlier "top up the 72 pilot horses to 200
--      chips each" already covers), one declared horse_funding leg each.
-- Asserts: exactly 25 left and 25 joined, 72 horses, every pilot horse lane is
-- now 'cash' or 'both', every horse at or above 200, no other human, treasury
-- conservation, and no Lightning state change.
-- @live-proof: (SELECT count(*) = 0 FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND p.is_horse AND p.horse_profile->>'lane' = 'events') AND (SELECT count(*) = 72 FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND p.is_horse)

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $swap$
DECLARE
  c_club constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  c_owner constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_leaving uuid[]; v_joining uuid[]; h uuid; r jsonb; f record;
  v_t0 numeric; v_t1 numeric; v_t2 numeric; v_returned numeric := 0; v_n int;
BEGIN
  IF (SELECT spins_enabled FROM public.clubs WHERE id = c_club)
     OR (SELECT is_active FROM public.spin_bonus_pools WHERE club_id = c_club) THEN
    RAISE EXCEPTION 'pilot Spins are still on; 20261015152535 must be applied first';
  END IF;

  SELECT array_agg(m.user_id ORDER BY m.user_id) INTO v_leaving
    FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id = c_club AND p.is_horse AND p.horse_profile->>'lane' = 'events';
  IF coalesce(cardinality(v_leaving), 0) <> 25 THEN
    RAISE EXCEPTION 'expected 25 events-lane pilot horses, found %', coalesce(cardinality(v_leaving), 0);
  END IF;

  -- A registration in a live pilot event (seated or still registering) must
  -- settle before its horse leaves, or its prize would have no wallet to land in.
  IF EXISTS (SELECT 1 FROM public.tournament_players tp JOIN public.tournaments t ON t.id = tp.tournament_id
              WHERE tp.user_id = ANY (v_leaving) AND t.club_id = c_club
                AND upper(t.status::text) NOT IN ('COMPLETED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'an events-lane pilot horse is still entered in a live pilot event; apply after they settle';
  END IF;

  SELECT chip_treasury INTO v_t0 FROM public.clubs WHERE id = c_club FOR UPDATE;
  SELECT coalesce(sum(chip_balance), 0) INTO v_returned
    FROM public.club_members WHERE club_id = c_club AND user_id = ANY (v_leaving);

  FOREACH h IN ARRAY v_leaving LOOP
    r := public.fn_member_leave_to_treasury(c_club, h);
    IF coalesce(r->>'success', '') <> 'true' THEN
      RAISE EXCEPTION 'pilot horse % could not leave: %', h, r;
    END IF;
  END LOOP;

  SELECT chip_treasury INTO v_t1 FROM public.clubs WHERE id = c_club;
  IF v_t1 - v_t0 <> v_returned THEN
    RAISE EXCEPTION 'leave conservation broken: treasury % -> %, wallets held %', v_t0, v_t1, v_returned;
  END IF;

  SELECT array_agg(id ORDER BY id) INTO v_joining FROM (
    SELECT p.id
      FROM public.profiles p
     WHERE p.is_horse AND p.status = 'active' AND p.horse_profile->>'lane' = 'cash'
       AND NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = p.id AND m.club_id = c_club)
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.user_id = p.id AND s.left_at IS NULL)
       AND (SELECT count(*) FROM public.club_members m
             WHERE m.user_id = p.id AND m.status IN ('active', 'approved', 'pending'))
           < public.fn_club_membership_cap() - 1
     ORDER BY p.id
     LIMIT 25) c;
  IF coalesce(cardinality(v_joining), 0) <> 25 THEN
    RAISE EXCEPTION 'found only % idle cash-lane horses to admit', coalesce(cardinality(v_joining), 0);
  END IF;

  PERFORM set_config('app.club_membership_source', 'join_club', true);
  INSERT INTO public.club_members
    (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
  SELECT c_club, j, 'player', 'active', 'bronze', 0, 'cold', 0 FROM unnest(v_joining) j
  ON CONFLICT (club_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.club_membership_source', '', true);
  IF v_n <> 25 THEN RAISE EXCEPTION 'admitted % cash-lane horses, expected 25', v_n; END IF;

  SELECT * INTO f FROM public.fn_seed_horses_to_floor(c_club, 200);
  SELECT chip_treasury INTO v_t2 FROM public.clubs WHERE id = c_club;
  IF f.chips_moved > 72 * 200 OR f.horses_funded < 25 OR v_t1 - v_t2 <> f.chips_moved THEN
    RAISE EXCEPTION 'pilot funding out of bounds or not conserved: % horses, % chips, treasury % -> %',
      f.horses_funded, f.chips_moved, v_t1, v_t2;
  END IF;

  IF (SELECT count(*) FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
       WHERE m.club_id = c_club AND p.is_horse) <> 72 THEN
    RAISE EXCEPTION 'the pilot no longer holds exactly 72 horses';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
              WHERE m.club_id = c_club AND p.is_horse
                AND (coalesce(p.horse_profile->>'lane', '') NOT IN ('cash', 'both') OR m.chip_balance < 200
                     OR m.role <> 'player' OR m.status <> 'active')) THEN
    RAISE EXCEPTION 'a pilot horse is not an active cash-capable player at 200';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members m LEFT JOIN public.profiles p ON p.id = m.user_id
              WHERE m.club_id = c_club AND NOT coalesce(p.is_horse, false) AND m.user_id <> c_owner) THEN
    RAISE EXCEPTION 'the pilot holds a non-owner human';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games
              WHERE club_id = c_club AND name LIKE 'Lightning Pilot%'
                AND (lightning_enabled OR cluster_mode <> 'must_move')) THEN
    RAISE EXCEPTION 'a pilot game changed Lightning state; this migration must not activate anything';
  END IF;
END $swap$;

COMMIT;
