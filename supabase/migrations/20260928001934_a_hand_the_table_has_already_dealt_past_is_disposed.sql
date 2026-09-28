-- A HAND THE TABLE HAS ALREADY DEALT PAST IS DISPOSED, NOT RETAINED FOR EVER (2026-09-28)
--
-- What was wrong
-- --------------
-- fn_ca_retain_hand_submission writes down the exact settlement request before
-- it dispatches, so a dealer that dies mid-settlement can be continued by its
-- successor (fn_ca_resume_hand_submission). That continuation is the only way a
-- retained submission is ever closed: there is no path that says "this hand
-- never happened and never will".
--
-- Measured 2026-09-28 00:11 UTC: 306,543 retained submissions carry no
-- hand_atomic_commits row and no hand_history row - the hands never happened
-- durably. 141,579 of them sit on 85 LIVE tables (81 cash, 4 tournament) that
-- have since dealt PAST them: table 0065ba44 holds 1,972 of them between
-- 2026-09-18 22:02 and 2026-09-20 00:11 and has committed 12,068 hands, the
-- newest long after the orphans.
--
-- fn_ca_resume_hand_submission picks the LOWEST uncommitted submission on the
-- table at every table start. For these tables that is an eight-day-old hand
-- whose seats and stacks are long gone, so the handoff refuses
-- (HAND_SUBMISSION_HANDOFF_STATE_CHANGED), the table refuses to start, the
-- watchdog rebuilds it, and it refuses again: 1,474 refusals per two minutes
-- tonight, the single loudest error in the fleet, and 85 tables that can never
-- deal again while the row exists. The table is not broken; the corpse in front
-- of it is.
--
-- Why a disposal, not a handoff
-- -----------------------------
-- The hand was played in a dead process's memory and nothing of it is durable:
-- no commit, no history, no chips moved. The durable stacks ARE the pre-hand
-- stacks. Disposing the request changes no one's chips - it records that the
-- hand never happened, which is what every durable row already says. The proof
-- is that the table itself dealt a LATER hand and committed it: that commit
-- consumed the very stacks this request names, so the request can never be
-- applied by anybody, ever.
--
-- What this adds
-- --------------
--   * smarter_private.hand_submission_disposals - one append-only receipt row
--     per disposed hand, naming the witness commit that superseded it. The
--     existing dispositions row stays exactly as it is ('retained' is the
--     truth: it WAS retained), because that table is immutable by trigger and
--     rewriting history is not how this platform records a ruling.
--   * public.fn_ca_dispose_superseded_hand_submissions(table, receipt, reason,
--     limit) - service-role only, replay-safe on the receipt, refuses under the
--     platform freeze, and disposes only submissions it can prove are dead:
--       - a later hand on the same table committed (the witness);
--       - this hand has no commit row and no hand_history row;
--       - no successor claimed it (hand_submission_handoffs) and no handoff
--         dispatch is open;
--       - no F06 hand permit is still reserved or accepted for it;
--       - its dealer generation owns nothing: no table or tournament lease
--         carries it, so the original can never settle;
--       - it was retained more than 30 minutes ago (every settlement path runs
--         under a statement timeout of at most 120 s).
--     Anything it cannot prove is left alone and reported, never guessed.
--   * fn_ca_resume_hand_submission skips a disposed hand when it looks for the
--     table's unfinished submission. Everything else in it is byte-identical:
--     the same freeze boundary, lease proof, superseded-original proof, exact
--     before-stacks, one-time financial claim and postcommit.
--   * hand_submission_snapshot_guard accepts a disposal receipt as an accepted
--     disposition, so the hand's saved state can be closed afterwards.
--
-- It moves no chips, credits nothing, debits nothing, and touches no hand that
-- committed.

CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_disposals (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  submission_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  witness_hand_number bigint NOT NULL,
  reason text NOT NULL,
  expected jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, hand_number),
  UNIQUE (submission_id),
  CONSTRAINT hand_submission_disposals_witness_is_later CHECK (witness_hand_number > hand_number),
  CONSTRAINT hand_submission_disposals_reason_is_stated CHECK (length(btrim(reason)) >= 40)
);

CREATE INDEX IF NOT EXISTS hand_submission_disposals_receipt_idx
  ON smarter_private.hand_submission_disposals (receipt_id);

ALTER TABLE smarter_private.hand_submission_disposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.hand_submission_disposals FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS hand_submission_disposal_immutable ON smarter_private.hand_submission_disposals;
CREATE TRIGGER hand_submission_disposal_immutable
  BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_disposals
  FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();

DROP TRIGGER IF EXISTS hand_submission_disposal_no_truncate ON smarter_private.hand_submission_disposals;
CREATE TRIGGER hand_submission_disposal_no_truncate
  BEFORE TRUNCATE ON smarter_private.hand_submission_disposals
  FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();

COMMENT ON TABLE smarter_private.hand_submission_disposals IS
  'Append-only receipt: a retained settlement request the table has provably dealt past, disposed at zero credit because nothing of its hand is durable. 2026-09-28.';

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
  IF v_witness IS NULL THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_NO_WITNESS' USING ERRCODE = '55000';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _hand_disposal_batch (
    submission_id uuid, hand_number bigint, retained_at timestamptz,
    lease_generation uuid, request_hash text, blocked text) ON COMMIT DROP;
  -- unqualified-write-ok: _hand_disposal_batch because it is a transaction-local
  -- ON COMMIT DROP temp table private to this call, reachable by nothing else;
  -- migration 20260928133817 writes the predicate out in the live definition.
  DELETE FROM _hand_disposal_batch;

  INSERT INTO _hand_disposal_batch (submission_id, hand_number, retained_at, lease_generation, request_hash, blocked)
  SELECT s.submission_id, s.hand_number, s.retained_at, s.lease_generation, s.request_hash,
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
                           AND p.state IN ('reserved', 'accepted'))
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
     AND s.hand_number < v_witness
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object('reason', b.blocked, 'hands', b.n)), '[]'::jsonb) INTO v_blocked
    FROM (SELECT blocked, count(*) n FROM _hand_disposal_batch WHERE blocked IS NOT NULL GROUP BY 1) b;

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT p_table_id, b.hand_number, b.submission_id, p_receipt_id, v_witness, p_reason,
         jsonb_build_object(
           'kind', 'superseded_retained_submission',
           'table_id', p_table_id, 'tournament_id', v_tour,
           'hand_number', b.hand_number, 'submission_id', b.submission_id,
           'retained_at', b.retained_at, 'dealer_generation', b.lease_generation,
           'request_hash', b.request_hash,
           'witness_hand_number', v_witness, 'witness_committed_at', v_witness_at,
           'disposed_at', clock_timestamp(), 'actor', v_actor)
    FROM _hand_disposal_batch b
   WHERE b.blocked IS NULL;
  GET DIAGNOSTICS v_disposed = ROW_COUNT;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: hand submission disposal refused' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'table_id', p_table_id,
    'tournament_id', v_tour, 'witness_hand_number', v_witness, 'witness_committed_at', v_witness_at,
    'candidates', v_candidates, 'disposed', v_disposed, 'first_hand', v_min, 'last_hand', v_max,
    'blocked', v_blocked, 'credit', 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_dispose_superseded_hand_submissions(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_dispose_superseded_hand_submissions(uuid, uuid, text, integer)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_dispose_superseded_hand_submissions(uuid, uuid, text, integer) IS
  'Zero-credit, receipted disposal of retained settlement requests whose table has provably committed a later hand, proved from rows; leaves anything it cannot prove alone and reports it. 2026-09-28.';

-- The snapshot of a disposed hand may be closed: the disposal receipt is an
-- accepted disposition, exactly as an F06 abort receipt is.
CREATE OR REPLACE FUNCTION smarter_private.hand_submission_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NOT NEW.is_complete THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=NEW.table_id
   AND a.hand_number=NEW.hand_number AND a.hand_id IS NOT NULL AND a.post_commit_payload IS NOT NULL) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
   WHERE dd.table_id=NEW.table_id AND dd.hand_number=NEW.hand_number) THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;

-- fn_ca_resume_hand_submission skips a disposed hand. The edit is applied to the
-- live definition under an exact-anchor assertion and a post-condition check
-- rather than retyped: this is a money function whose body is 200 lines, three
-- agents have landed changes in it today, and a transcription slip here would
-- settle a hand twice. Everything else in it stays byte-identical.
DO $patch$
DECLARE v_def text; v_new text; v_old text; v_repl text; n int;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
  IF position('hand_submission_disposals' in v_def) > 0 THEN
    RETURN;
  END IF;
  v_old := E' WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL\n';
  v_repl := E' WHERE j.table_id=p_table_id\n AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd\n   WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)\n AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL\n';
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_RESUME_ANCHOR_FOUND_%_TIMES', n USING ERRCODE = '55000';
  END IF;
  v_new := replace(v_def, v_old, v_repl);
  EXECUTE v_new;
  IF position('hand_submission_disposals' in
      pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_RESUME_PATCH_UNPROVEN' USING ERRCODE = '55000';
  END IF;
END
$patch$;
