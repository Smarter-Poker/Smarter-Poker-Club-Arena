-- A RETAINED HAND IS HANDED OFF WHEREVER ITS TABLE STILL DEALS (2026-09-29)
--
-- What was wrong, measured on production 2026-09-29 02:10-02:25 UTC
-- ---------------------------------------------------------------------
-- Two cash tables were rebuilt by the engine every ~5.6 s, for hours, because
-- fn_ca_resume_hand_submission refused the one retained hand each of them
-- holds. In fifteen minutes of engine log: 113 x
-- `retained_hand_submission_readback_failed: HAND_SUBMISSION_TABLE_NOT_ADMITTED`
-- (table 499aa67a "NLH 1/2 Classic Feeder") and 110 x
-- `... HAND_SUBMISSION_HANDOFF_STATE_CHANGED` (table 6c9ee4b6 "NLH 1/2
-- Madness Feeder"), each one a `watchdog_kill: start_failed:start_load_table`
-- (223 in the window) and a spent slot of the discovery start budget. Nine
-- seated players' chips (684.60 + 1,568.30) could not be played.
--
-- Neither hand is superseded: neither table has committed anything after it.
-- Both are finished hands whose chairs still hold exactly the before-stacks
-- the retained request names. The door refused them for two reasons that are
-- not in the request at all:
--
-- 1. HAND_SUBMISSION_TABLE_NOT_ADMITTED - 499aa67a, hand 16812749, submission
--    8debf775 (113fc1bc +227.57, 4c417026 -230.82, bb698b9a -1.00, rake 3.75,
--    BBJ 0.50). The table went `lifecycle='breaking'` at 15:18:08 (the cash
--    cluster breaks a thin game at a hand boundary). The door admitted a cash
--    table only while `lifecycle='live'`:
--        AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))
--    But a breaking table still deals: the engine wakes any undeleted cash
--    table in waiting/running (isWakeableCashTable), and fn_ca_commit_hand_
--    settlement - the door its original settles through - reads no lifecycle
--    at all. So the original may settle a hand the successor may not, the
--    break waits for the hand, and the hand waits for 'live'. For ever.
--
-- 2. HAND_SUBMISSION_HANDOFF_STATE_CHANGED - 6c9ee4b6, hand 13637742,
--    submission a76d9941, dealt 2026-09-22 15:05:14 (113fc1bc +4 from
--    286514ac's blind and dead ante, a93a8432 folded; no rake). Frozen for
--    six days. Two chairs sat down 18 s and 43 s before that deal and were not
--    dealt in (4c417026 and 00000000-...-0008, neither in the hand). The door
--    refused any open chair missing from the request that joined before the
--    deal:
--        AND (late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
--    A chair's join time does not say whether it was dealt in; the hand does.
--    Its own `p_hand_row.players` roster names exactly the players dealt, and
--    on every one of the 400 most recent committed hands (93 cash, 307
--    tournament) that roster equals the request's stack rows exactly.
--
-- What this changes
-- -----------------
-- Three anchored edits to public.fn_ca_resume_hand_submission, applied to the
-- live definition under an exact pre-image assertion (the body is 13 KB and
-- three agents changed it in the last week; retyping it is how a settlement
-- door breaks). Everything else stays byte-identical: the freeze boundary,
-- the lease proof, the superseded-original proof, the exact before-stacks,
-- the later-hand fences, the one-time financial claim, the commit through
-- fn_ca_commit_hand_settlement with the retained request, and postcommit.
--
--   admission     A cash table is admitted in every lifecycle but 'closed',
--                 exactly where it deals and where its original settles. A
--                 tournament table is unchanged (lifecycle NULL).
--   dealt_roster  Who was dealt in is read from the hand: its players roster
--                 must name exactly its stack rows (a roster that disagrees
--                 with itself, or is missing, refuses). An open chair the
--                 hand does not name is admitted whenever it sat down; it
--                 still refuses when its player is a hand player (seated
--                 twice) or it sits in a seat number the hand dealt.
--   disposal      A hand this cash table has already dealt past is disposed
--                 AT THE DOOR, not by a later batch: when the lowest
--                 unfinished request lies below a committed hand, the door
--                 (holding the caller's proven lease, the lane, the table and
--                 its seats) writes the receipted, zero-credit disposal
--                 through smarter_private.hand_submission_dispose_dealt_past
--                 and reads the next unfinished request. The proofs are
--                 exactly those of fn_ca_dispose_superseded_hand_submissions
--                 (20260928001934), under which 150,022 such requests were
--                 disposed on 2026-09-28: no commit, no history, no successor
--                 claim, no open dispatch, no reserved or accepted F06
--                 permit, a dealer generation that holds no lease, retained
--                 over thirty minutes ago. A tournament table's dead hands
--                 stay with the F06 abort doors (a second f06_prefix after
--                 the tournament row lock would invert its lock order).
--
-- The existing rows settle through the platform's own door, the handoff,
-- the next time the engine starts each table. Nothing here writes a chip.
--
-- PROVED FIRST (CLAUDE.md 11.5), 2026-09-29 ~02:40 UTC, psql transactions
-- that ended in ROLLBACK, with the post-image body and the helper installed
-- as pg_temp functions and the lease row held by a probe identity:
--   * 6c9ee4b6: completed=true, financial_handoff=true, hand 13637742
--     committed and post-committed, 113fc1bc 220.00->224.00, 286514ac
--     209.13->205.13, a93a8432 292.67 unchanged, the two undealt chairs
--     unchanged, net 0.00, no disposal written.
--   * 499aa67a: the financial commit landed (113fc1bc 256.78->484.35,
--     4c417026 230.82->0.00, bb698b9a 197.00->196.00, rake 3.75, BBJ 0.50,
--     net -4.25); postcommit returned accepted_postcommit_pending on the
--     probe's own 3 s lock_timeout, which is the door's existing replayable
--     outcome, not a refusal.
--
-- NOT TOUCHED: fn_ca_commit_hand_settlement, fn_ca_dispose_superseded_hand_
-- submissions, the snapshot guard, every dispositions/handoffs/results row.
--
-- The engine half (server/src/services/supabase/handHistory.ts and the cash
-- start path) stops the restart loop on any refusal the engine cannot
-- resolve, and says so once.
--
-- Pinned by tests/a-retained-hand-is-handed-off-wherever-its-table-still-deals.law.test.ts.
-- docs/changelog/2026-09-29-a-retained-hand-is-handed-off-wherever-its-table-still-deals.md
--
-- @live-proof: (SELECT md5(prosrc)='e0046c683aa98538158ecde30fc52039' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $retained_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_resume_hand_submission(uuid,text,uuid)')
       AND md5(p.prosrc) = '32cfcc987acdab387067f80ec3704c9b'
       AND md5(pg_get_functiondef(p.oid)) = '5e58f60de943713e6234b095020d228c'
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

-- The three edits, each found exactly once in the live definition, executed
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
  -- admission
  v_old := $a$  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live'; a tournament table keeps NULL until it closes.
      AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))
$a$;
  v_new := $b$  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- A cash table deals, and its original settles, in every lifecycle but
      -- 'closed': a 'breaking' table plays on until its players are moved
      -- at a hand boundary (2026-09-29). A tournament table keeps NULL
      -- until it closes.
      AND (CASE WHEN tour IS NULL THEN lifecycle IS DISTINCT FROM 'closed'
        ELSE lifecycle IS NULL END))
$b$;
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_ANCHOR_ADMISSION_FOUND_%_TIMES', n;
  END IF;
  v_def := replace(v_def, v_old, v_new);
  -- dealt_roster
  v_old := $a$   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND (late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))
$a$;
  v_new := $b$   -- WHO WAS DEALT IN IS READ FROM THE HAND, NOT FROM A CLOCK (2026-09-29).
   -- The hand's own players roster must name exactly its stack rows. A chair
   -- the hand does not name was not dealt in, whenever it sat down (a
   -- player waiting for the big blind, or sitting out); it still refuses if
   -- its player is a hand player (seated twice) or it sits in a seat the
   -- hand dealt.
   OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'
   OR (SELECT array_agg(DISTINCT x->>'userId' ORDER BY x->>'userId') FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(q->'p_hand_row'->'players')='array' THEN q->'p_hand_row'->'players' ELSE '[]'::jsonb END) x)
     IS DISTINCT FROM (SELECT array_agg(DISTINCT x->>'user_id' ORDER BY x->>'user_id') FROM jsonb_array_elements(q->'p_stacks') x)
   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND (late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)
       OR late.seat_number::text IN (SELECT x->>'seat' FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(q->'p_hand_row'->'players')='array' THEN q->'p_hand_row'->'players' ELSE '[]'::jsonb END) x)))
$b$;
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'RETAINED_HANDOFF_ANCHOR_DEALT_ROSTER_FOUND_%_TIMES', n;
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
       AND md5(p.prosrc) = 'e0046c683aa98538158ecde30fc52039'
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
