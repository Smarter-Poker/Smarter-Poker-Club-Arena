-- A HAND A CASH TABLE HAS DEALT PAST IS DISPOSED AT ITS RESUME DOOR (2026-09-29)
--
-- Why this file exists
-- --------------------
-- Two sessions fixed the same resume-door refusals on 2026-09-29 and both
-- merged: 20260929022629 (#5559) and 20260929023040 (#5561). 20260929022629
-- was installed first (03:16 UTC, door prosrc 1949cf2d), so 20260929023040's
-- exact pre-image guard (32cfcc98) can never pass and that file is retired in
-- this same change. 20260929022629 already admits a 'breaking' cash table and
-- a chair the hand never named; on 2026-09-29 03:18:11 UTC the successor
-- handoff committed 6c9ee4b6's six-day-old hand 13637742 through it.
--
-- What 20260929022629 does not do, and this does: decide in the live path a
-- retained request that a cash table has already DEALT PAST.
--
-- fn_ca_resume_hand_submission reads each table's lowest unfinished retained
-- request at every table start. When the table has committed a LATER hand,
-- that later hand consumed the before-stacks this request names, so no one can
-- ever apply it, and the handoff refuses (HAND_SUBMISSION_HANDOFF_STATE_CHANGED)
-- at every start for ever. On 2026-09-28 that held 85 tables shut (141,579
-- such requests) and the only way out was an operator batch:
-- fn_ca_dispose_superseded_hand_submissions (20260928001934, on the unmerged
-- #5516), run by hand. A defect that is only ever cleared by a batch recurs
-- with paperwork (CLAUDE.md 10.11, 10.12).
--
-- What this changes
-- -----------------
-- One anchored edit to the live door, under exact pre-image (1949cf2d, full
-- definition eb795bb2) and post-image (4cc9df92) assertions: right after the
-- door has proved the caller's cash lease and locked the lane, the table, its
-- seats and the lowest unfinished hand, IF that hand lies below a hand this
-- cash table committed, it calls the new
-- smarter_private.hand_submission_dispose_dealt_past, which writes the
-- receipted, zero-credit disposal of every request the table has dealt past,
-- and the door then reads the next unfinished request (and takes that hand's
-- own settlement lock). If none is left the answer is found=false, exactly as
-- for a table with nothing retained.
--
-- The helper's proofs are exactly those of
-- fn_ca_dispose_superseded_hand_submissions, under which 150,022 such requests
-- were disposed on 2026-09-28: a later committed hand on the same table (the
-- witness); no commit and no hand_history for the hand; no successor claim and
-- no open dispatch; no reserved or accepted F06 permit; a dealer generation
-- that holds no lease; retained more than thirty minutes ago. It refuses under
-- the freeze, yields (returns 0) while another disposal holds the table, and
-- decides nothing on a tournament table: a second f06_prefix after the
-- tournament row lock would invert that lock order, and a tournament's dead
-- hands belong to the F06 abort doors.
--
-- It writes one table, smarter_private.hand_submission_disposals (append-only,
-- immutable by trigger). It moves no chip, credits nothing, debits nothing and
-- touches no hand that committed. Everything else in the door is byte-identical.
--
-- Proved first (CLAUDE.md 11.5): the helper body and the door edit were run on
-- production on 2026-09-29 ~02:40 UTC as pg_temp functions in psql
-- transactions that ended in ROLLBACK (the door completed 6c9ee4b6's handoff
-- with the edit present, writing no disposal because nothing lay below a later
-- commit); the anchor, pre-image and post-image digests here were computed from
-- the live prosrc at 03:19 UTC.
--
-- Pinned by tests/a-hand-a-cash-table-dealt-past-is-disposed-at-its-resume-door.law.test.ts.
-- docs/changelog/2026-09-29-a-retained-hand-is-handed-off-wherever-its-table-still-deals.md
--
-- @live-proof: (SELECT md5(prosrc)='4cc9df92758a39ed78ce6ade1e26849c' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $retained_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_resume_hand_submission(uuid,text,uuid)')
       AND md5(p.prosrc) = '1949cf2d020c48dd1a64c2bfdee433d8'
       AND md5(pg_get_functiondef(p.oid)) = 'eb795bb2248234e90c8b1a5e646354b5'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_PREIMAGE_DRIFT: public.fn_ca_resume_hand_submission(uuid,text,uuid)';
  END IF;
  IF to_regprocedure('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_PREIMAGE_DRIFT: hand_submission_dispose_dealt_past already exists';
  END IF;
  -- The receipt table this door writes (20260928001934, applied in production).
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = to_regclass('smarter_private.hand_submission_disposals')
         AND attnum > 0 AND NOT attisdropped
         AND attname IN ('table_id','hand_number','submission_id','receipt_id',
                         'witness_hand_number','reason','expected','created_at')) <> 8 THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_PREIMAGE_DRIFT: smarter_private.hand_submission_disposals';
  END IF;
END
$retained_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.hand_submission_dispose_dealt_past(p_table_id uuid, p_before bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_witness bigint;
  v_witness_at timestamptz;
  v_receipt uuid := gen_random_uuid();
  v_disposed integer := 0;
BEGIN
  -- Called only from fn_ca_resume_hand_submission, after it proved the
  -- caller's cash lease and locked the table, its seats and the lowest
  -- unfinished hand. It decides nothing on a tournament table, under the
  -- freeze, or while another disposal holds this table.
  IF p_table_id IS NULL OR p_before IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.tables WHERE id = p_table_id AND tournament_id IS NULL)
     OR public.fn_platform_frozen()
     OR NOT pg_try_advisory_xact_lock(hashtextextended('hand:disposal:' || p_table_id::text, 0)) THEN
    RETURN 0;
  END IF;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);

  -- THE WITNESS: the newest hand this table committed. It consumed the very
  -- stacks every earlier unfinished request names.
  SELECT a.hand_number, a.committed_at INTO v_witness, v_witness_at
    FROM public.hand_atomic_commits a
   WHERE a.table_id = p_table_id
   ORDER BY a.hand_number DESC LIMIT 1;
  IF v_witness IS NULL OR v_witness <= p_before THEN
    RETURN 0;
  END IF;

  -- Exactly the proofs of fn_ca_dispose_superseded_hand_submissions
  -- (20260928001934, 150,022 rows disposed through them on 2026-09-28): no
  -- commit and no history for the hand, no successor claim or open dispatch,
  -- no reserved or accepted F06 permit, its dealer generation holds no lease,
  -- and it was retained more than thirty minutes ago. Anything else is left
  -- for the handoff to refuse, by name.
  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id, v_receipt, v_witness,
         'resume door: this cash table committed a later hand, which consumed the stacks this retained request names; nothing of this hand is durable and nobody can ever apply it',
         jsonb_build_object(
           'kind', 'superseded_retained_submission',
           'door', 'fn_ca_resume_hand_submission',
           'table_id', s.table_id, 'tournament_id', NULL,
           'hand_number', s.hand_number, 'submission_id', s.submission_id,
           'retained_at', s.retained_at, 'dealer_generation', s.lease_generation,
           'request_hash', s.request_hash,
           'witness_hand_number', v_witness, 'witness_committed_at', v_witness_at,
           'disposed_at', clock_timestamp())
    FROM smarter_private.hand_submissions s
   WHERE s.table_id = p_table_id
     AND s.hand_number < v_witness
     AND s.retained_at < clock_timestamp() - interval '30 minutes'
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                      WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                      WHERE hh.table_id = s.table_id AND hh.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_handoffs h
                      WHERE h.submission_id = s.submission_id)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispatch d
                      WHERE d.submission_id = s.submission_id)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                      WHERE p.table_id = s.table_id AND p.hand_number = s.hand_number
                        AND p.state IN ('reserved', 'accepted'))
     AND NOT EXISTS (SELECT 1 FROM public.engine_table_leases l
                      WHERE l.table_id = s.table_id AND l.lease_generation = s.lease_generation)
   ORDER BY s.hand_number
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_disposed = ROW_COUNT;
  RETURN v_disposed;
END
$function$;

REVOKE ALL ON FUNCTION smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION smarter_private.hand_submission_dispose_dealt_past(uuid,bigint) IS
  'Called only by fn_ca_resume_hand_submission under its proven cash lease: receipted, zero-credit disposal of retained requests the table has provably dealt past, with the proofs of fn_ca_dispose_superseded_hand_submissions. 2026-09-29.';

-- The edit, found exactly once in the live definition, executed
-- as the live definition itself (same signature, owner, ACL, SECURITY
-- DEFINER, volatility and search_path).
DO $retained_patch$
DECLARE v_def text; v_old text; v_new text; n int;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
  -- disposal
  v_old := $a$ IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
$a$;
  v_new := $b$ IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- A HAND THIS CASH TABLE HAS ALREADY DEALT PAST IS DISPOSED AT ITS DOOR
 -- (2026-09-29). A later committed hand consumed the before-stacks this
 -- request names, so nobody can ever apply it; the receipted, zero-credit
 -- disposal is written here, under this caller's proven lease and the
 -- table's locks, and the next unfinished request is read. A tournament
 -- table's dead hands stay with the F06 abort doors.
 IF tour IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0 THEN
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 END IF;
$b$;
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_ANCHOR_DISPOSAL_FOUND_%_TIMES', n;
  END IF;
  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$retained_patch$;

DO $retained_postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '4cc9df92758a39ed78ce6ade1e26849c'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public']
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_POSTIMAGE_DRIFT: public.fn_ca_resume_hand_submission(uuid,text,uuid)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure
       AND md5(p.prosrc) = '8c9a78ddf5d498849966a8eb0efb647c'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog']
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_POSTIMAGE_DRIFT: smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)';
  END IF;
END
$retained_postimage$;

COMMIT;
