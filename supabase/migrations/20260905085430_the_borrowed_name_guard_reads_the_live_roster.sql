-- THE BORROWED-NAME GUARD READS THE LIVE ROSTER (2026-09-05)
--
-- `fn_reject_horse_name_on_human` is a live BEFORE trigger on `profiles`. It
-- stops a human taking a horse's display name - a real anti-impersonation
-- rule, because a player wearing a known horse's name confuses everyone at the
-- table about who they are sitting with.
--
-- IT HAS NEVER PROTECTED A SINGLE LIVE HORSE. It checked the name against
-- `public.ai_horses`, a legacy table nothing has written to since before
-- statistics were last reset. Measured 2026-09-05:
--
--   live horses (profiles.is_horse)                     1,000
--   distinct display names among them                     803
--   rows in ai_horses                                     100
--   live horse names the guard actually covered             0
--
-- Not "few" - zero. None of the 1,000 current horse profiles had a name that
-- appears in ai_horses, so every one of them was takeable. The guard ran on
-- every profile write, did nothing, and looked like a control the whole time.
--
-- Nobody had used it: humans holding a horse's name was 0. There are four
-- active human accounts, which is exactly why this is the moment to fix it
-- rather than the moment to shrug.
--
-- THE FIX asks the roster that is true: profiles where is_horse. Behaviour is
-- otherwise unchanged - the name is dropped rather than the write refused,
-- because this fires on ordinary profile saves and a hard error would block a
-- player editing something unrelated.
--
-- CLAUDE.md 10.5 note: this is not an is_horse EXCLUSION. It denies a horse
-- nothing; it reads is_horse as DATA to tell whose name is whose, which 10.5
-- explicitly permits ("surfacing the flag as DATA").
--
-- APPLIED 2026-09-05. After: 803 horse names protected, up from 0.

CREATE OR REPLACE FUNCTION public.fn_reject_horse_name_on_human()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.is_horse, false) = false
     AND NEW.display_name IS NOT NULL
     AND btrim(NEW.display_name) <> ''
     AND EXISTS (
       SELECT 1
         FROM public.profiles h
        WHERE COALESCE(h.is_horse, false)
          AND h.display_name IS NOT NULL
          AND h.id IS DISTINCT FROM NEW.id
          AND btrim(h.display_name) ILIKE btrim(NEW.display_name)
     )
  THEN
    -- Drop the borrowed name instead of failing the whole write: this fires on
    -- ordinary profile saves, and a hard error would block a player editing
    -- something unrelated. The name is the only thing rejected.
    NEW.display_name := NULL;
  END IF;
  RETURN NEW;
END $function$;

-- ── PROVE IT AGAINST THE REAL TRIGGER, AND KEEP NOTHING ────────────────────
-- CLAUDE.md 11.5. A trigger function cannot be called directly, so the probe
-- performs a real UPDATE and restores the original value before judging, so a
-- failed assertion cannot leave a profile changed.
DO $probe$
DECLARE
  v_human uuid; v_orig text; v_horse_name text; v_after text;
BEGIN
  SELECT id, display_name INTO v_human, v_orig
    FROM public.profiles WHERE NOT COALESCE(is_horse, false)
   ORDER BY created_at NULLS LAST LIMIT 1;
  IF v_human IS NULL THEN RAISE EXCEPTION 'no human profile to probe with'; END IF;

  SELECT btrim(p.display_name) INTO v_horse_name
    FROM public.profiles p
   WHERE COALESCE(p.is_horse, false) AND p.display_name IS NOT NULL
   LIMIT 1;
  IF v_horse_name IS NULL THEN RAISE EXCEPTION 'no live horse name to test with'; END IF;

  UPDATE public.profiles SET display_name = v_horse_name WHERE id = v_human;
  SELECT display_name INTO v_after FROM public.profiles WHERE id = v_human;
  UPDATE public.profiles SET display_name = v_orig WHERE id = v_human;

  IF v_after IS NOT NULL THEN
    RAISE EXCEPTION 'guard did not strip the borrowed name: human kept %', v_after;
  END IF;
  RAISE NOTICE 'probe ok: "%" was stripped and the original name restored', v_horse_name;
END
$probe$;
