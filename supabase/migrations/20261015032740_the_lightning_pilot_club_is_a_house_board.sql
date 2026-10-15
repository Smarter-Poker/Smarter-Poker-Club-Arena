-- 20261015032740_the_lightning_pilot_club_is_a_house_board.sql
--
-- THE RULING IS DAN'S, NOT THIS MIGRATION'S. On 2026-10-14 (22:25 Central), in
-- the Lightning build chat, Dan approved in his own words: "add the Lightning
-- pilot club to the horse allowlist, admit 72 horses, and fund them from its
-- treasury". This is the same shape as Deep Stack Society's admission
-- (20260901091759): ONE named club is added to the automated-member allowlist;
-- the predicate is not relaxed, and every other user-created club still refuses
-- a horse.
--
-- WHY. Lightning Phase 3 (docs/lightning/FUNCTIONAL-BUILD-PHASES.md) needs a
-- populated private pilot: 30 nonempty shadow comparisons and a first real
-- Lightning hand. The pilot (club e14bc9f7, games babb43f1 6-max and 3330ff9f
-- 9-max, both private Must-Move with Lightning off) had only its owner. Humans
-- outside the team must not reach it (ROLLOUT.md, The Pilot Cluster), and the
-- house-board guard refused every horse. The pilot cannot become the platform
-- club (one platform club, the Diamond Arena; chip clubs cannot carry
-- is_platform), so the named-club allowlist is the only sanctioned door.
--
-- WHAT THIS DOES, in one transaction:
--   1. fn_ca_house_board_allows_automation keeps the derived is_platform half
--      and the four legacy boards, and names the pilot club as a fifth.
--   2. 72 existing active horses join the pilot as ordinary active players,
--      through the same membership source and column list fn_join_club writes
--      (owner approval of a requires_approval club is what makes them active).
--      Chosen deterministically: active horses under the club cap, ordered by id.
--   3. fn_seed_horses_to_floor funds each to 40 chips from the pilot's own
--      chip_treasury (72 x 40 = 2,880 of 99,700), one declared horse_funding leg
--      per horse, all or nothing. 40 chips covers the maximum 200 bb buy-in at
--      both pilot stakes (0.02 and 0.04 big blinds) with rebuys to spare.
--
-- Horses are players (CLAUDE.md 10.5): same buy-ins, same rake, same rules.
-- No game is enabled, no Lightning control changes, no job or schedule is added.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.fn_ca_house_board_allows_automation(p_club_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  -- DERIVED FIRST: the platform club is the house board, and always will be, without anybody
  -- remembering to add it to a list. This is the half that cannot rot.
  SELECT COALESCE((SELECT c.is_platform FROM public.clubs c WHERE c.id = p_club_id), false)
     -- LEGACY, AND IT IS DEBT: four chip house boards that predate clubs.is_platform and carry no
     -- flag of their own. Give them one and these four lines delete themselves.
     OR p_club_id = ANY (ARRAY[
          'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,   -- Club JAQK
          'a0000000-0000-0000-0000-000000000001'::uuid,   -- SHARK CLUB
          'fade0000-0000-0000-0000-000000000001'::uuid,   -- Midway Union
          '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,   -- Deep Stack Society
          -- Lightning Internal Pilot: Dan's ruling 2026-10-14 (20261015032740)
          'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid
        ]);
$$;

COMMENT ON FUNCTION public.fn_ca_house_board_allows_automation(uuid) IS
  'True for a club where automated players may sit: the platform club (derived from clubs.is_platform), one of four legacy chip house boards, or the Lightning Internal Pilot (Dan, 2026-10-14). Every other club refuses a horse.';

-- ---------------------------------------------------------------------------
-- Admission: the same row fn_join_club_membership_impl writes, made active by
-- the owner's ruling. The membership-source gate refuses any other insert.
-- ---------------------------------------------------------------------------
SELECT set_config('app.club_membership_source', 'join_club', true);

INSERT INTO public.club_members
  (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
SELECT 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid, h.id, 'player', 'active', 'bronze', 0, 'cold', 0
  FROM (
    SELECT p.id
      FROM public.profiles p
     WHERE p.is_horse
       AND p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.user_id = p.id
                          AND m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d')
       AND (SELECT count(*) FROM public.club_members m
             WHERE m.user_id = p.id AND m.status IN ('active', 'approved', 'pending'))
           < public.fn_club_membership_cap() - 1
     ORDER BY p.id
     LIMIT 72
  ) h
ON CONFLICT (club_id, user_id) DO NOTHING;

SELECT set_config('app.club_membership_source', '', true);

-- ---------------------------------------------------------------------------
-- Funding from the pilot's own treasury, through the platform's own path.
-- ---------------------------------------------------------------------------
DO $fund$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_seed_horses_to_floor('e14bc9f7-736d-425f-8f2c-e78305ebac1d', 40);
  IF r.horses_funded <> 72 OR r.chips_moved <> 2880 THEN
    RAISE EXCEPTION 'pilot funding moved % chips to % horses, expected 2880 to 72',
      r.chips_moved, r.horses_funded;
  END IF;
END $fund$;

-- ---------------------------------------------------------------------------
-- Assertions. Any failure rolls back the allowlist, the roster and the money.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE v_ordinary uuid; v_horses int; v_humans int; v_owner int; v_treasury numeric;
BEGIN
  IF NOT public.fn_ca_house_board_allows_automation('e14bc9f7-736d-425f-8f2c-e78305ebac1d') THEN
    RAISE EXCEPTION 'the pilot club still refuses a horse';
  END IF;
  IF NOT (public.fn_ca_house_board_allows_automation('a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
      AND public.fn_ca_house_board_allows_automation('a0000000-0000-0000-0000-000000000001')
      AND public.fn_ca_house_board_allows_automation('fade0000-0000-0000-0000-000000000001')
      AND public.fn_ca_house_board_allows_automation('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')) THEN
    RAISE EXCEPTION 'a legacy house board stopped allowing automation';
  END IF;
  IF public.fn_ca_house_board_allows_automation('00000000-0000-0000-0000-000000000000') THEN
    RAISE EXCEPTION 'a club that does not exist reads as a house board';
  END IF;
  FOR v_ordinary IN
    SELECT id FROM public.clubs
     WHERE NOT COALESCE(is_platform, false)
       AND id <> ALL (ARRAY['a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
                            'a0000000-0000-0000-0000-000000000001'::uuid,
                            'fade0000-0000-0000-0000-000000000001'::uuid,
                            '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,
                            'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid])
  LOOP
    IF public.fn_ca_house_board_allows_automation(v_ordinary) THEN
      RAISE EXCEPTION 'the guard lets an automated player into club %, which is not a named house board', v_ordinary;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_ca_house_board_allows_automation')
     NOT LIKE '%c.is_platform%' THEN
    RAISE EXCEPTION 'the house board rule lost its derived half';
  END IF;

  SELECT count(*) FILTER (WHERE p.is_horse AND m.role = 'player' AND m.status = 'active' AND m.chip_balance = 40),
         count(*) FILTER (WHERE NOT COALESCE(p.is_horse, false) AND m.user_id <> '2d1cd6c3-5700-4af9-a271-d4863fdab20d'),
         count(*) FILTER (WHERE m.user_id = '2d1cd6c3-5700-4af9-a271-d4863fdab20d' AND m.role = 'owner' AND m.status = 'active')
    INTO v_horses, v_humans, v_owner
    FROM public.club_members m LEFT JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  IF v_horses <> 72 OR v_humans <> 0 OR v_owner <> 1 THEN
    RAISE EXCEPTION 'pilot roster is % funded horses, % other humans, % owner; expected 72, 0, 1',
      v_horses, v_humans, v_owner;
  END IF;

  SELECT chip_treasury INTO v_treasury FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  IF v_treasury <> 96820 THEN
    RAISE EXCEPTION 'pilot treasury is %, expected 96820 after funding 2880 from 99700', v_treasury;
  END IF;

  IF EXISTS (SELECT 1 FROM public.cash_games
              WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'
                AND name LIKE 'Lightning Pilot%'
                AND (lightning_enabled OR cluster_mode <> 'must_move')) THEN
    RAISE EXCEPTION 'a pilot game changed Lightning state; this migration must not activate anything';
  END IF;
END $assert$;

COMMIT;
