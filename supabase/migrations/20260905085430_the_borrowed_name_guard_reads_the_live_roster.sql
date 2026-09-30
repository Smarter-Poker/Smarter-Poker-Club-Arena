-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905085430; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905085430   (the stamp IS the apply time, UTC: 2026-09-05 08:54:30)
--   name        the_borrowed_name_guard_reads_the_live_roster
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4488 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905085430 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_reject_horse_name_on_human
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- THE BORROWED-NAME GUARD READS THE LIVE ROSTER (2026-09-05)
--
-- `fn_reject_horse_name_on_human` is a live BEFORE trigger on `profiles`. It
-- stops a human taking a horse's display name - a real anti-impersonation
-- rule, because a player wearing a known horse's name confuses everyone at the
-- table about who they are sitting with.
--
-- IT HAS NEVER PROTECTED A SINGLE LIVE HORSE. It checks the name against
-- `public.ai_horses`, a legacy table nothing has written to since before
-- statistics were last reset. Measured 2026-09-05:
--
--   live horses (profiles.is_horse)                     1,000
--   distinct display names among them                     803
--   rows in ai_horses                                     100
--   live horse names the guard actually covers              0
--
-- Not "few" - zero. None of the 1,000 current horse profiles has a name that
-- appears in ai_horses, so every one of them is takeable. The guard has run on
-- every profile write, done nothing, and looked like a control the whole time.
--
-- Nobody has used it: humans currently holding a horse's name is 0. There are
-- four human accounts on the platform, which is exactly why this is the moment
-- to fix it rather than the moment to shrug.
--
-- THE FIX asks the roster that is true: profiles where is_horse. Behaviour is
-- otherwise unchanged - the name is dropped rather than the write refused,
-- because this fires on ordinary profile saves and a hard error would block a
-- player editing something unrelated.
--
-- CLAUDE.md 10.5 note: this is not an is_horse EXCLUSION. It denies a horse
-- nothing; it reads is_horse as DATA to tell whose name is whose, which 10.5
-- explicitly permits ("surfacing the flag as DATA").

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
-- performs an actual UPDATE and the closing RAISE aborts the whole migration
-- block... which is why the assertions below RAISE only on FAILURE, and the
-- successful path falls through to COMMIT the function change. The UPDATE is
-- undone explicitly instead.
DO $probe$
DECLARE
  v_human      uuid;
  v_orig       text;
  v_horse_name text;
  v_after      text;
BEGIN
  SELECT id, display_name INTO v_human, v_orig
    FROM public.profiles
   WHERE NOT COALESCE(is_horse, false)
   ORDER BY created_at NULLS LAST
   LIMIT 1;
  IF v_human IS NULL THEN
    RAISE EXCEPTION 'no human profile to probe with';
  END IF;

  -- A live horse name that ai_horses does NOT cover: the old guard let this
  -- through, the new one must strip it.
  SELECT btrim(p.display_name) INTO v_horse_name
    FROM public.profiles p
   WHERE COALESCE(p.is_horse, false) AND p.display_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ai_horses h
                      WHERE btrim(h.name) ILIKE btrim(p.display_name))
   LIMIT 1;
  IF v_horse_name IS NULL THEN
    RAISE EXCEPTION 'no live horse name outside ai_horses to test with';
  END IF;

  UPDATE public.profiles SET display_name = v_horse_name WHERE id = v_human;
  SELECT display_name INTO v_after FROM public.profiles WHERE id = v_human;

  -- Put it back before judging, so a failed assertion cannot leave it changed.
  UPDATE public.profiles SET display_name = v_orig WHERE id = v_human;

  IF v_after IS NOT NULL THEN
    RAISE EXCEPTION
      'guard did not strip the borrowed name: human kept %, expected NULL', v_after;
  END IF;

  RAISE NOTICE 'probe ok: a human asking for live horse name "%" had it stripped, and the original name was restored', v_horse_name;
END
$probe$;
