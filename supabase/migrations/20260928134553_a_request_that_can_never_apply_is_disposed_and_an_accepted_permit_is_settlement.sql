-- A REQUEST THAT CAN NEVER APPLY IS DISPOSED, AND AN ACCEPTED PERMIT IS SETTLEMENT (2026-09-28)
--
-- Two last shapes of the 2026-09-18/19 freeze, measured on live rows tonight
-- after 150,022 superseded requests were disposed:
--
-- 1. A REQUEST THAT CAN NEVER APPLY. Cash table 71d90586 holds a retained hand
--    whose ninth player is no longer in the seat the request names. The
--    settlement writes the exact before-stacks it names, so no successor can
--    ever apply it; the table has not dealt since 2026-09-22 20:11. Nothing of
--    the hand is durable (no commit, no history, no chips moved), so it is
--    disposed at zero credit like any other dead request - the durable stacks
--    already ARE the pre-hand stacks. The door previously required a LATER
--    committed hand as its witness, which this table does not have, because it
--    stopped dealing at that very hand.
--
-- 2. AN ACCEPTED PERMIT IS EVIDENCE THE HAND SETTLED. fn_f06_finish_hand moves
--    an F06 hand permit to 'accepted' only against a committed, post-committed
--    hand. The door refused those out of caution, but they are exactly the
--    retention-pruned case: the hand settled, and sp_prune_hand_history later
--    removed its commit and history under the 8-day horse policy. 17 such hands
--    across three tables of 4e2de62d ("Friday Fight Night Opener", 32 players)
--    had held those tables shut since 2026-09-19. Only a 'reserved' permit - a
--    hand still genuinely unresolved - still blocks; that belongs to the F06
--    abort doors, not to this one.
--
-- Every other proof is unchanged, and the door still leaves alone, and reports,
-- anything it cannot prove: a hand with history, a spent successor claim, an
-- open dispatch, a dealer generation that still holds the lease, a request
-- retained less than thirty minutes ago, and a request whose named chairs are
-- all still exactly as it left them (that one belongs to the handoff, which
-- since tonight also tolerates a chair seated after the hand began).

CREATE OR REPLACE FUNCTION public.fn_ca_dispose_superseded_hand_submissions(
  p_table_id uuid,
  p_receipt_id uuid,
  p_reason text,
  p_limit integer DEFAULT 2000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  v_actor text := current_setting('app.smarter_data_actor', true);
  v_tour uuid;
  v_witness bigint;
  v_witness_at timestamptz;
  v_prior integer;
  v_blocked jsonb := '[]'::jsonb;
  v_bases jsonb := '[]'::jsonb;
  v_disposed integer := 0;
  v_candidates integer := 0;
  v_min bigint;
  v_max bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS NULL OR v_actor NOT IN ('service', 'tournament-manager', 'table-manager') THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_SERVICE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_table_id IS NULL OR p_receipt_id IS NULL OR length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: hand submission disposal refused' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_prior FROM smarter_private.hand_submission_disposals WHERE receipt_id = p_receipt_id;
  IF v_prior > 0 THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'receipt_id', p_receipt_id,
      'table_id', p_table_id, 'disposed', v_prior, 'credit', 0);
  END IF;

  -- The same lane every settlement of this table takes, and never queued: a
  -- disposal that has to wait for a live hand is a disposal that should not run.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hand:disposal:' || p_table_id::text, 0)) THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_TABLE_BUSY' USING ERRCODE = '40001';
  END IF;
  SELECT tournament_id INTO v_tour FROM public.tables WHERE id = p_table_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'HAND_DISPOSAL_TABLE_MISSING' USING ERRCODE = '55000'; END IF;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);

  -- THE WITNESS: the newest hand this table committed. Everything below it that
  -- never committed was dealt past, and its before-stacks were consumed.
  SELECT a.hand_number, a.committed_at INTO v_witness, v_witness_at
    FROM public.hand_atomic_commits a
   WHERE a.table_id = p_table_id
   ORDER BY a.hand_number DESC LIMIT 1;

  CREATE TEMP TABLE IF NOT EXISTS _hand_disposal_batch (
    submission_id uuid, hand_number bigint, retained_at timestamptz,
    lease_generation uuid, request_hash text, basis text, blocked text) ON COMMIT DROP;
  -- Scoped on purpose: the batch table is transaction-local (ON COMMIT DROP)
  -- and reused across the calls one batch makes, and a write states its scope.
  DELETE FROM _hand_disposal_batch WHERE true;

  INSERT INTO _hand_disposal_batch (submission_id, hand_number, retained_at, lease_generation, request_hash, basis, blocked)
  SELECT s.submission_id, s.hand_number, s.retained_at, s.lease_generation, s.request_hash,
         CASE
           WHEN v_witness IS NOT NULL AND s.hand_number < v_witness THEN 'superseded_by_later_commit'
           WHEN EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                         WHERE p.table_id = s.table_id AND p.hand_number = s.hand_number
                           AND p.state = 'accepted' AND p.evidence_id IS NOT NULL)
             THEN 'settled_under_accepted_permit'
           WHEN EXISTS (
                 SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks') x
                  WHERE NOT EXISTS (
                    SELECT 1 FROM public.table_seats seat
                     WHERE seat.table_id = s.table_id AND seat.id = (x->>'seat_id')::uuid
                       AND seat.user_id = (x->>'user_id')::uuid
                       AND seat.joined_at = (x->>'seat_joined_at')::timestamptz
                       AND seat.left_at IS NULL
                       AND seat.stack = (x->>'stack_before')::numeric))
             THEN 'request_can_never_apply'
           ELSE NULL
         END,
         CASE
           WHEN EXISTS (SELECT 1 FROM public.hand_history hh
                         WHERE hh.table_id = s.table_id AND hh.hand_number = s.hand_number)
             THEN 'hand_history_exists'
           WHEN EXISTS (SELECT 1 FROM smarter_private.hand_submission_handoffs h
                         WHERE h.submission_id = s.submission_id)
             THEN 'successor_claim_spent'
           WHEN EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispatch d
                         WHERE d.submission_id = s.submission_id)
             THEN 'handoff_dispatch_open'
           WHEN EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                         WHERE p.table_id = s.table_id AND p.hand_number = s.hand_number
                           AND p.state = 'reserved')
             THEN 'f06_permit_unresolved'
           WHEN (CASE WHEN v_tour IS NULL
                      THEN EXISTS (SELECT 1 FROM public.engine_table_leases l
                                    WHERE l.table_id = s.table_id AND l.lease_generation = s.lease_generation)
                      ELSE EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                                    WHERE l.tournament_id = v_tour AND l.lease_generation = s.lease_generation)
                 END)
             THEN 'dealer_generation_still_leased'
           WHEN s.retained_at >= clock_timestamp() - interval '30 minutes'
             THEN 'retained_too_recently'
           ELSE NULL
         END
    FROM smarter_private.hand_submissions s
   WHERE s.table_id = p_table_id
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                      WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
   ORDER BY s.hand_number
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 20000));

  SELECT count(*), min(hand_number), max(hand_number) INTO v_candidates, v_min, v_max
    FROM _hand_disposal_batch;
  IF v_candidates = 0 THEN
    RETURN jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'table_id', p_table_id,
      'witness_hand_number', v_witness, 'candidates', 0, 'disposed', 0, 'blocked', '[]'::jsonb, 'credit', 0);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('reason', COALESCE(b.blocked, 'still_applicable_leave_to_handoff'), 'hands', b.n)), '[]'::jsonb)
    INTO v_blocked
    FROM (SELECT blocked, count(*) n FROM _hand_disposal_batch
           WHERE blocked IS NOT NULL OR basis IS NULL
           GROUP BY blocked) b;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('basis', b.basis, 'hands', b.n)), '[]'::jsonb) INTO v_bases
    FROM (SELECT basis, count(*) n FROM _hand_disposal_batch
           WHERE blocked IS NULL AND basis IS NOT NULL GROUP BY basis) b;

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT p_table_id, b.hand_number, b.submission_id, p_receipt_id,
         CASE WHEN b.basis = 'superseded_by_later_commit' THEN v_witness ELSE b.hand_number END,
         p_reason,
         jsonb_build_object(
           'kind', b.basis,
           'table_id', p_table_id, 'tournament_id', v_tour,
           'hand_number', b.hand_number, 'submission_id', b.submission_id,
           'retained_at', b.retained_at, 'dealer_generation', b.lease_generation,
           'request_hash', b.request_hash,
           'witness_hand_number', v_witness, 'witness_committed_at', v_witness_at,
           'disposed_at', clock_timestamp(), 'actor', v_actor)
    FROM _hand_disposal_batch b
   WHERE b.blocked IS NULL AND b.basis IS NOT NULL;
  GET DIAGNOSTICS v_disposed = ROW_COUNT;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: hand submission disposal refused' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'table_id', p_table_id,
    'tournament_id', v_tour, 'witness_hand_number', v_witness, 'witness_committed_at', v_witness_at,
    'candidates', v_candidates, 'disposed', v_disposed, 'bases', v_bases, 'first_hand', v_min, 'last_hand', v_max,
    'blocked', v_blocked, 'credit', 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_dispose_superseded_hand_submissions(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_dispose_superseded_hand_submissions(uuid, uuid, text, integer)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_dispose_superseded_hand_submissions(uuid, uuid, text, integer) IS
  'Zero-credit, receipted disposal of a retained settlement request that can never be applied - the table committed a later hand, the hand settled under an accepted F06 permit whose record aged out, or a chair the request names is no longer there holding exactly what it names - proved from rows; leaves anything it cannot prove alone and reports it. 2026-09-28.';