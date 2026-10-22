-- 20261022050713_horse_table_talk_and_gestures_on.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21: "HORSES SHOULD SOMETIMES THROW SOME EMOJI'S AT PLAYERS THAT
-- BEAT THEM IN A HAND, OR BEFORE THEY GO ALL IN CLICK OR SEND THE GOOD LUCK
-- EMOJI ... CURRENTLY THEY NEVER THROW ANYTHING AT ALL EVER" and "THEY NEED TO
-- SOMETIMES SAY THINGS LIKE NICE HAND OR YOU GOT LUCKY ... INSIDE THE CHAT
-- AFTER A HAND IS OVER. FULLY IMPLEMENT BOTH OF THESE."
--
-- Read from production before this migration: horse_post_modes 'table_talk'
-- enabled = false and horse_table_talk_ledger had 0 rows (no horse had ever
-- spoken), and throwable_use_receipts held 0 rows for any horse.
--
-- 1. table_talk is switched ON: Dan approved it in the words above.
-- 2. table_gestures is a new mode row, ON, the switch HorseTableGestures.ts
--    reads for throwables and reactions (same 30 second fail-closed gate).
-- 3. fn_horse_use_throwable: the engine charges a horse's throw through the
--    SAME fn_use_throwable_v2 a person's browser calls (same allowance, same
--    1.5 s cooldown, same receipts), by binding the horse's own id as the
--    caller for that one call. It refuses any id that is not a horse, so it
--    can never be used to throw as a person. Service role only.

BEGIN;

UPDATE public.horse_post_modes
   SET enabled = true,
       approved_by = 'Dan (owner instruction 2026-10-21)',
       approved_at = now()
 WHERE mode = 'table_talk';

INSERT INTO public.horse_post_modes (mode, enabled, description, approved_by, approved_at)
VALUES (
  'table_gestures',
  true,
  'A seated horse sometimes throws a throwable at a player who beat it, at a player it beat, or as it moves all in, and sometimes taps a reaction. Charged and broadcast exactly as a person''s throw.',
  'Dan (owner instruction 2026-10-21)',
  now()
)
ON CONFLICT (mode) DO UPDATE
   SET enabled = true,
       approved_by = EXCLUDED.approved_by,
       approved_at = EXCLUDED.approved_at;

CREATE OR REPLACE FUNCTION public.fn_horse_use_throwable(
  p_horse_id uuid,
  p_throwable_id text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_horse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown User');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_horse_id AND p.is_horse IS TRUE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not A Horse');
  END IF;

  -- auth.uid() reads these for the rest of THIS transaction only.
  PERFORM set_config('request.jwt.claim.sub', p_horse_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_horse_id::text, 'role', 'authenticated')::text,
    true
  );

  RETURN public.fn_use_throwable_v2(p_throwable_id, p_request_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_use_throwable(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_use_throwable(uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_horse_use_throwable(uuid, text, uuid) IS
  'Engine only: charge a horse''s throwable through fn_use_throwable_v2 as that horse. Refuses non-horse ids.';

COMMIT;
