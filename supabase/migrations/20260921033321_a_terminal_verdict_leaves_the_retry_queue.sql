-- a_terminal_verdict_leaves_the_retry_queue
--
-- CLAUDE.md 10.9/10.11: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- public.accounting_cash_source_work holds 36,131 rows at status='blocked',
-- and 35,994 of them can NEVER succeed. Measured 2026-09-21 03:26-03:30 UTC:
--
--   work status   batch status         rows
--   blocked       legacy_unverified  35,994   <- guaranteed-futile
--   blocked       (no batch row)        137   <- genuinely retryable
--   accrued       accrued           231,564
--
-- fn_retry_cash_accounting_sources, which the engine's RakebackSettlerService
-- calls at the TOP of every cycle before it reads any new work, selects:
--
--   SELECT rake_record_id FROM public.accounting_cash_source_work
--    WHERE status='blocked' AND next_attempt_at<=clock_timestamp()
--    ORDER BY next_attempt_at,rake_record_id LIMIT p_limit
--
-- so every cycle it draws 50 rows from a 36,000-row pool that cannot move.
--
-- WHY THE VERDICT IS LATCHED, read from the function bodies rather than
-- assumed. fn_accrue_cash_hand_commissions looks the batch row up FIRST, and
-- returns the STORED status before it reads the cutover or anything else:
--
--   SELECT * INTO batch FROM public.accounting_cash_accrual_batches
--    WHERE rake_record_id=source.id;
--   IF FOUND THEN
--    IF batch.source_fingerprint<>fingerprint THEN RAISE EXCEPTION ... END IF;
--    RETURN jsonb_build_object('recorded',true,'duplicate',true,
--                              'status',batch.status,'source_version',2);
--   END IF;
--
-- So once a batch row exists the answer is fixed. It cannot be un-latched:
--
--   * no function in this database UPDATEs or DELETEs
--     accounting_cash_accrual_batches (checked against every routine whose
--     body mentions the table);
--   * triggers accounting_cash_batch_immutable (BEFORE DELETE OR UPDATE) and
--     accounting_cash_batch_no_truncate (BEFORE TRUNCATE) refuse both;
--   * CHECK (status = ANY (ARRAY['accrued','legacy_unverified'])) and
--     CHECK ((status='accrued') = (plan IS NOT NULL)) together mean a legacy
--     row - which is inserted with no plan - could not become 'accrued'
--     even if an UPDATE were permitted;
--   * moving accounting_cash_accrual_cutover would change nothing, because
--     the cutover is only consulted BELOW the early return above.
--
-- fn_process_cash_accounting_source then records that permanent verdict as a
-- TRANSIENT failure:
--
--   IF result->>'status'='legacy_unverified' AND result->>'recorded'='true'
--   THEN status_value:='blocked';reason_value:='cash_source_legacy_unverified';
--
-- and falls through to the common write, which gives every blocked row a
-- finite backoff capped at one hour:
--
--   next_attempt_at = clock_timestamp()
--                   + make_interval(secs=>LEAST(3600,60*next_attempt)::int)
--
-- THAT LINE IS THE DEFECT. A verdict that can never change is being given a
-- date to be tried again. Everything downstream follows from it.
--
-- ===========================================================================
-- WHAT IT COSTS, MEASURED ON A LIVE SETTLER
-- ===========================================================================
--
-- The settler is running. Receipts per minute, 2026-09-21 03:26-03:28 UTC:
--
--   03:28  accrued 1,186   blocked/legacy_unverified 50   blocked/deadlock 7
--   03:27  accrued 1,145   blocked/legacy_unverified 50   blocked/deadlock 2
--   03:26  accrued   476   blocked/legacy_unverified 50
--
-- Fifty every minute, every minute: p_limit is 50, so THE ENTIRE RETRY BUDGET
-- is spent on work that is guaranteed to fail, ~72,000 futile attempts a day.
-- Attempts on individual rows have reached 38.
--
-- And it starves the real queue. Ranking every due blocked row by the
-- selector's own ORDER BY (next_attempt_at, rake_record_id):
--
--   reason                        rows  best rank  picked this cycle
--   cash_source_legacy_unverified 35,944        1                 50
--   deadlock detected                137   22,895                  0
--
-- The best-placed genuinely retryable source sits at rank 22,895. All 137 are
-- still at attempts=1 - the retry lane has never once reached them - because
-- the futile rows are re-queued with a fresh backoff each time they are tried
-- and cycle back in ahead of them, perpetually.
--
-- This is the same defect that caused the original three-day settler outage,
-- when the pool was 150 rows. It is now 240x larger.
--
-- ===========================================================================
-- THE FIX, AND WHY IT IS NOT THE OTHER ONE
-- ===========================================================================
--
-- The obvious repair is to give these work rows a terminal status of their
-- own. THAT WOULD BE A SERIOUS MISTAKE HERE, and the reason is worth writing
-- down so nobody reaches for it later.
--
-- accounting_cash_source_work.status='blocked' is not merely a queue state.
-- It is read by fn_cash_source_refusals_for_period:
--
--   FROM public.accounting_cash_source_work w
--   JOIN public.accounting_cash_source_receipts r ON r.id=w.receipt_id
--   WHERE w.status='blocked' AND ...
--   RETURN jsonb_build_object('status',
--     CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,
--     'count',...)
--
-- whose sole caller is fn_prepare_accounting_week. That is the gate which
-- stops a weekly accounting close from running over sources that were never
-- accounted for. Move these 35,994 rows off 'blocked' and that gate returns
-- 'ready' for every week containing them - silently un-blocking weekly closes
-- over the 52,305-hand / 111,962.41 orphaned window, and making the window
-- look settled when it is not. That is precisely what must not happen: these
-- rows are awaiting an owner decision (task #68) and must stay visible,
-- countable and blocking.
--
-- So the status is left exactly as it is, and the fix goes to the column
-- whose actual job is to answer "when should this be tried again". The honest
-- answer for a latched verdict is "never", and timestamptz can say so:
--
--   next_attempt_at = 'infinity'
--
-- This is not a silent skip (CLAUDE.md 10.86). The row still reads
-- status='blocked'; its receipt still reads reason='cash_source_legacy_
-- unverified', sqlstate 55000; it is still counted by the weekly-close gate
-- exactly as before; and it now states in its own scheduling column that no
-- further attempt is due. Nothing is hidden, deleted, or made to look
-- settled - one scheduling field stops lying about a decision that was
-- already made. The existing selector predicate is left untouched and keeps
-- its plain meaning, "rows that are due", because these rows are genuinely
-- never due. The existing partial index
-- accounting_cash_source_work_retry (next_attempt_at, rake_record_id)
-- WHERE status='blocked' still covers them; they simply sort to the far end
-- of it, past the range scan's upper bound.
--
-- And the skip is REPORTED rather than merely true:
-- fn_retry_cash_accounting_sources now returns 'terminal_parked', the count
-- of rows it is deliberately not attempting, in the receipt it hands back on
-- every cycle. A caller is told the number, every time.
--
-- THIS IS NOT A REPAIR JOB (CLAUDE.md 10.12). It creates no function, no cron
-- and no schedule; it pays nobody, moves no chips and writes no wallet row.
-- It only stops futile work. The one-time UPDATE below is the settling of
-- damage already done that 10.11 step 3 requires, not a job that will run
-- again.
--
-- WHAT IS DELIBERATELY NOT PARKED. Only the latched verdict is terminal. A
-- source whose accrual raises for any other reason - including
-- 'cash_accrual_source_changed_after_recording', which fires when a recorded
-- source's fingerprint later moves - goes through the EXCEPTION handler with
-- v_terminal false and keeps its ordinary backoff. Those are real anomalies
-- and must stay in the queue. The 137 deadlocked rows have no batch row at
-- all and are untouched by every predicate here; freeing the lane is what
-- finally lets them be retried.
--
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '180s';

-- ---------------------------------------------------------------------------
-- 1. fn_process_cash_accounting_source: a latched verdict schedules no retry.
-- ---------------------------------------------------------------------------
DO $mig1$
DECLARE
  v_src text;
  v_new text;
  v_a1 text; v_r1 text;   -- DECLARE: carry the terminal flag
  v_a2 text; v_r2 text;   -- the legacy branch raises the flag
  v_a3 text; v_r3 text;   -- the write schedules no further attempt
  v_a4 text; v_r4 text;   -- the exception path lowers the flag
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_process_cash_accounting_source';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_process_cash_accounting_source is absent';
  END IF;

  v_a1 := $a$ player record;club record;week_start date;next_attempt bigint; applied boolean;$a$;
  v_r1 := $b$ player record;club record;week_start date;next_attempt bigint; applied boolean; v_terminal boolean:=false;$b$;

  v_a2 := $a$   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';$a$;
  v_r2 := $b$   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';v_terminal:=true;$b$;

  v_a3 := $a$  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int))$a$;
  v_r3 := $b$  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,CASE WHEN v_terminal THEN 'infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int) END)$b$;

  v_a4 := $a$  status_value:='blocked';credits:='[]';$a$;
  v_r4 := $b$  status_value:='blocked';credits:='[]';v_terminal:=false;$b$;

  -- Each anchor must appear EXACTLY once, or the body is not the one this
  -- migration was written against.
  IF (length(v_src) - length(replace(v_src, v_a1, ''))) / length(v_a1) <> 1 THEN
    RAISE EXCEPTION 'the DECLARE list is not present exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_a2, ''))) / length(v_a2) <> 1 THEN
    RAISE EXCEPTION 'the legacy_unverified branch is not present exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_a3, ''))) / length(v_a3) <> 1 THEN
    RAISE EXCEPTION 'the work-row VALUES list is not present exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_a4, ''))) / length(v_a4) <> 1 THEN
    RAISE EXCEPTION 'the exception handler is not present exactly once';
  END IF;

  -- A re-run against an already-fixed body must stop rather than double-apply.
  IF position('v_terminal' in v_src) > 0
  OR position('''infinity''::timestamptz' in v_src) > 0 THEN
    RAISE EXCEPTION 'fn_process_cash_accounting_source already carries a terminal branch';
  END IF;

  v_new := replace(replace(replace(replace(v_src, v_a1, v_r1), v_a2, v_r2), v_a3, v_r3), v_a4, v_r4);

  -- Assert the composition before executing it.
  IF v_new = v_src THEN
    RAISE EXCEPTION 'fn_process_cash_accounting_source substitution changed nothing';
  END IF;
  IF (length(v_new) - length(replace(v_new, 'v_terminal', ''))) / length('v_terminal') <> 4 THEN
    RAISE EXCEPTION 'expected the terminal flag to appear exactly four times';
  END IF;
  IF (length(v_new) - length(replace(v_new, '''infinity''::timestamptz', '')))
     / length('''infinity''::timestamptz') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one infinite next_attempt_at';
  END IF;
  -- The ordinary backoff must survive for every non-terminal refusal.
  IF position('LEAST(3600,60*next_attempt)::int' in v_new) = 0 THEN
    RAISE EXCEPTION 'the ordinary retry backoff was lost';
  END IF;
  -- Every other guard in this function must survive untouched.
  IF position('fn_caller_is_engine'                      in v_new) = 0
  OR position('cash_source_not_authorised'               in v_new) = 0
  OR position('cash_source_record_required'              in v_new) = 0
  OR position('cash_source_identity_or_amount_invalid'   in v_new) = 0
  OR position('cash_source_accrual_receipt_invalid'      in v_new) = 0
  OR position('cash_source_player_stats_receipt_invalid' in v_new) = 0
  OR position('cash_source_contributor_receipts_missing' in v_new) = 0
  OR position('pg_advisory_xact_lock'                    in v_new) = 0
  OR position('fn_cash_source_refusal_scope'             in v_new) = 0
  OR position('apply_rakeback_player_stats'              in v_new) = 0
  OR position('accounting_period_recompute_requests'     in v_new) = 0
  OR position('GET STACKED DIAGNOSTICS'                  in v_new) = 0 THEN
    RAISE EXCEPTION 'the substitution damaged a guard in fn_process_cash_accounting_source';
  END IF;

  EXECUTE v_new;
END;
$mig1$;

-- ---------------------------------------------------------------------------
-- 2. fn_retry_cash_accounting_sources: report what it is not attempting.
--    The SELECTION IS DELIBERATELY UNCHANGED - it still means "rows that are
--    due", and a parked row is genuinely never due.
-- ---------------------------------------------------------------------------
DO $mig2$
DECLARE
  v_src text;
  v_new text;
  v_a1 text; v_r1 text;
  v_a2 text; v_r2 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_retry_cash_accounting_sources is absent';
  END IF;

  v_a1 := $a$DECLARE w record;r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;$a$;
  v_r1 := $b$DECLARE w record;r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;$b$;

  v_a2 := $a$ RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,$a$;
  v_r2 := $b$ SELECT count(*) INTO v_parked FROM public.accounting_cash_source_work
  WHERE status='blocked' AND next_attempt_at='infinity'::timestamptz;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,'terminal_parked',v_parked,$b$;

  IF (length(v_src) - length(replace(v_src, v_a1, ''))) / length(v_a1) <> 1 THEN
    RAISE EXCEPTION 'the retry DECLARE list is not present exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_a2, ''))) / length(v_a2) <> 1 THEN
    RAISE EXCEPTION 'the retry RETURN is not present exactly once';
  END IF;
  IF position('terminal_parked' in v_src) > 0 THEN
    RAISE EXCEPTION 'fn_retry_cash_accounting_sources already reports a parked count';
  END IF;

  v_new := replace(replace(v_src, v_a1, v_r1), v_a2, v_r2);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'fn_retry_cash_accounting_sources substitution changed nothing';
  END IF;
  IF (length(v_new) - length(replace(v_new, 'terminal_parked', '')))
     / length('terminal_parked') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one terminal_parked report';
  END IF;
  -- The selection must be untouched: same predicate, same order, same limit.
  IF position($q$WHERE status='blocked'$q$                 in v_new) = 0
  OR position($q$AND next_attempt_at<=clock_timestamp()$q$ in v_new) = 0
  OR position('ORDER BY next_attempt_at,rake_record_id LIMIT p_limit' in v_new) = 0 THEN
    RAISE EXCEPTION 'the retry selection was altered';
  END IF;
  -- Every other guard must survive.
  IF position('fn_caller_is_engine'        in v_new) = 0
  OR position('cash_source_not_authorised' in v_new) = 0
  OR position('invalid_cash_retry_limit'   in v_new) = 0
  OR position('p_limit>200'                in v_new) = 0
  OR position('first_error'                in v_new) = 0 THEN
    RAISE EXCEPTION 'the substitution damaged a guard in fn_retry_cash_accounting_sources';
  END IF;

  EXECUTE v_new;
END;
$mig2$;

-- ---------------------------------------------------------------------------
-- 3. Settle the damage already done: park the rows whose verdict is already
--    latched. One UPDATE, once. Nothing is deleted and no status changes, so
--    the weekly-close gate counts exactly what it counted before.
-- ---------------------------------------------------------------------------
DO $mig3$
DECLARE
  v_blocked_before bigint;
  v_accrued_before bigint;
  v_eligible       bigint;
  v_updated        bigint;
  v_blocked_after  bigint;
  v_accrued_after  bigint;
  v_parked_after   bigint;
  v_due_after      bigint;
  v_mislabelled    bigint;
BEGIN
  SELECT count(*) FILTER (WHERE status='blocked'),
         count(*) FILTER (WHERE status='accrued')
    INTO v_blocked_before, v_accrued_before
    FROM public.accounting_cash_source_work;

  SELECT count(*) INTO v_eligible
    FROM public.accounting_cash_source_work w
    JOIN public.accounting_cash_source_receipts rc ON rc.id = w.receipt_id
    JOIN public.accounting_cash_accrual_batches b  ON b.rake_record_id = w.rake_record_id
   WHERE w.status = 'blocked'
     AND w.next_attempt_at <> 'infinity'::timestamptz
     AND rc.reason = 'cash_source_legacy_unverified'
     AND b.status  = 'legacy_unverified';

  -- Measured at 35,994 on 2026-09-21 03:27 UTC. The settler is live, so an
  -- exact literal would abort on ordinary churn; a band still aborts if the
  -- board has moved underneath this migration.
  IF v_eligible < 30000 OR v_eligible > 45000 THEN
    RAISE EXCEPTION 'eligible latched rows = %, outside the measured band 30000-45000', v_eligible;
  END IF;

  UPDATE public.accounting_cash_source_work w
     SET next_attempt_at = 'infinity'::timestamptz
    FROM public.accounting_cash_source_receipts rc,
         public.accounting_cash_accrual_batches b
   WHERE rc.id = w.receipt_id
     AND b.rake_record_id = w.rake_record_id
     AND w.status = 'blocked'
     AND w.next_attempt_at <> 'infinity'::timestamptz
     AND rc.reason = 'cash_source_legacy_unverified'
     AND b.status  = 'legacy_unverified';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_eligible THEN
    RAISE EXCEPTION 'parked % rows but % were eligible', v_updated, v_eligible;
  END IF;

  SELECT count(*) FILTER (WHERE status='blocked'),
         count(*) FILTER (WHERE status='accrued'),
         count(*) FILTER (WHERE status='blocked' AND next_attempt_at='infinity'::timestamptz),
         count(*) FILTER (WHERE status='blocked' AND next_attempt_at<=clock_timestamp())
    INTO v_blocked_after, v_accrued_after, v_parked_after, v_due_after
    FROM public.accounting_cash_source_work;

  -- The orphaned window must remain exactly as visible and as blocking as it
  -- was: same status, same count, same rows feeding the weekly-close gate.
  IF v_blocked_after <> v_blocked_before THEN
    RAISE EXCEPTION 'blocked total moved from % to %', v_blocked_before, v_blocked_after;
  END IF;
  IF v_accrued_after <> v_accrued_before THEN
    RAISE EXCEPTION 'accrued total moved from % to %', v_accrued_before, v_accrued_after;
  END IF;
  IF v_parked_after < v_eligible THEN
    RAISE EXCEPTION 'parked count % is below the % rows just parked', v_parked_after, v_eligible;
  END IF;

  -- Nothing may be parked whose verdict is not the latched one.
  SELECT count(*) INTO v_mislabelled
    FROM public.accounting_cash_source_work w
    JOIN public.accounting_cash_source_receipts rc ON rc.id = w.receipt_id
    LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id = w.rake_record_id
   WHERE w.next_attempt_at = 'infinity'::timestamptz
     AND (rc.reason IS DISTINCT FROM 'cash_source_legacy_unverified'
          OR b.status IS DISTINCT FROM 'legacy_unverified');
  IF v_mislabelled <> 0 THEN
    RAISE EXCEPTION '% parked rows do not carry the latched verdict', v_mislabelled;
  END IF;

  -- The retry lane must now be able to reach the genuinely retryable work.
  IF v_due_after > 5000 THEN
    RAISE EXCEPTION 'still % rows due after parking; the lane is not freed', v_due_after;
  END IF;

  RAISE NOTICE 'parked % latched rows; blocked total % unchanged; due now %',
               v_updated, v_blocked_after, v_due_after;
END;
$mig3$;

COMMIT;
