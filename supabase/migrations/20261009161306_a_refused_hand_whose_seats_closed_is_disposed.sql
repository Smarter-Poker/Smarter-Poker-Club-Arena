-- a_refused_hand_whose_seats_have_all_closed_is_disposed_at_its_resume_door
--
-- A REFUSED HAND WHOSE SEATS HAVE ALL CLOSED IS DISPOSED AT ITS RESUME DOOR
-- (2026-10-09). Full account:
-- docs/changelog/2026-10-09-a-refused-hand-whose-seats-have-closed-frees-its-table.md.
--
-- Three Diamond cash tables (22a9bc88, 6b47e87b, 6e1b1d4e) had dealt nothing
-- since 2026-10-07. Each retained exactly one hand the settlement contract
-- refused (diamond_hand_stale_seat): the whole commit rolled back, nothing of
-- the hand is durable, and a canonical failure row records it. Every chair the
-- request names has since closed (13 chairs, all horses), so the request can
-- never apply. The resume door disposes a retained hand only when a LATER hand
-- committed past it (20260929031904); a refused hand on a table that never
-- dealt again is never "dealt past", so fn_ca_resume_hand_submission found it
-- on every start and the engine held the table, recheck after recheck, while
-- the horse fleet kept seating new horses there (21,745 Diamonds of their
-- buy-ins sat at three tables that could not deal).
--
-- smarter_private.hand_submission_dispose_refused_vacated is the sibling of
-- hand_submission_dispose_dealt_past for that case. Its proofs are the dealt-
-- past proofs (no commit, no history, no disposal, no successor claim, no open
-- dispatch, no reserved or accepted F06 permit, the dealer generation holds no
-- lease, retained more than thirty minutes ago) plus: a canonical failure row
-- for this exact request, and EVERY chair the request names has closed. The
-- disposal is zero credit: it records that the hand never happened, which is
-- already the state of every stack. The resume door calls it beside the dealt-
-- past disposal and then reads the next unfinished request as before.
-- Tournament tables are untouched (their dead hands stay with the F06 doors).
--
-- @live-proof: (SELECT to_regprocedure('smarter_private.hand_submission_dispose_refused_vacated(uuid,uuid)') IS NOT NULL AND position('hand_submission_dispose_refused_vacated' IN pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION smarter_private.hand_submission_dispose_refused_vacated(p_table_id uuid, p_submission_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_receipt uuid := gen_random_uuid();
  v_disposed integer := 0;
BEGIN
  -- Called only from fn_ca_resume_hand_submission, after it proved the
  -- caller's cash lease and locked the table, its seats and the lowest
  -- unfinished hand. It decides nothing on a tournament table, under the
  -- freeze, or while another disposal holds this table.
  IF p_table_id IS NULL OR p_submission_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.tables WHERE id = p_table_id AND tournament_id IS NULL)
     OR public.fn_platform_frozen()
     OR NOT pg_try_advisory_xact_lock(hashtextextended('hand:disposal:' || p_table_id::text, 0)) THEN
    RETURN 0;
  END IF;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id, v_receipt, s.hand_number,
         'resume door: the settlement contract refused this cash hand and rolled it back, and every chair it names has since closed, so nothing of it is durable and nobody can ever apply it',
         jsonb_build_object(
           'kind', 'refused_retained_submission_seats_closed',
           'door', 'fn_ca_resume_hand_submission',
           'table_id', s.table_id, 'tournament_id', NULL,
           'hand_number', s.hand_number, 'submission_id', s.submission_id,
           'retained_at', s.retained_at, 'dealer_generation', s.lease_generation,
           'request_hash', s.request_hash,
           'refusal', (SELECT f.result FROM smarter_private.hand_submission_failures f
                        WHERE f.submission_id = s.submission_id AND f.request_hash = s.request_hash
                        LIMIT 1),
           'chairs', jsonb_array_length(s.request->'p_stacks'),
           'disposed_at', clock_timestamp(), 'credit', 0)
    FROM smarter_private.hand_submissions s
   WHERE s.table_id = p_table_id
     AND s.submission_id = p_submission_id
     AND s.retained_at < clock_timestamp() - interval '30 minutes'
     AND EXISTS (SELECT 1 FROM smarter_private.hand_submission_failures f
                  WHERE f.submission_id = s.submission_id AND f.request_hash = s.request_hash)
     AND jsonb_typeof(s.request->'p_stacks') = 'array'
     AND jsonb_array_length(s.request->'p_stacks') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks') x
                      JOIN public.table_seats seat ON seat.id = (x->>'seat_id')::uuid
                     WHERE seat.left_at IS NULL)
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
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_disposed = ROW_COUNT;
  RETURN v_disposed;
END
$function$;

REVOKE ALL ON FUNCTION smarter_private.hand_submission_dispose_refused_vacated(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'REFUSED_VACATED_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
BEGIN
  IF position('hand_submission_dispose_refused_vacated' IN v_src) > 0 THEN
    RAISE NOTICE 'REFUSED_VACATED already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '992019226ea1c06a3514a9087ac70be5' THEN
    RAISE EXCEPTION 'REFUSED_VACATED_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$ IF tour IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0 THEN
$a$,
$a$ -- A REFUSED HAND WHOSE CHAIRS HAVE ALL CLOSED IS DISPOSED HERE TOO
 -- (2026-10-09): rolled back, never durable, and no chair left to apply it to.
 IF tour IS NULL AND ((EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0)
  OR smarter_private.hand_submission_dispose_refused_vacated(p_table_id,s.submission_id)>0) THEN
$a$, 'resume dispose');
  EXECUTE v_src;
END
$patch$;

DO $prove$
DECLARE v_ready integer;
BEGIN
  IF to_regprocedure('smarter_private.hand_submission_dispose_refused_vacated(uuid,uuid)') IS NULL
     OR position('hand_submission_dispose_refused_vacated' IN pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'REFUSED_VACATED_RESULT_CHANGED: not live';
  END IF;
  IF has_function_privilege('anon', 'smarter_private.hand_submission_dispose_refused_vacated(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'smarter_private.hand_submission_dispose_refused_vacated(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REFUSED_VACATED_AUTHORITY_CHANGED';
  END IF;
END
$prove$;

COMMIT;
