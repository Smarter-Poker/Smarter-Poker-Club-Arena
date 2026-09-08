-- 20260908114533_a_horse_may_play_in_the_arena.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- PHASE 5.4 (the part that can be proved today): A HORSE MAY PLAY IN THE DIAMOND ARENA.
-- (CLAUDE.md 10.5 "HORSES ARE PLAYERS"; ruling 16; roadmap 5.4;
--  docs/changelog/2026-09-08-a-horse-may-play-in-the-arena.md)
--
-- Found while probing the arena doors: seating a horse in the Diamond Arena is refused with
-- `AUTOMATED_PLAYER_HOUSE_BOARD_ONLY: Automated Players Cannot Enter A User-Created Club`.
--
-- The guard itself is right and stays. Horses belong on house boards and not in somebody's private
-- club, and `fn_ca_reject_automated_user_club_row` enforces that on club_members, agents,
-- table_seats and tournament_players alike. What is wrong is how it decides what a house board IS:
--
--     SELECT p_club_id = ANY (ARRAY[ four hard-coded uuids ]);
--
-- A LIST OF UUIDS CANNOT KNOW ABOUT A CLUB THAT DID NOT EXIST WHEN IT WAS WRITTEN. The Diamond
-- Arena is the platform's own room - it is the house board, by definition - and it was locked out
-- of its own category by a constant. Ruling 16 says horses play in the arena and are funded from
-- the house; 10.5 says a horse is treated exactly as a human is, and today a human could join the
-- arena and a horse could not. That is an exclusion by design, which is the thing 10.5 forbids.
--
-- The rule is derived now: a house board is the platform club, OR one of the four legacy boards
-- that predate `clubs.is_platform`. The list stays only because those four are ordinary chip clubs
-- that nothing marks; it is debt, named as debt, and it shrinks to nothing the day they carry a
-- flag of their own. The derived half needs no maintenance: any future platform club is a house
-- board the moment it exists.
--
-- WHAT THIS DOES NOT DO. It does not seat a horse anywhere. There is no diamond table and none may
-- open until the entry condition is met (seven consecutive clean days on the diamond trial balance,
-- suspense zero, no open critical incident). This removes a refusal that would have met the first
-- horse the day the first table opened.
--
-- THE REST OF 5.4 IS DELIBERATELY NOT HERE, and this is the honest reason rather than an omission:
--
--   * Rake to `ca_diamond_house` and guarantees from the house (`fn_apply_prize_guarantee`, which
--     today knows no 'house' bank type) are live CHIP money paths used by real tournaments every
--     hour. There is no diamond table or diamond tournament to exercise a diamond branch against,
--     so anything written there could only be reasoned about, not probed - and an unprovable
--     branch in a money path is exactly what CLAUDE.md 10.86 is about. They land with the first
--     table, against something that can be measured.
--   * The platform club's `bbj_pools` row is gated by the roadmap itself on chip roadmap 4.2 and
--     4.3, which have not landed. Creating it early would pin a shape those phases may change.
--
-- One transaction. No money moves.

BEGIN;

SET LOCAL lock_timeout = '15s';

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
          '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid    -- Deep Stack Society
        ]);
$$;

COMMENT ON FUNCTION public.fn_ca_house_board_allows_automation(uuid) IS
  'True for a club where automated players may sit: the platform club (derived from clubs.is_platform) or one of four legacy chip house boards. Was a bare list of four uuids, which locked the Diamond Arena out of its own category on the day it was created (2026-09-08).';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_arena uuid; v_ordinary uuid; v_left text;
BEGIN
  SELECT club_id INTO v_arena FROM public.ca_arena_settings WHERE id = 1;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'there is no arena club to test against'; END IF;

  -- the arena is a house board now
  IF NOT public.fn_ca_house_board_allows_automation(v_arena) THEN
    RAISE EXCEPTION 'a horse still cannot enter the Diamond Arena';
  END IF;

  -- the four legacy boards are unchanged
  IF NOT (public.fn_ca_house_board_allows_automation('a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
      AND public.fn_ca_house_board_allows_automation('a0000000-0000-0000-0000-000000000001')
      AND public.fn_ca_house_board_allows_automation('fade0000-0000-0000-0000-000000000001')
      AND public.fn_ca_house_board_allows_automation('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')) THEN
    RAISE EXCEPTION 'a legacy house board stopped allowing automation';
  END IF;

  -- AND NOTHING ELSE MAY ALLOW ONE. Widening the guard would be worse than the bug: horses in
  -- somebody's private club is exactly what it was written to prevent. There is no ordinary
  -- player-owned club on this database today - five clubs exist, one union, one platform and the
  -- three legacy boards - so the negative case is proved two ways here and a third way in the
  -- rolled-back probe, which creates a real ordinary club and watches the guard refuse it.
  IF public.fn_ca_house_board_allows_automation('00000000-0000-0000-0000-000000000000') THEN
    RAISE EXCEPTION 'a club that does not exist reads as a house board';
  END IF;
  FOR v_ordinary IN
    SELECT id FROM public.clubs
     WHERE NOT COALESCE(is_platform, false)
       AND id <> ALL (ARRAY['a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
                            'a0000000-0000-0000-0000-000000000001'::uuid,
                            'fade0000-0000-0000-0000-000000000001'::uuid,
                            '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid])
  LOOP
    IF public.fn_ca_house_board_allows_automation(v_ordinary) THEN
      RAISE EXCEPTION 'the guard lets an automated player into club %, which is neither the platform club nor a legacy board', v_ordinary;
    END IF;
  END LOOP;

  -- the derived half is what admits the arena, not a fifth uuid quietly appended to the list
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_ca_house_board_allows_automation')
     NOT LIKE '%c.is_platform%' THEN
    RAISE EXCEPTION 'the house board rule is still a bare list';
  END IF;

  -- nothing moved, nothing became unreachable
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_arena_diamonds() THEN
    RAISE EXCEPTION 'players + arena <> register after a change that moves no money';
  END IF;
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_left FROM public.fn_ca_diamond_unreachable_money();
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'unreachable money paths: %', v_left; END IF;
END $$;

COMMIT;
