-- 20260920074830_a_stored_label_may_not_contain_the_word_undefined
--
-- Applied to production as version 20260920070718 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- RECORDED AFTER THE FACT. This change was applied to production through the
-- Supabase MCP and was never written into the repository. Both constraint
-- expressions below were read back out of the live catalog with
-- pg_get_constraintdef and checked byte for byte against what it returned.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- 28,649 rows of public.tables held, as their displayed stakes, the literal
-- string
--
--   undefined/undefined
--
-- Players saw it. It was never a number that was wrong; it was the word
-- "undefined" written into a money label and stored.
--
-- THE CAUSE, EXACTLY. In server/src/tournament/TournamentManagerBase.ts the
-- label was built as
--
--   stakes: `${firstLevel.smallBlind}/${firstLevel.bigBlind}`
--
-- and firstLevel came from blindStructure[0]. blind_structure is a TEXT
-- column and it was never parsed, so blindStructure was a STRING, not an
-- array, and blindStructure[0] was its first CHARACTER: the literal `[`. A
-- character has no smallBlind and no bigBlind, both reads returned undefined,
-- and template interpolation turned each of them into the six letters of
-- their own name. JavaScript does not throw here. It formats.
--
-- WHY THE ROWS ARE NOT SIMPLY WRONG BY A LITTLE. The same two undefined
-- values were also assigned to small_blind and big_blind. Those went through
-- JSON.stringify on the way to the database, and JSON.stringify DROPS a key
-- whose value is undefined, so the columns were not sent at all and fell to
-- their column defaults, 1 and 2. That is the whole explanation for a fact
-- that otherwise looks like a coincidence: the correct label for every one of
-- these rows is 1/2, because the blinds really are 1 and 2. The row is
-- internally consistent. Only the text is nonsense.
--
-- FIXED UPSTREAM ALREADY, by commit 18f188fbba on 2026-05-04, which parses
-- blind_structure before indexing it. This migration does not fix the defect.
-- It stops the database accepting the shape of the defect, so that the next
-- version of this mistake, in any writer, fails at the moment of the write
-- instead of being discovered by a player months later.
--
-- ===========================================================================
-- WHY NOT VALID, AND WHY THAT IS NOT A COMPROMISE
--
-- NOT VALID is deliberate and it is doing two separate jobs.
--
-- It means the constraint is NOT checked against the rows already there, so
-- adding it takes no ACCESS EXCLUSIVE rewrite of a 272,916 row table on a live
-- platform. It is a catalog change and it is instant.
--
-- It also means the historical rows are left exactly as they are. They are a
-- record of what was displayed to players at the time, on events that have
-- long since ended, and rewriting them would be editing history to make a
-- number look tidy. What NOT VALID does not weaken is the part that matters:
-- Postgres still enforces a NOT VALID check on every INSERT and on every
-- UPDATE. New rows cannot carry this, and an old row cannot be updated into
-- carrying it.
--
-- THE SURVIVING ROWS SHRINK ON THEIR OWN, and that is why the count in this
-- header will not match the count in the database. All of the affected rows
-- are tournament tables, and 20260919184835 gave tables.stakes an UPDATE
-- owner, zzzzzz_tables_stakes_follows_its_own_blinds, which derives the label
-- from the row's own blinds. Any write that touches one of these rows
-- therefore corrects it to 1/2 on the way past, and it satisfies the new
-- constraint while doing so. Measured when this migration was applied: 28,649.
-- Measured against production when this file was written: 23,629, all of them
-- tournament tables and none of them cash tables. The number goes one way.
--
-- ===========================================================================
-- WHY tables.name GETS THE SAME GUARD
--
-- name was written by the SAME INSERT STATEMENT as stakes, from the same
-- object, in the same code path. It is the same defect one field along, and it
-- was only luck that the name template did not read the same undefined values.
--
-- It is also the WEAKER of the two, which is the actual argument for guarding
-- it. stakes now has a trigger that owns it on INSERT and on UPDATE and would
-- overwrite a bad value before it landed. name has NO TRIGGER AT ALL. Nothing
-- stands between a writer and this column except the constraint added here.
--
-- Both expressions guard more than the one word that was observed. "NaN" and
-- "[object" are the other two ways a JavaScript value stringifies into a label
-- instead of failing, and the stakes expression additionally rejects
-- 'null/null', which is the same accident with null in place of undefined.
-- NULL itself is allowed: a table with no stakes yet is a real state, and this
-- constraint is about nonsense, not about absence.
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.tables'::regclass AND conname IN ('tables_stakes_is_not_a_javascript_accident','tables_name_is_not_a_javascript_accident') AND NOT convalidated)
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $add$
BEGIN
  -- ADD CONSTRAINT has no IF NOT EXISTS, and this file has already been
  -- applied to production, where both constraints are in place. Ask pg_constraint
  -- first so a re-run against production is a no-op and a fresh rebuild gets
  -- the guard. The expressions below are the catalog's own text, read back
  -- with pg_get_constraintdef and not retyped.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tables'::regclass
                    AND conname = 'tables_stakes_is_not_a_javascript_accident') THEN
    EXECUTE $ddl$ALTER TABLE public.tables
      ADD CONSTRAINT tables_stakes_is_not_a_javascript_accident
      CHECK (((stakes IS NULL) OR ((stakes !~ 'undefined'::text) AND (stakes !~ 'NaN'::text) AND (stakes !~ '\[object'::text) AND (stakes <> 'null/null'::text)))) NOT VALID$ddl$;
    RAISE NOTICE 'added tables_stakes_is_not_a_javascript_accident';
  ELSE
    RAISE NOTICE 'tables_stakes_is_not_a_javascript_accident already present';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tables'::regclass
                    AND conname = 'tables_name_is_not_a_javascript_accident') THEN
    EXECUTE $ddl$ALTER TABLE public.tables
      ADD CONSTRAINT tables_name_is_not_a_javascript_accident
      CHECK (((name IS NULL) OR ((name !~ 'undefined'::text) AND (name !~ 'NaN'::text) AND (name !~ '\[object'::text)))) NOT VALID$ddl$;
    RAISE NOTICE 'added tables_name_is_not_a_javascript_accident';
  ELSE
    RAISE NOTICE 'tables_name_is_not_a_javascript_accident already present';
  END IF;
END
$add$;

DO $verify$
DECLARE
  v_n        int;
  v_stakes   text;
  v_name     text;
  v_survive  bigint;
  v_cash     bigint;
BEGIN
  ---------------------------------------------------------------------------
  -- BOTH GUARDS EXIST, AND BOTH ARE STILL NOT VALID.
  --
  -- convalidated is asserted false on purpose. If a later change validates
  -- either of these, it will have rewritten the table and taken an ACCESS
  -- EXCLUSIVE lock on it, and it will have done so against 23,629 rows that
  -- cannot pass. That must be a deliberate act, not a silent one.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'public.tables'::regclass
     AND contype = 'c'
     AND conname IN ('tables_stakes_is_not_a_javascript_accident',
                     'tables_name_is_not_a_javascript_accident');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'failed: expected 2 guard constraints on public.tables, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'public.tables'::regclass
     AND conname IN ('tables_stakes_is_not_a_javascript_accident',
                     'tables_name_is_not_a_javascript_accident')
     AND NOT convalidated;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'failed: a guard has been validated, which rewrites the table and cannot pass against the historical rows';
  END IF;

  ---------------------------------------------------------------------------
  -- THE EXPRESSIONS SAY WHAT THE HEADER SAYS THEY SAY.
  ---------------------------------------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO v_stakes FROM pg_constraint
   WHERE conrelid = 'public.tables'::regclass
     AND conname = 'tables_stakes_is_not_a_javascript_accident';
  SELECT pg_get_constraintdef(oid) INTO v_name FROM pg_constraint
   WHERE conrelid = 'public.tables'::regclass
     AND conname = 'tables_name_is_not_a_javascript_accident';

  IF position('undefined' in v_stakes) = 0 OR position('undefined' in v_name) = 0 THEN
    RAISE EXCEPTION 'failed: a guard does not mention the word it exists to reject';
  END IF;
  IF position('null/null' in v_stakes) = 0 THEN
    RAISE EXCEPTION 'failed: the stakes guard lost its null/null case: %', v_stakes;
  END IF;
  -- NULL must still be allowed. A table with no stakes yet is a real state,
  -- and a guard that rejected it would refuse legitimate inserts.
  IF position('IS NULL' in v_stakes) = 0 OR position('IS NULL' in v_name) = 0 THEN
    RAISE EXCEPTION 'failed: a guard no longer admits NULL, so it rejects absence as well as nonsense';
  END IF;

  ---------------------------------------------------------------------------
  -- THE PREDICATE ACTUALLY DOES THE JOB, EVALUATED READ ONLY ON LITERALS.
  --
  -- No row is written. Writing a probe row into public.tables would fire the
  -- seat, count and club sync triggers on a live platform, and this file is a
  -- record of a change that is already applied. The operators are exercised
  -- against the exact strings that shipped and the exact string that should
  -- have shipped.
  ---------------------------------------------------------------------------
  IF 'undefined/undefined' !~ 'undefined' THEN
    RAISE EXCEPTION 'failed: the guard expression would admit the exact label that shipped 28,649 times';
  END IF;
  IF 'Table [object Object]' !~ '\[object' THEN
    RAISE EXCEPTION 'failed: the guard expression would admit a stringified object';
  END IF;
  IF NOT ('1/2' !~ 'undefined') THEN
    RAISE EXCEPTION 'failed: the guard expression would reject 1/2, which is the CORRECT label for every affected row';
  END IF;
  IF NOT ('$0.05/$0.10' !~ 'undefined') THEN
    RAISE EXCEPTION 'failed: the guard expression would reject a cash stakes label';
  END IF;

  ---------------------------------------------------------------------------
  -- THE HISTORY IS UNTOUCHED, AND SAFE TO LEAVE UNTOUCHED.
  --
  -- Reported rather than asserted: the count falls over time as the stakes
  -- trigger corrects rows on write, so pinning a number here would make this
  -- file fail later for being right. What IS asserted is the property the
  -- decision rests on, that none of the survivors is a cash table. A cash
  -- table has no trigger owning its stakes, so a bad value on one could never
  -- be corrected on the way past and would instead make the row unupdatable.
  ---------------------------------------------------------------------------
  SELECT count(*), count(*) FILTER (WHERE tournament_id IS NULL)
    INTO v_survive, v_cash
    FROM public.tables WHERE stakes ~ 'undefined';

  IF v_cash <> 0 THEN
    RAISE EXCEPTION 'failed: % cash table(s) hold an undefined label; nothing owns their stakes, so this guard makes those rows unupdatable', v_cash;
  END IF;

  RAISE NOTICE '% historical row(s) still hold an undefined label, all tournament tables, all correctable to 1/2 on their next write', v_survive;
  RAISE NOTICE 'a stored label may not contain the word undefined';
END
$verify$;

COMMIT;
