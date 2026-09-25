-- 20260924183047_a_horse_does_not_take_a_name_a_person_answers_to
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-24 18:30:47 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE RULE WAS ONLY EVER ENFORCED FROM ONE SIDE
--
-- Dan, 2026-08-23, verbatim in the header of
-- 20260823050000_strip_horse_names_from_human_profiles.sql:
--
--   "FIX IT, MARCUS CHEN IS A HORSE. IM DAN BEKAVAC ON SOCIAL AND KINGFISH IN
--    THE CLUB ARENA. NOTHING ELSE."
--
-- The state that migration outlawed is a person's profile carrying the name of
-- a house horse. The guard it installed, fn_reject_horse_name_on_human, asks
-- the question only of the row being written, and only when that row is a
-- person: an incoming display_name that matches a horse is dropped. The horse
-- side was never asked. Write a horse with a name a person is already using
-- and you reach the identical forbidden state from the other direction, and
-- nothing looks.
--
-- MEASURED ON PRODUCTION 2026-09-24, as one self-aborting DO block
-- (scripts/dev/probe-rpc.sql, the MCP shape):
--
--   before   people whose display_name matches a horse name         0
--   probe    UPDATE profiles SET display_name = <the first human by
--            id, which is the owner> WHERE id = <the first horse by id>
--   after    people whose display_name matches a horse name         1
--
-- The write was permitted in full. No error, no truncation, no warning. The
-- owner's own profile name became a horse's name, and every surface that
-- resolves a person through display_name would have greeted him as one of the
-- fleet, which is the exact complaint of 2026-08-23. The probe aborted itself,
-- so nothing was committed.
--
-- IT IS REACHABLE FROM THE ONLY WRITER THERE IS. createHorse() in
-- server/src/services/HorseOnboarding.ts inserts display_name: ident.realName,
-- and identityFor() builds that name by hashing the horse id across a FIRST
-- and a LAST list. Nothing consults the people already on the platform. A
-- roster expansion that draws a pair a member is using takes that member's
-- name silently. ensureHorseComplete() refills an absent horse name from the
-- same generator, and sweepIncompleteHorses() runs it over the fleet at boot.
--
-- WHY THE TWO SIDES ARE NOT TREATED THE SAME. The person side drops the name
-- and lets the write through, because it fires on ordinary profile saves and
-- an exception there would block a player editing something unrelated. That
-- reasoning is in the 2026-08-23 file and is unchanged here. The horse side
-- raises instead. A horse is written by server code on a controlled path,
-- createHorse already catches and reports, and the fleet must not be handed a
-- null name: ensureHorseComplete would refill it from the same generator at
-- the next boot and the pair would collide again, for ever. Refusing states
-- the problem once, to the caller that can choose another name.
--
-- WHAT THIS DOES NOT DO. No trigger is created, dropped or reordered, and no
-- row is backfilled. trg_reject_horse_name_on_human already fires BEFORE
-- INSERT OR UPDATE OF display_name, is_horse, which is exactly the set of
-- writes that can introduce a horse name, so only the function body changes.
-- Production carries 0 collisions in either direction today, so there is
-- nothing to clean up before the guard can hold.
--
-- EVERY CONJUNCT IN THE NEW BRANCH IS LOAD BEARING, measured today:
--
--   a name that is absent or blank is not a collision
--     18 people carry a null display_name and a blank one is storable
--     (probed), so without this a nameless horse would be refused for
--     matching a nameless person.
--   only PEOPLE are counted
--     126 horse names are shared by two or more horses. Without this,
--     createHorse would be refused for 126 name groups of the fleet's own.
--   a profile does not collide with itself
--     flipping is_horse on an existing profile is permitted in service
--     context (probed). The stored row still reads as a person during that
--     write, so without this every such flip would be refused for wearing
--     its own name.
--   the comparison itself, trimmed and case folded
--     the established borrowed-name rule, unchanged from 2026-09-13.
--
-- @live-proof: obj_description('public.fn_reject_horse_name_on_human()'::regprocedure, 'pg_proc') LIKE '%horse_name_symmetry%'
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
DECLARE
  v_md5       text;
  v_trigger   text;
  v_people    bigint;
  v_horses    bigint;
BEGIN
  -- (a) The function this rewrites is the one that was read, not a newer one
  --     somebody else already fixed. Same shape as 20260913173936.
  v_md5 := md5(pg_get_functiondef('public.fn_reject_horse_name_on_human()'::regprocedure));
  IF v_md5 <> 'bc49ba9c4d67907f054ad6e2ed2ba8d8' THEN
    RAISE EXCEPTION 'refused: fn_reject_horse_name_on_human is not the definition this was written against (md5 %). Re-read it, do not guess.', v_md5;
  END IF;

  -- (b) The trigger already covers the writes that can introduce a name, so
  --     this migration has no business touching it.
  SELECT pg_get_triggerdef(oid) INTO v_trigger
    FROM pg_trigger
   WHERE tgrelid = 'public.profiles'::regclass
     AND tgname = 'trg_reject_horse_name_on_human';
  IF v_trigger IS DISTINCT FROM 'CREATE TRIGGER trg_reject_horse_name_on_human BEFORE INSERT OR UPDATE OF display_name, is_horse ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_reject_horse_name_on_human()' THEN
    RAISE EXCEPTION 'refused: trg_reject_horse_name_on_human is not the trigger this was written against (%)', coalesce(v_trigger, 'absent');
  END IF;

  -- (c) Nothing is already in the state the new branch refuses, so installing
  --     it wedges no existing row.
  SELECT count(*) INTO v_people
    FROM public.profiles u
   WHERE NOT COALESCE(u.is_horse, false)
     AND coalesce(btrim(u.display_name), '') <> ''
     AND EXISTS (
       SELECT 1 FROM public.profiles h
        WHERE COALESCE(h.is_horse, false)
          AND h.id IS DISTINCT FROM u.id
          AND lower(btrim(h.display_name)) = lower(btrim(u.display_name)));
  IF v_people <> 0 THEN
    RAISE EXCEPTION 'refused: % person profile(s) already carry a horse name; clean that up first', v_people;
  END IF;

  -- (d) The fleet itself must be legal under the branch about to be installed.
  SELECT count(*) INTO v_horses
    FROM public.profiles h
   WHERE COALESCE(h.is_horse, false)
     AND coalesce(btrim(h.display_name), '') <> ''
     AND EXISTS (
       SELECT 1 FROM public.profiles u
        WHERE NOT COALESCE(u.is_horse, false)
          AND u.id IS DISTINCT FROM h.id
          AND lower(btrim(u.display_name)) = lower(btrim(h.display_name)));
  IF v_horses <> 0 THEN
    RAISE EXCEPTION 'refused: % horse(s) already wear a person name; the guard would wedge them', v_horses;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_reject_horse_name_on_human()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.is_horse, false) = false THEN
    IF NEW.display_name IS NOT NULL
       AND btrim(NEW.display_name) <> ''
       AND EXISTS (
         SELECT 1
           FROM public.profiles h
          WHERE COALESCE(h.is_horse, false)
            AND h.display_name IS NOT NULL
            AND h.id IS DISTINCT FROM NEW.id
            AND lower(btrim(h.display_name)) = lower(btrim(NEW.display_name))
       )
    THEN
      -- Drop the borrowed name instead of failing the whole write: this fires on
      -- ordinary profile saves, and a hard error would block a player editing
      -- something unrelated. The name is the only thing rejected.
      NEW.display_name := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- The same rule from the other side. A horse may not be written carrying a
  -- name a person is using, because that produces the state of 2026-08-23 with
  -- the two rows written in the opposite order. This side raises: see the
  -- header for why a null name cannot be the answer for a horse.
  IF coalesce(btrim(NEW.display_name), '') <> ''
     AND EXISTS (
       SELECT 1
         FROM public.profiles u
        WHERE NOT COALESCE(u.is_horse, false)
          AND u.id IS DISTINCT FROM NEW.id
          AND lower(btrim(u.display_name)) = lower(btrim(NEW.display_name))
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a horse may not be given the name of a person on this platform',
      HINT    = 'choose another name for the horse; the person keeps theirs';
  END IF;
  RETURN NEW;
END $function$;

COMMENT ON FUNCTION public.fn_reject_horse_name_on_human() IS
  'Both directions of the borrowed-name rule of 2026-08-23. A person written with a horse name loses the name; a horse written with a person name is refused. horse_name_symmetry';

DO $verify$
DECLARE
  v_horse    uuid;
  v_person   uuid;
  v_name     text;
  v_free     text;
  v_outcome  text;
  v_seen     text;
  v_left     bigint;
BEGIN
  SELECT id INTO v_horse FROM public.profiles
   WHERE COALESCE(is_horse, false) ORDER BY id LIMIT 1;
  SELECT id, display_name INTO v_person, v_name FROM public.profiles
   WHERE NOT COALESCE(is_horse, false) AND coalesce(btrim(display_name), '') <> ''
   ORDER BY id LIMIT 1;
  IF v_horse IS NULL OR v_person IS NULL THEN
    RAISE EXCEPTION 'failed: production has no horse and named person to verify against';
  END IF;
  v_free := 'verify ' || replace(gen_random_uuid()::text, '-', '');

  -- 1. THE HOLE IS CLOSED. A horse handed a person's name is refused, and the
  --    refusal is what rolls the attempt back: nothing is written here.
  BEGIN
    UPDATE public.profiles SET display_name = v_name WHERE id = v_horse;
    v_outcome := 'permitted';
  EXCEPTION WHEN check_violation THEN
    v_outcome := 'refused';
  END;
  IF v_outcome <> 'refused' THEN
    RAISE EXCEPTION 'failed: a horse was still given a person name';
  END IF;

  -- 2. A HORSE IS STILL RENAMEABLE. The guard refuses a collision, not a
  --    rename. Carried back out of its own subtransaction by the sentinel.
  BEGIN
    UPDATE public.profiles SET display_name = v_free WHERE id = v_horse;
    SELECT coalesce(display_name, '<null>') INTO v_seen FROM public.profiles WHERE id = v_horse;
    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'rb:' || v_seen;
  EXCEPTION
    WHEN data_exception THEN v_seen := substring(SQLERRM from 'rb:(.*)$');
    WHEN OTHERS THEN v_seen := 'refused: ' || SQLERRM;
  END;
  IF v_seen IS DISTINCT FROM v_free THEN
    RAISE EXCEPTION 'failed: an ordinary horse rename no longer holds (%)', v_seen;
  END IF;

  -- 3. A PERSON'S ORDINARY SAVE IS UNTOUCHED, and a person reaching for a
  --    horse's name still loses only the name, exactly as before.
  BEGIN
    UPDATE public.profiles SET display_name = v_free WHERE id = v_person;
    SELECT coalesce(display_name, '<null>') INTO v_seen FROM public.profiles WHERE id = v_person;
    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'rb:' || v_seen;
  EXCEPTION
    WHEN data_exception THEN v_seen := substring(SQLERRM from 'rb:(.*)$');
    WHEN OTHERS THEN v_seen := 'refused: ' || SQLERRM;
  END;
  IF v_seen IS DISTINCT FROM v_free THEN
    RAISE EXCEPTION 'failed: an ordinary person profile save no longer holds (%)', v_seen;
  END IF;

  SELECT display_name INTO v_seen FROM public.profiles WHERE id = v_horse;
  BEGIN
    UPDATE public.profiles SET display_name = v_seen WHERE id = v_person;
    SELECT coalesce(display_name, '<null>') INTO v_seen FROM public.profiles WHERE id = v_person;
    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'rb:' || v_seen;
  EXCEPTION
    WHEN data_exception THEN v_seen := substring(SQLERRM from 'rb:(.*)$');
    WHEN OTHERS THEN v_seen := 'refused: ' || SQLERRM;
  END;
  IF v_seen <> '<null>' THEN
    RAISE EXCEPTION 'failed: a person reaching for a horse name kept it (%)', v_seen;
  END IF;

  -- 4. THE POST STATE, exactly. Neither direction holds a collision, and the
  --    comment the liveness check reads is in place.
  SELECT count(*) INTO v_left
    FROM public.profiles a JOIN public.profiles b
      ON a.id IS DISTINCT FROM b.id
     AND lower(btrim(a.display_name)) = lower(btrim(b.display_name))
   WHERE COALESCE(a.is_horse, false)
     AND NOT COALESCE(b.is_horse, false)
     AND coalesce(btrim(a.display_name), '') <> '';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'failed: % name collision(s) between the fleet and the people', v_left;
  END IF;
  IF obj_description('public.fn_reject_horse_name_on_human()'::regprocedure, 'pg_proc')
     NOT LIKE '%horse_name_symmetry%' THEN
    RAISE EXCEPTION 'failed: the function carries no comment for the liveness check to read';
  END IF;

  RAISE NOTICE 'PASS: the borrowed-name rule now holds from both sides; 0 collisions';
END;
$verify$;

COMMIT;

-- ROLLBACK: restore the one-sided body recorded at
--   20260913173936_horse_identity_triggers_use_canonical_profiles.sql
-- and drop the comment. The trigger is untouched by this migration.
