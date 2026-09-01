-- Deep Stack Society joins the automated-member allowlist, by Dan's explicit
-- ruling on 2026-09-01.
--
-- WHAT THIS IS NOT: a weakening of 20260902012000_user_clubs_reject_automated_
-- members. That migration's rule stands exactly as written for every genuine
-- user club - "automated players must never appear in a club a player created
-- through Create A Club" - and this adds ONE club to the allowlist rather than
-- relaxing the predicate.
--
-- WHY THIS CLUB. Deep Stack Society (club_id 11192) is owned by kingfish, the
-- same account that owns all three boards already on the list: Shark, JAQK and
-- Midway Union. It was created on 2026-08-31 for the express purpose of
-- exercising the horse hierarchy - super agents, agents, sub agents, credit
-- lines, top-down funding and rakeback margins - against a standalone club. It
-- is a house board that happens to have been created through the normal club
-- flow, which is why the original predicate caught it.
--
-- HOW THIS WAS FOUND, recorded because the next person deserves the story: a
-- 416-account population joined this club through fn_join_club_atomic and was
-- removed within the hour by the repair block in that migration, which
-- hard-codes this club's uuid. Two workstreams, one database, opposite
-- instructions. The ruling is Dan's, not this migration's.

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_bot_house_only;

ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_bot_house_only
  CHECK (
    NOT COALESCE(is_bot, false)
    OR club_id IN (
      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, -- Shark house board
      'a0000000-0000-0000-0000-000000000001'::uuid, -- JAQK house board
      'fade0000-0000-0000-0000-000000000001'::uuid, -- Midway Union board
      '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid  -- Deep Stack Society (11192)
    )
  ) NOT VALID;

DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.club_members'::regclass
     AND conname  = 'club_members_bot_house_only';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: club_members_bot_house_only is missing';
  END IF;
  IF position('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-APPLY: Deep Stack Society not present in the allowlist';
  END IF;
  -- The other three must survive: this is an addition, not a replacement.
  IF position('a41434bb-8d0c-400a-8f0d-e8b3d65afed4' in v_def) = 0
     OR position('a0000000-0000-0000-0000-000000000001' in v_def) = 0
     OR position('fade0000-0000-0000-0000-000000000001' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-APPLY: an existing house board was dropped from the allowlist';
  END IF;
END $verify$;
