-- 20261006140724_a_cancelled_fee_that_was_never_captured_is_cancelled_not_def.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT HAPPENED (rows read 2026-10-06 ~14:00 UTC):
--
-- The weekly close for 2026-09-28 07:00 -> 2026-10-05 07:00 UTC stopped for
-- both scopes that touch these events: Midway Union (fade0000-...-0001,
-- member clubs a0000000-...-0001 and SHARK CLUB a41434bb) and the standalone
-- Deep Stack Society (2a1132b9). Each club's accounting_period_recompute_requests
-- row is `blocked` / `tournament_recognition_deferred`, raised by
-- fn_accounting_tournament_week_quality for an event whose
-- accounting_tournament_fee_recognitions.status is 'banked_accrual_deferred'.
--
-- Exactly four recognitions in the whole table carry that status, all four
-- written at 2026-10-02 02:16:54.388496 by atomic_cancel_tournament:
--
--   097e3601-ccf9-4035-af40-eb35068d2652  (Midway Union, 2 x 7.50)
--   92c93927-614f-4168-a1f9-918849c0be19  (Midway Union, 2 x 0.75)
--   a4262ba0-cd5f-4a94-a0f8-915a028cf3a7  (Midway Union, 2 x 0.75)
--   20c75b67-7f78-4b29-b7df-9594faf62af0  (Deep Stack Society, 2 x 0.75)
--
-- Each is a CANCELLED satellite. Its two entry fees were charged by
-- fn_register_horse_for_tournament on 2026-09-08, BEFORE fee-source capture
-- existed, so neither has an accounting_tournament_fee_batches row or any
-- accounting_tournament_fee_sources. atomic_cancel_tournament refunded both
-- entrants in full and wrote two negative rake_records that name exactly those
-- two charges; the cancellation receipt says fees_reversed = total_rake_before,
-- total_rake_after = 0, fully_settled. Raw net fee: exactly 0. Nothing was
-- ever earnable, nobody is owed anything, and no chip moves in this migration.
--
-- THE CAUSE, BY LINE:
--
-- fn_record_accounting_tournament_cancellation calls
-- fn_recognize_accounting_tournament_fees, which calls
-- fn_accounting_tournament_fee_net_plan. The net plan's capture check
-- requires every POSITIVE fee row to have a captured batch whose sources sum
-- to it, and raises 55000 tournament_fee_sources_require_reconciliation
-- otherwise - before it ever looks at the refunds. It does not ask whether
-- that positive row was refunded in full by a cancellation. So a pre-capture
-- fee that was cancelled to zero is treated exactly like an earnable fee with
-- missing attribution; the cancellation path catches the 55000 and files the
-- event as 'banked_accrual_deferred', and the week can never close.
--
-- THE FIX, AT THE RULE (fn_accounting_tournament_fee_net_plan only):
--
--   When, and only when, the tournament's raw fee total is exactly 0, a
--   positive fee row with NO batch row and NO fee source, that is named by an
--   atomic_cancel_tournament reversal listed in an exact-zero cancellation
--   receipt (total_rake_after = 0 AND fees_reversed = total_rake_before), is
--   excused from the capture check. The refund loop below it is unchanged and
--   still proves every reversal exact (amount, club, user, order, receipt); a
--   new assertion then requires every excused row to have been refunded by
--   that loop. The plan is 'proven' with net 0, no active and no refunded
--   sources, so fn_recognize_accounting_tournament_fees writes 'cancelled'.
--
--   Unchanged on purpose: any tournament with a positive net (earnable or
--   partially reversed) gets an empty excused set, so its every positive row
--   still needs its captured batch; a row that HAS a batch (captured or not)
--   is never excused; a row with any fee source is never excused; a refund by
--   fn_unregister_from_tournament excuses nothing.
--
--   fn_accounting_tournament_week_quality needs no change: an event with any
--   negative row always takes its slow path, which is this net plan, and its
--   `batch_bad` fast-path counter only decides whether that slow path runs.
--
-- THE DAMAGE ALREADY DONE: the four recognitions are restated in place to
-- exactly the row fn_recognize_accounting_tournament_fees writes for a
-- zero-net cancellation (status 'cancelled', net_rake 0, union_id = the plan's
-- union, which is NULL with no fee sources, plan = the proven net plan), keeping
-- recognized_at (the cancellation instant), bank_club_id, the bank receipt ids
-- (both NULL) and source_fingerprint. The previous row is kept inside plan
-- under 'restated_from'. The immutability trigger is disabled and re-enabled
-- inside this one transaction for exactly these four rows; nothing outside it
-- ever sees it off. No recognized_sources, commissions, VIP credit or recompute
-- request exists or is written for a zero-net, zero-source recognition.
--
-- PINNED LIVE md5(pg_get_functiondef(...)), read 2026-10-06:
--   public.fn_accounting_tournament_fee_net_plan(uuid)
--     9b1147a5b373e2a01e3374b8dd2cc2fa
--
-- @live-proof: (SELECT position('cancelled_uncaptured' in pg_get_functiondef('public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure)) > 0 AND NOT EXISTS (SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE status = 'banked_accrual_deferred' AND net_rake = 0) AND (SELECT count(*) FROM public.accounting_tournament_fee_recognitions WHERE tournament_id IN ('097e3601-ccf9-4035-af40-eb35068d2652','20c75b67-7f78-4b29-b7df-9594faf62af0','92c93927-614f-4168-a1f9-918849c0be19','a4262ba0-cd5f-4a94-a0f8-915a028cf3a7') AND status = 'cancelled' AND net_rake = 0) = 4 AND (SELECT tgenabled FROM pg_trigger WHERE tgname = 'accounting_tournament_fee_recognitions_immutable') = 'O')
--
-- Apply once, outside the :50-:03 UTC break window, as one transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  v_fn oid := 'public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure;
  v_pin constant text := '9b1147a5b373e2a01e3374b8dd2cc2fa';
  v_def text;
  v_new_def text;
  v_o1 text; v_n1 text; v_o2 text; v_n2 text; v_o3 text; v_n3 text;
  v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_fn);
  IF position('cancelled_uncaptured' in v_def) > 0 THEN
    RETURN;
  END IF;
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_accounting_tournament_fee_net_plan is not the pinned text (md5 %)', md5(v_def);
  END IF;

  -- S1: the one new local.
  v_o1 := 'DECLARE refund_row record;';
  v_n1 := 'DECLARE cancelled_uncaptured uuid[]:=''{}'';refund_row record;';
  -- S2: the uncaptured, exactly-cancelled set, and the capture check skipping it.
  v_o2 := E' IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id\n   WHERE r.id=ANY(positive_ids) AND ((b.status';
  v_n2 := E' -- 20261006140724: a fee charged before capture existed (no batch, no source)\n'
       || E' -- that atomic_cancel_tournament refunded in full under its exact-zero\n'
       || E' -- cancellation receipt was never earnable. It is refunded, not held for\n'
       || E' -- reconciliation. Only when the whole tournament nets to exactly zero.\n'
       || E' IF raw_total=0 THEN\n'
       || E'  SELECT COALESCE(array_agg(r.id ORDER BY r.id),''{}'') INTO cancelled_uncaptured FROM public.rake_records r\n'
       || E'   WHERE r.id=ANY(positive_ids)\n'
       || E'    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)\n'
       || E'    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)\n'
       || E'    AND EXISTS(SELECT 1 FROM public.rake_records n JOIN public.tournament_cancellation_receipts c\n'
       || E'      ON c.tournament_id=p_tournament_id AND n.id=ANY(c.fee_reversal_ids)\n'
       || E'     WHERE n.tournament_id=p_tournament_id AND n.is_tournament AND n.source=''atomic_cancel_tournament'' AND n.rake_amount<0\n'
       || E'      AND ((jsonb_typeof(n.metadata->''original_rake_record_ids'')=''array'' AND n.metadata->''original_rake_record_ids'' ? r.id::text)\n'
       || E'       OR n.metadata->>''original_rake_record_id''=r.id::text)\n'
       || E'      AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before);\n'
       || E' END IF;\n'
       || E' IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id\n   WHERE r.id=ANY(positive_ids) AND NOT(r.id=ANY(cancelled_uncaptured)) AND ((b.status';
  -- S3: every row so excused must actually have been refunded by the loop.
  v_o3 := E' IF positive_total-refunded_total IS DISTINCT FROM raw_total THEN';
  v_n3 := E' IF NOT(cancelled_uncaptured<@refunded) THEN\n'
       || E'  RAISE EXCEPTION ''tournament_fee_uncaptured_cancellation_not_reversed'' USING ERRCODE=''23514''; END IF;\n'
       || v_o3;

  v_n := (length(v_def) - length(replace(v_def, v_o1, ''))) / length(v_o1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'net_plan: S1 anchor occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_o2, ''))) / length(v_o2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'net_plan: S2 anchor occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_o3, ''))) / length(v_o3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'net_plan: S3 anchor occurs % times, expected 1', v_n; END IF;

  v_new_def := replace(replace(replace(v_def, v_o1, v_n1), v_o2, v_n2), v_o3, v_n3);
  EXECUTE v_new_def;

  -- Postimage: exactly what was written, and nothing else.
  v_def := pg_get_functiondef(v_fn);
  IF v_def IS DISTINCT FROM v_new_def THEN
    RAISE EXCEPTION 'net_plan: the stored definition is not the substituted text';
  END IF;
  IF md5(replace(replace(replace(v_def, v_n3, v_o3), v_n2, v_o2), v_n1, v_o1)) <> v_pin THEN
    RAISE EXCEPTION 'net_plan: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- The four recognitions, restated through the proven plan.
DO $r$
DECLARE
  v_ids constant uuid[] := ARRAY[
    '097e3601-ccf9-4035-af40-eb35068d2652','20c75b67-7f78-4b29-b7df-9594faf62af0',
    '92c93927-614f-4168-a1f9-918849c0be19','a4262ba0-cd5f-4a94-a0f8-915a028cf3a7']::uuid[];
  v_id uuid;
  v_row record;
  v_plan jsonb;
  v_raw numeric;
  v_n integer;
BEGIN
  -- The board as read: these four, and nothing else, are deferred.
  SELECT count(*) INTO v_n FROM public.accounting_tournament_fee_recognitions
   WHERE status = 'banked_accrual_deferred';
  IF v_n = 0 AND (SELECT count(*) FROM public.accounting_tournament_fee_recognitions
                   WHERE tournament_id = ANY(v_ids) AND status = 'cancelled' AND net_rake = 0) = 4 THEN
    RETURN;  -- already restated
  END IF;
  IF v_n <> 4 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions
                         WHERE status = 'banked_accrual_deferred' AND NOT (tournament_id = ANY(v_ids))) THEN
    RAISE EXCEPTION 'expected exactly the four deferred recognitions read on 2026-10-06, found %', v_n;
  END IF;

  ALTER TABLE public.accounting_tournament_fee_recognitions
    DISABLE TRIGGER accounting_tournament_fee_recognitions_immutable;

  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:' || v_id::text, 0));
    SELECT * INTO v_row FROM public.accounting_tournament_fee_recognitions WHERE tournament_id = v_id FOR UPDATE;
    SELECT COALESCE(sum(rake_amount), 0) INTO v_raw
      FROM public.rake_records WHERE tournament_id = v_id AND is_tournament;
    IF v_row.status IS DISTINCT FROM 'banked_accrual_deferred' OR v_row.net_rake IS DISTINCT FROM 0 OR v_raw <> 0
       OR v_row.plan->>'reason' IS DISTINCT FROM 'tournament_fee_sources_require_reconciliation'
       OR v_row.union_wallet_transaction_id IS NOT NULL OR v_row.bank_journal_id IS NOT NULL
       OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id = v_id)
       OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE tournament_id = v_id)
       OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id = v_id)
       OR NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id = v_id
                       AND c.total_rake_after = 0 AND c.fees_reversed = c.total_rake_before) THEN
      RAISE EXCEPTION 'recognition % is not the zero-net pre-capture cancellation read on 2026-10-06', v_id;
    END IF;
    v_plan := public.fn_accounting_tournament_fee_net_plan(v_id);
    IF v_plan->>'status' IS DISTINCT FROM 'proven'
       OR (v_plan->>'net_fee')::numeric IS DISTINCT FROM 0
       OR v_plan->>'source_fingerprint' IS DISTINCT FROM v_row.source_fingerprint
       OR NULLIF(v_plan->>'union_id','') IS NOT NULL
       OR v_plan->'active_source_ids' IS DISTINCT FROM '[]'::jsonb
       OR v_plan->'refunded_source_ids' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'net plan for % is not a proven zero: %', v_id, v_plan;
    END IF;
    -- Exactly the row fn_recognize_accounting_tournament_fees writes for a
    -- zero-net cancellation, at the original recognition instant.
    UPDATE public.accounting_tournament_fee_recognitions
       SET status = 'cancelled',
           net_rake = (v_plan->>'net_fee')::numeric,
           union_id = NULLIF(v_plan->>'union_id','')::uuid,
           plan = v_plan || jsonb_build_object('restated_by', '20261006140724',
                    'restated_from', jsonb_build_object('status', v_row.status, 'union_id', v_row.union_id,
                      'plan', v_row.plan))
     WHERE tournament_id = v_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'restating % touched % rows', v_id, v_n; END IF;
  END LOOP;

  ALTER TABLE public.accounting_tournament_fee_recognitions
    ENABLE TRIGGER accounting_tournament_fee_recognitions_immutable;

  -- Postimage: the four are cancelled/0, nothing is deferred, the receipt
  -- reader accepts each one, and the table is immutable again.
  IF (SELECT count(*) FROM public.accounting_tournament_fee_recognitions
       WHERE tournament_id = ANY(v_ids) AND status = 'cancelled' AND net_rake = 0 AND union_id IS NULL) <> 4
     OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE status = 'banked_accrual_deferred') THEN
    RAISE EXCEPTION 'restatement postimage does not hold';
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    IF public.fn_accounting_tournament_terminal_fee_receipt(v_id)->>'status' IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'terminal fee receipt for % does not read cancelled', v_id;
    END IF;
  END LOOP;
  IF (SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'public.accounting_tournament_fee_recognitions'::regclass
         AND tgname = 'accounting_tournament_fee_recognitions_immutable') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'the recognition immutability trigger is not enabled';
  END IF;
END $r$;

COMMIT;
