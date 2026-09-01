-- User-owned clubs are explicit-membership spaces. Automated players belong
-- only to the platform/union house boards and must never appear in a club a
-- player created through Create A Club.

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_bot_house_only;

ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_bot_house_only
  CHECK (
    NOT COALESCE(is_bot, false)
    OR club_id IN (
      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, -- Shark house board
      'a0000000-0000-0000-0000-000000000001'::uuid, -- JAQK house board
      'fade0000-0000-0000-0000-000000000001'::uuid  -- Midway Union board
    )
  ) NOT VALID;

DO $repair$
DECLARE
  v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_bot_count integer;
  v_bot_chips numeric;
  v_active_seats integer;
  v_active_entries integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club) THEN
    RETURN;
  END IF;

  SELECT count(*), COALESCE(sum(chip_balance), 0)
    INTO v_bot_count, v_bot_chips
    FROM public.club_members
   WHERE club_id = v_club AND is_bot;

  SELECT count(*)
    INTO v_active_seats
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    JOIN public.club_members cm
      ON cm.club_id = t.club_id AND cm.user_id = ts.user_id
   WHERE t.club_id = v_club AND cm.is_bot AND ts.left_at IS NULL;

  SELECT count(*)
    INTO v_active_entries
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
    JOIN public.club_members cm
      ON cm.club_id = t.club_id AND cm.user_id = tp.user_id
   WHERE t.club_id = v_club
     AND cm.is_bot
     AND upper(t.status::text) NOT IN ('COMPLETED', 'CANCELLED');

  IF v_bot_count = 0 THEN
    RETURN;
  END IF;

  IF v_bot_count <> 416 OR v_bot_chips <> 0 OR v_active_seats <> 0 OR v_active_entries <> 0 THEN
    RAISE EXCEPTION
      'Deep Stack Bot-Membership Cleanup Guard Failed: count %, chips %, seats %, entries %',
      v_bot_count, v_bot_chips, v_active_seats, v_active_entries;
  END IF;

  DELETE FROM public.club_members
   WHERE club_id = v_club AND is_bot;
END;
$repair$;

ALTER TABLE public.club_members
  VALIDATE CONSTRAINT club_members_bot_house_only;

DO $verify$
DECLARE
  v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club)
     AND (
       (SELECT count(*) FROM public.club_members WHERE club_id = v_club) <> 1
       OR EXISTS (SELECT 1 FROM public.club_members WHERE club_id = v_club AND is_bot)
     )
  THEN
    RAISE EXCEPTION 'Deep Stack Membership Postcondition Failed';
  END IF;
END;
$verify$;
