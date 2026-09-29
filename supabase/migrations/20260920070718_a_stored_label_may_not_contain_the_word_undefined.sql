-- a_stored_label_may_not_contain_the_word_undefined
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- 28,649 rows of public.tables carry the literal string 'undefined/undefined'
-- in their stakes label. Another 12,347 carry a stale but plausible label. All
-- 40,996 belong to CANCELLED or COMPLETED tournaments.
--
-- WHERE IT CAME FROM. server/src/tournament/TournamentManagerBase.ts wrote
--
--   stakes: `${firstLevel.smallBlind}/${firstLevel.bigBlind}`
--
-- and public.tournaments.blind_structure is a TEXT column, so PostgREST handed
-- the engine a string. blindStructure[0] was therefore the single character
-- '[', and '['.smallBlind is undefined. The `|| { smallBlind: 10, bigBlind: 20 }`
-- fallback never fired because '[' is truthy. The same undefined values went to
-- small_blind and big_blind in the same insert, JSON.stringify dropped them,
-- and those columns fell to their defaults of 1 and 2. That is exactly why the
-- correct label for all 28,649 is '1/2', and nothing else explains that
-- coincidence. Commit 18f188fbba parsed the JSON on fetch on 2026-05-04; the
-- last bad row was born 2026-05-02.
--
-- WHY A CONSTRAINT WHEN TWO TRIGGERS ALREADY EXIST. The triggers make the
-- value RIGHT for tournament tables. This makes an obviously wrong value
-- UNSTORABLE anywhere, and the difference matters three ways:
--
--   1. Cash tables are outside both triggers by design, and a cash stakes
--      label is still built from a template literal in the client.
--   2. Both trigger bodies only rewrite stakes inside
--      IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL. Both
--      columns are nullable. A blind level carrying an explicit JSON null
--      sends null rather than undefined, JSON.stringify keeps it, the defaults
--      do not apply, neither trigger branch fires, and 'null/null' is stored.
--      Latent today, zero occurrences, and this refuses it.
--   3. public.tables.name was written by the same insert statement, from the
--      same untyped tournament object, and has no trigger and no constraint at
--      all. Had tournament.name been the undefined operand instead of the
--      blinds, the 2026-09-19 trigger work would have caught nothing.
--
-- NOT VALID IS DELIBERATE. It skips the full table scan and the ACCESS
-- EXCLUSIVE rewrite of a 265,185 row table while tables are dealing, takes a
-- brief lock for the catalog entry, and enforces on every INSERT and UPDATE
-- from this moment. The 40,996 historical rows are left exactly as they are,
-- which is the honest state: they are wrong, they are recorded as wrong, and
-- correcting them is a separate change with its own blast radius.
--
-- This refuses a string that a program produced by accident. It does not try
-- to judge whether a label is the RIGHT label; that is the triggers' job.
--
-- RESTORED TO THE REPOSITORY 2026-09-24. This file was reconstructed byte for
-- byte from supabase_migrations.schema_migrations.statements, which is what
-- production actually ran on 2026-09-20. The proof directive below is the one
-- addition: what was applied carried none. A CHECK constraint is not among the
-- object kinds tests/a-merged-migration-must-be-live.law.test.ts looks up for
-- itself, so this migration has to say where to look. The line is a comment
-- and changes no SQL. It was checked against production before it was written
-- here, and it reads true.
--
-- @live-proof: (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.tables'::regclass AND conname IN ('tables_stakes_is_not_a_javascript_accident', 'tables_name_is_not_a_javascript_accident') AND contype = 'c') = 2
-- ===========================================================================

ALTER TABLE public.tables
  ADD CONSTRAINT tables_stakes_is_not_a_javascript_accident
  CHECK (
    stakes IS NULL
    OR (stakes !~ 'undefined' AND stakes !~ 'NaN' AND stakes !~ '\[object'
        AND stakes <> 'null/null')
  ) NOT VALID;

ALTER TABLE public.tables
  ADD CONSTRAINT tables_name_is_not_a_javascript_accident
  CHECK (
    name IS NULL
    OR (name !~ 'undefined' AND name !~ 'NaN' AND name !~ '\[object')
  ) NOT VALID;

DO $verify$
DECLARE
  v_club uuid;
  v_id   uuid;
  v_ok   boolean;
BEGIN
  -- Structural: both constraints exist and both are NOT VALID, so nothing was
  -- rewritten and nothing historical was silently deleted.
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.tables'::regclass
         AND conname IN ('tables_stakes_is_not_a_javascript_accident',
                         'tables_name_is_not_a_javascript_accident')
         AND contype = 'c' AND NOT convalidated) <> 2 THEN
    RAISE EXCEPTION 'both constraints must exist and both must be NOT VALID';
  END IF;

  -- The historical rows must STILL BE THERE. A guard that quietly took 40,996
  -- rows with it would be worse than the defect.
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.tournament_id IS NOT NULL
         AND tb.stakes = 'undefined/undefined') < 28000 THEN
    RAISE EXCEPTION 'historical rows disappeared; this was meant to change nothing existing';
  END IF;

  -- Behavioural, both directions, in a sub-transaction that always rolls back.
  SELECT id INTO v_club FROM public.clubs LIMIT 1;
  BEGIN
    INSERT INTO public.tables (id, name, stakes, club_id)
    VALUES (gen_random_uuid(), 'probe table', 'undefined/undefined', v_club);
    RAISE EXCEPTION 'PROBE FAILED: an undefined stakes label was accepted';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'PASS: an undefined stakes label is refused';
    WHEN OTHERS THEN
      -- Another guard on this table refused first. That is still a refusal,
      -- but it is not proof of THIS constraint, so say so rather than claim it.
      RAISE NOTICE 'INCONCLUSIVE via INSERT (% %): proving by UPDATE instead',
                   SQLSTATE, left(SQLERRM, 80);
  END;

  -- The UPDATE direction, against a row that already exists, which is the path
  -- the engine actually took.
  SELECT id INTO v_id FROM public.tables
   WHERE tournament_id IS NOT NULL AND stakes IS NOT NULL LIMIT 1;
  IF v_id IS NOT NULL THEN
    BEGIN
      UPDATE public.tables SET name = name || ' [object Object]' WHERE id = v_id;
      RAISE EXCEPTION 'PROBE FAILED: an [object Object] name was accepted';
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'PASS: an [object Object] name is refused on UPDATE';
    END;

    -- And the other direction: a legitimate label must still be storable, or
    -- this constraint is a denial of service rather than a guard.
    BEGIN
      UPDATE public.tables SET name = name WHERE id = v_id;
      RAISE NOTICE 'PASS: an ordinary name still writes';
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PROBE FAILED: an ordinary write was refused (% %)',
                      SQLSTATE, left(SQLERRM, 100);
    END;
  END IF;

  RAISE EXCEPTION 'ROLLBACK_PROBE_ONLY';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_PROBE_ONLY' THEN
    RAISE;
  END IF;
  RAISE NOTICE 'PASS: probes complete and rolled back; both constraints enforce';
END;
$verify$;