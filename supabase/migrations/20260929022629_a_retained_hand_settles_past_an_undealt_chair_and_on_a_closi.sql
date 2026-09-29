-- 20260929022629_a_retained_hand_settles_past_an_undealt_chair_and_on_a_closing_table
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A RETAINED HAND SETTLES PAST AN UNDEALT CHAIR, AND ON A CLOSING TABLE
-- ===========================================================================
--
-- Authorized by Dan in chat on 2026-09-29 ("proceed").
--
-- What was wrong
-- --------------
-- Two cash tables, all horses, crash-loop about ten times a minute because
-- public.fn_ca_resume_hand_submission (the successor handoff) refuses their
-- retained, finished hand on every table start:
--
-- * 6c9ee4b6 (6 horses, 1,568.30 chips), hand 13637742, retained
--   2026-09-22 15:05. HAND_SUBMISSION_HANDOFF_STATE_CHANGED. Seats 3 and 5
--   (00000000-...-0008 and 4c417026) were taken 43 s and 18 s BEFORE the
--   deal (started_at 15:05:14.056) and were not dealt in: neither player
--   appears anywhere in the hand's own record (players, actions, winners,
--   hole cards). The 2026-09-26 clause (20260926091630) admits only chairs
--   taken AFTER the deal, so a sit-out chair holds the hand hostage for good.
--   The hand conserves: net deltas 0.00, rake 0, bbj 0, inflow 0. Every chair
--   it names still holds its player, joined_at and exact pre-hand stack.
--   (PR #5363 read these two seats as taken after the deal; they were not.)
--
-- * 499aa67a (3 horses, 684.60 chips), hand 16812749, retained 2026-09-28
--   18:26. HAND_SUBMISSION_TABLE_NOT_ADMITTED. The cash table's lifecycle is
--   'breaking' (being closed) and the handoff admits only 'live'. The table
--   cannot finish closing while it holds an unsettled hand, and the hand
--   cannot settle while the table is closing. The ORIGINAL commit path
--   (fn_ca_commit_hand_settlement) never checks a cash table's lifecycle.
--
-- The disposal door (fn_ca_dispose_superseded_hand_submissions, 20260928134553)
-- deliberately leaves a request "whose named chairs are all still exactly as it
-- left them" to this handoff. Both requests are that shape.
--
-- What this changes
-- -----------------
-- Two admission clauses of the handoff, and nothing else:
--
-- 1. A cash table whose lifecycle is 'breaking' is admitted, as the original
--    commit admits it. 'closed' still refuses; a tournament table still must
--    keep NULL lifecycle and a RUNNING event.
-- 2. A live chair missing from the submission that was present at the deal is
--    admitted only when (a) the hand's own record never names its player,
--    (b) the record's players is an array, and (c) every player the record
--    names is in the submission's stacks. A hand player seated twice still
--    refuses; an undated deal still refuses; every other state proof is
--    unchanged. The settlement core still refuses any stack set that does not
--    conserve (deltas = inflow - rake - bbj), so a dealt player left out of the
--    stacks can never settle through this door.
--
-- Built from the verified live body by exact replacement: the pre-image is
-- pinned by md5, each replaced clause must match exactly once, and the result
-- is pinned by md5, so this installs exactly the body that was proved.
--
-- Proved on 2026-09-29 ~02:25 UTC in a transaction that rolled back (DO block
-- ending in RAISE), with this exact body installed in pg_temp and called with
-- the live lease of each table:
-- * 499aa67a: completed true, financial_handoff true, hand 16812749 committed
--   once (1 hand_atomic_commits row, 1 hand_history row), stacks 684.60 ->
--   680.35 = net deltas -4.25 = rake 3.75 + bbj 0.50; a second call returned
--   found false.
-- * 6c9ee4b6 (read-only evaluation of the new clause against the live rows):
--   blocking chairs 2 under the old clause, 0 under the new; net deltas 0.00.
--
-- Nobody is paid twice: the handoff claim row is unique per submission and
-- hand_atomic_commits is keyed (table_id, hand_number).
--
-- Law: tests/a-retained-hand-settles-past-an-undealt-chair-and-on-a-closing-table.law.test.ts
-- Changelog: docs/changelog/2026-09-29-a-retained-hand-settles-past-an-undealt-chair-and-on-a-closing-table.md
--
-- @live-proof: (SELECT md5(prosrc) = 'e2c4c0da28aa24c244951906f0d9d9b6' FROM pg_proc WHERE oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migrate$
DECLARE
  d text;
  src text;
  n integer;
  i integer;
  pairs text[][] := ARRAY[
    ARRAY[$o$      -- Cash tables are 'live'; a tournament table keeps NULL until it closes.
      AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))$o$,
          $n$      -- Cash tables are 'live', or 'breaking' while the table is being closed
      -- (2026-09-29, 499aa67a): the original commit never refused a breaking
      -- cash table, so its successor must not either. A tournament table keeps
      -- NULL until it closes; 'closed' still refuses everywhere.
      AND (lifecycle='live' OR (tour IS NULL AND lifecycle='breaking') OR (tour IS NOT NULL AND lifecycle IS NULL)))$n$],
    ARRAY[$o$A chair that was present at
  -- the deal and is missing from the submission, or a hand player seated
  -- twice, still refuses; an undated deal refuses.$o$,
          $n$A chair that was present at
  -- the deal and is missing from the submission is admitted only when the
  -- hand's own record never names its player and every player the record
  -- names is in the submission (2026-09-29, 6c9ee4b6: two horses seated
  -- 43 s and 18 s before the deal, not dealt in, froze the table for six
  -- days). The settlement still refuses any non-conserving stack set, so a
  -- dealt player left out of the stacks can never settle. A hand player
  -- seated twice still refuses; an undated deal refuses.$n$],
    ARRAY[$o$     AND (late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))$o$,
          $n$     AND ((late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
         AND (strpos((q->'p_hand_row')::text,late.user_id::text)>0
           OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_hand_row'->'players') hp
             WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE x->>'user_id'=hp->>'userId'))))
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))$n$]
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '32cfcc987acdab387067f80ec3704c9b'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public"}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_resume_hand_submission is not the live definition read on 2026-09-29 (md5 32cfcc98)';
  END IF;

  d := pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    n := (length(d) - length(replace(d, pairs[i][1], ''))) / length(pairs[i][1]);
    IF n <> 1 THEN
      RAISE EXCEPTION 'CLAUSE %: expected exactly one match, found %', i, n;
    END IF;
    d := replace(d, pairs[i][1], pairs[i][2]);
  END LOOP;
  EXECUTE d;

  SELECT md5(prosrc) INTO src FROM pg_proc
   WHERE oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure;
  IF src IS DISTINCT FROM 'e2c4c0da28aa24c244951906f0d9d9b6' THEN
    RAISE EXCEPTION 'POSTIMAGE: installed body md5 % is not the proved e2c4c0da', src;
  END IF;
END
$migrate$;

REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;

COMMIT;
