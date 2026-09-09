\set ON_ERROR_STOP on

DO $assert_cutover$
DECLARE
  v bigint;
  n numeric;
BEGIN
  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08';
  IF v <> 2 THEN
    RAISE EXCEPTION 'ghost/empty cutover witness is %, expected 2', v;
  END IF;

  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 151 THEN RAISE EXCEPTION 'cutover player one cents %, expected 151', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000002';
  IF v <> 150 THEN RAISE EXCEPTION 'cutover player two cents %, expected 150', v; END IF;

  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000002'
     AND day = '2026-09-08';
  IF v <> 2 THEN RAISE EXCEPTION 'stale day was not rebuilt: %', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000002'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 200 THEN RAISE EXCEPTION 'stale day cents %, expected 200', v; END IF;

  SELECT count(*) INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day BETWEEN '2026-09-07' AND '2026-09-13';
  IF v <> 7 THEN RAISE EXCEPTION 'pending week has % witnesses, expected 7', v; END IF;

  SELECT source_records INTO v FROM public.rakeback_basis_epoch WHERE singleton;
  IF v <> 6 THEN RAISE EXCEPTION 'epoch source count %, expected 6', v; END IF;
  SELECT source_cents INTO v FROM public.rakeback_basis_epoch WHERE singleton;
  IF v <> 503 THEN RAISE EXCEPTION 'epoch cents %, expected 503', v; END IF;

  SELECT rake_generated INTO n FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND user_id = '20000000-0000-4000-8000-000000000001'
     AND period_start = '2026-09-07';
  IF n <> 1.51 THEN RAISE EXCEPTION 'cutover period basis %, expected 1.51', n; END IF;

  SELECT count(*) INTO v FROM public.rakeback_accrual_records;
  IF v <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.rakeback_accrual_records
     WHERE rake_record_id = '50000000-0000-4000-8000-000000000107'
       AND basis_origin = 'cutover_materialized'
  ) THEN
    RAISE EXCEPTION
      'cutover materialized % source receipts; expected only the paid refund original', v;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rakeback_compensation_links
     WHERE compensation_rake_record_id = '50000000-0000-4000-8000-000000000108'
       AND original_rake_record_id = '50000000-0000-4000-8000-000000000107'
       AND original_cents = 400
  ) THEN
    RAISE EXCEPTION 'cutover paid refund did not link its exact original';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rakeback_closed_period_offsets
     WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000107'
       AND user_id = '20000000-0000-4000-8000-000000000014'
       AND cents = 400
       AND original_period_start = '2026-08-31'
       AND offset_period_start = '2026-09-07'
  ) THEN
    RAISE EXCEPTION 'cutover paid refund did not post its current open offset';
  END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000013'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000014';
  IF v <> -400 THEN
    RAISE EXCEPTION 'cutover paid refund open basis is %, expected -400', v;
  END IF;
END
$assert_cutover$;

-- Production's legacy key included period_end and admitted duplicate pending
-- rows for one player/club/week. Cutover must consolidate only those pending
-- projections, preserve paid evidence, allow a new pending balance beside a
-- paid row, and keep the same player's second club independent.
DO $assert_strict_period_identity$
DECLARE
  v bigint;
  d date;
  t text;
  n numeric;
  b boolean;
BEGIN
  PERFORM public.fn_rakeback_recompute_periods(
    '10000000-0000-4000-8000-000000000019',
    '2026-09-07', '2026-09-13',
    ARRAY['20000000-0000-4000-8000-000000000019'::uuid]
  );
  PERFORM public.fn_rakeback_recompute_periods(
    '10000000-0000-4000-8000-000000000020',
    '2026-09-07', '2026-09-13',
    ARRAY['20000000-0000-4000-8000-000000000019'::uuid]
  );
  SELECT count(*) INTO v FROM public.rakeback_periods
   WHERE user_id = '20000000-0000-4000-8000-000000000019'
     AND period_start = '2026-09-07';
  IF v <> 3 THEN
    RAISE EXCEPTION 'club-scoped paid/pending identity has % rows, expected 3', v;
  END IF;
  SELECT period_end, status INTO d, t
    FROM public.rakeback_periods
   WHERE user_id = '20000000-0000-4000-8000-000000000019'
     AND club_id = '10000000-0000-4000-8000-000000000019'
     AND period_start = '2026-09-07'
     AND status = 'paid';
  IF d <> '2026-09-07' OR t <> 'paid' THEN
    RAISE EXCEPTION
      'legacy paid period changed: end %, status %', d, t;
  END IF;
  SELECT period_end, status, rake_generated INTO d, t, n
    FROM public.rakeback_periods
   WHERE user_id = '20000000-0000-4000-8000-000000000019'
     AND club_id = '10000000-0000-4000-8000-000000000019'
     AND period_start = '2026-09-07'
     AND status = 'pending';
  IF d <> '2026-09-13' OR t <> 'pending' OR n <> 0.01 THEN
    RAISE EXCEPTION
      'post-paid pending period is end %, status %, basis %, expected 2026-09-13/pending/0.01',
      d, t, n;
  END IF;
  SELECT period_end, status, rake_generated INTO d, t, n
    FROM public.rakeback_periods
   WHERE user_id = '20000000-0000-4000-8000-000000000019'
     AND club_id = '10000000-0000-4000-8000-000000000020'
     AND period_start = '2026-09-07';
  IF d <> '2026-09-13' OR t <> 'pending' OR n <> 0.01 THEN
    RAISE EXCEPTION
      'second club period is end %, status %, basis %, expected 2026-09-13/pending/0.01',
      d, t, n;
  END IF;
  SELECT count(*), bool_and(period_end = '2026-09-13')
    INTO v, b
    FROM public.rakeback_periods
   WHERE user_id = '20000000-0000-4000-8000-000000000026'
     AND club_id = '10000000-0000-4000-8000-000000000021'
     AND period_start = '2026-09-07'
     AND status = 'pending';
  IF v <> 1 OR b IS NOT TRUE THEN
    RAISE EXCEPTION
      'legacy duplicate pending projection was not consolidated: count %, canonical %',
      v, b;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.rakeback_periods'::regclass
       AND c.conname =
           'rakeback_periods_user_id_club_id_period_start_period_end_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid =
             to_regclass('public.rakeback_periods_one_pending_user_club_week_idx')
       AND i.indrelid = 'public.rakeback_periods'::regclass
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND pg_get_expr(i.indpred, i.indrelid, false) =
           '(status = ''pending''::text)'
  ) THEN
    RAISE EXCEPTION 'pending rakeback period identity is not canonical';
  END IF;
END
$assert_strict_period_identity$;

INSERT INTO public.rake_records (
  id, hand_id, table_id, global_hand_id, club_id, rake_amount, created_at,
  player_contributions, is_tournament, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000201',
  '40000000-0000-4000-8000-000000000201',
  '30000000-0000-4000-8000-000000000001',
  1000201,
  '10000000-0000-4000-8000-000000000001', 1.03,
  '2026-09-08 06:00:00+00',
  '{"20000000-0000-4000-8000-000000000001":30,"20000000-0000-4000-8000-000000000002":70}'::jsonb,
  false, 'probe_new', '{"hand_number":1000201}'::jsonb,
  'WEIGHTED_CONTRIBUTED'
);

DO $assert_accrual$
DECLARE
  v bigint;
  n numeric;
BEGIN
  SELECT source_rake_cents INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 103 THEN RAISE EXCEPTION 'accrual header cents %, expected 103', v; END IF;
  SELECT global_hand_id INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 1000201 THEN RAISE EXCEPTION 'accrual global hand is %, expected 1000201', v; END IF;
  SELECT sum(cents) INTO v FROM public.rakeback_accrual_receipts
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 103 THEN RAISE EXCEPTION 'accrual lines sum %, expected 103', v; END IF;
  SELECT cents INTO v FROM public.rakeback_accrual_receipts
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 31 THEN RAISE EXCEPTION 'weighted first share %, expected 31', v; END IF;
  SELECT cents INTO v FROM public.rakeback_accrual_receipts
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201'
     AND user_id = '20000000-0000-4000-8000-000000000002';
  IF v <> 72 THEN RAISE EXCEPTION 'weighted second share %, expected 72', v; END IF;

  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 182 THEN RAISE EXCEPTION 'atomic daily first total %, expected 182', v; END IF;
  SELECT rake_generated INTO n FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND user_id = '20000000-0000-4000-8000-000000000002'
     AND period_start = '2026-09-07';
  IF n <> 2.22 THEN RAISE EXCEPTION 'atomic period second total %, expected 2.22', n; END IF;
END
$assert_accrual$;

-- Same-value source replay must validate the fingerprint and change nothing.
UPDATE public.rake_records SET rake_amount = rake_amount
 WHERE id = '50000000-0000-4000-8000-000000000201';

DO $assert_replay_and_mutation$
DECLARE
  v bigint;
BEGIN
  SELECT count(*) INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 1 THEN RAISE EXCEPTION 'same source replay produced % headers', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 182 THEN RAISE EXCEPTION 'same source replay changed daily basis to %', v; END IF;

  BEGIN
    UPDATE public.rake_records SET rake_amount = 1.04
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rake_records SET metadata = '{"hand_number":1000999}'::jsonb
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED ghost basis mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED ghost basis mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rake_records
       SET tournament_id = '60000000-0000-4000-8000-000000000099'
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED tournament provenance mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED tournament provenance mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rake_records SET is_tournament = true
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED tournament-kind provenance mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED tournament-kind provenance mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rake_records SET source = 'forged_source'
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED source provenance mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED source provenance mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rake_records SET global_hand_id = 1000299
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED global hand provenance mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED global hand provenance mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rake_records
       SET id = '50000000-0000-4000-8000-000000000299'
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED source primary key mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED source primary key mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%basis is immutable financial history%' THEN RAISE; END IF;
  END;

  SELECT count(*) INTO v FROM public.rake_records
   WHERE id = '50000000-0000-4000-8000-000000000201'
      OR id = '50000000-0000-4000-8000-000000000299';
  IF v <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.rake_records
     WHERE id = '50000000-0000-4000-8000-000000000201'
       AND global_hand_id = 1000201
  ) THEN
    RAISE EXCEPTION 'source identity mutation did not roll back exactly';
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 1 THEN RAISE EXCEPTION 'source identity mutation changed its receipt header'; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 182 THEN RAISE EXCEPTION 'source identity mutation changed daily basis to %', v; END IF;

  BEGIN
    UPDATE public.rake_records
       SET hand_id = '40000000-0000-4000-8000-000000000299'
     WHERE id = '50000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'PROBE_FAILED direct hand provenance mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED direct hand provenance mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%hand provenance is immutable financial history%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.rakeback_accrual_receipts SET cents = cents + 1
     WHERE rake_record_id = '50000000-0000-4000-8000-000000000201'
       AND user_id = '20000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'PROBE_FAILED receipt mutation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED receipt mutation was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%immutable financial history%' THEN RAISE; END IF;
  END;
END
$assert_replay_and_mutation$;

-- A real pre-start unregister deletes the fee row. It must leave both event
-- receipts and reverse the exact shares inside the DELETE transaction.
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000201';

DO $assert_new_reversal$
DECLARE
  v bigint;
  b boolean;
BEGIN
  SELECT reversed_cents, applied_to_basis INTO v, b FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 103 THEN RAISE EXCEPTION 'reversal header cents %, expected 103', v; END IF;
  IF b IS NOT TRUE THEN RAISE EXCEPTION 'current-epoch reversal did not apply'; END IF;
  SELECT sum(cents) INTO v FROM public.rakeback_accrual_reversal_receipts
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000201';
  IF v <> 103 THEN RAISE EXCEPTION 'reversal lines sum %, expected 103', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 151 THEN RAISE EXCEPTION 'new reversal left daily cents at %', v; END IF;
  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08';
  IF v <> 2 THEN RAISE EXCEPTION 'new reversal left witness at %', v; END IF;
END
$assert_new_reversal$;

-- A cutover-baseline row has no per-record receipt yet. Deleting it lazily
-- materializes that proof, then appends the compensating reversal.
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000101';

DO $assert_baseline_reversal$
DECLARE
  v bigint;
  t text;
BEGIN
  SELECT basis_origin INTO t FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000101';
  IF t <> 'cutover_materialized' THEN
    RAISE EXCEPTION 'baseline reversal origin is %', t;
  END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 100 THEN RAISE EXCEPTION 'baseline reversal left player one at %', v; END IF;
  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND day = '2026-09-08';
  IF v <> 1 THEN RAISE EXCEPTION 'baseline reversal left witness at %', v; END IF;
END
$assert_baseline_reversal$;

-- Paid history before the basis epoch stays immutable while still receiving a
-- durable source-deletion receipt.
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000100';

DO $assert_pre_epoch_reversal$
DECLARE
  t text;
  b boolean;
BEGIN
  SELECT reason, applied_to_basis INTO t, b FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000100';
  IF t <> 'source_deleted_before_basis_epoch_no_balance_change' THEN
    RAISE EXCEPTION 'pre-epoch reversal reason is %', t;
  END IF;
  IF b IS NOT FALSE THEN RAISE EXCEPTION 'pre-epoch reversal changed the basis'; END IF;
END
$assert_pre_epoch_reversal$;

-- The authorized one-time hand relink is provenance, even when the source is
-- older than the open basis. It therefore gets historical evidence and a
-- relink receipt, while still leaving paid/open balances untouched.
SELECT public.fn_relink_rake_record_to_hand(
  '30000000-0000-4000-8000-000000000014', 900109,
  '40000000-0000-4000-8000-000000000109'
);
DO $assert_pre_epoch_relink$
DECLARE
  v bigint;
BEGIN
  SELECT count(*) INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000109'
     AND basis_origin = 'historical_source_evidence';
  IF v <> 1 THEN RAISE EXCEPTION 'pre-epoch relink has no historical receipt'; END IF;
  SELECT count(*) INTO v FROM public.rakeback_source_relinks
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000109'
     AND from_hand_id IS NULL
     AND to_hand_id = '40000000-0000-4000-8000-000000000109';
  IF v <> 1 THEN RAISE EXCEPTION 'pre-epoch relink has no immutable provenance receipt'; END IF;
  BEGIN
    UPDATE public.rake_records
       SET hand_id = '40000000-0000-4000-8000-000000000110'
     WHERE id = '50000000-0000-4000-8000-000000000109';
    RAISE EXCEPTION 'PROBE_FAILED second pre-epoch relink was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED second pre-epoch relink was accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%hand provenance is immutable financial history%' THEN RAISE; END IF;
  END;
END
$assert_pre_epoch_relink$;

-- A fee can predate cutover, have its week paid, and remain refundable because
-- its future tournament has not started. It is intentionally absent from the
-- open cutover membership and had no negative row at migration time. The later
-- unregister must materialize exact historical evidence, preserve the paid
-- row, and post its refund into the current open period without blocking the
-- source transaction.
DO $assert_future_refund_source_was_not_cutover$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.rakeback_cutover_source_records
     WHERE rake_record_id IN (
       '50000000-0000-4000-8000-000000000110',
       '50000000-0000-4000-8000-000000000111',
       '50000000-0000-4000-8000-000000000112',
       '50000000-0000-4000-8000-000000000113'
     )
  ) OR EXISTS (
    SELECT 1 FROM public.rakeback_accrual_records
     WHERE rake_record_id IN (
       '50000000-0000-4000-8000-000000000110',
       '50000000-0000-4000-8000-000000000111',
       '50000000-0000-4000-8000-000000000112',
       '50000000-0000-4000-8000-000000000113'
     )
  ) THEN
    RAISE EXCEPTION 'pre-cutover future fee was incorrectly in the open basis';
  END IF;
END
$assert_future_refund_source_was_not_cutover$;

INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, player_contributions,
  is_tournament, tournament_id, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000510',
  '10000000-0000-4000-8000-000000000015', -6.00,
  '2026-09-08 10:30:00+00', NULL,
  true, '60000000-0000-4000-8000-000000000015',
  'fn_unregister_from_tournament',
  '{"kind":"tournament_fee_refund","original_rake_record_id":"50000000-0000-4000-8000-000000000110","registration_id":"pre-cutover-paid-future-refund","user_id":"20000000-0000-4000-8000-000000000016"}'::jsonb,
  'DEALT_EQUAL'
);

DO $assert_pre_cutover_paid_origin_future_refund$
DECLARE
  v bigint;
  n numeric;
  t text;
  v_offset_day date;
BEGIN
  SELECT count(*) INTO v FROM public.rake_records
   WHERE id = '50000000-0000-4000-8000-000000000510';
  IF v <> 1 THEN RAISE EXCEPTION 'pre-cutover paid-origin refund did not commit'; END IF;
  SELECT basis_origin INTO t FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000110';
  IF t <> 'historical_source_evidence' THEN
    RAISE EXCEPTION 'pre-cutover paid original evidence origin is %', t;
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_compensation_links
   WHERE compensation_rake_record_id = '50000000-0000-4000-8000-000000000510'
     AND original_rake_record_id = '50000000-0000-4000-8000-000000000110'
     AND original_cents = 600;
  IF v <> 1 THEN RAISE EXCEPTION 'pre-cutover paid refund has no exact original link'; END IF;
  SELECT cents, offset_day INTO v, v_offset_day
    FROM public.rakeback_closed_period_offsets
   WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000110'
     AND user_id = '20000000-0000-4000-8000-000000000016';
  IF v <> 600 THEN
    RAISE EXCEPTION 'pre-cutover paid refund offset is %, expected 600', v;
  END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000015'
     AND user_id = '20000000-0000-4000-8000-000000000016'
     AND day = v_offset_day;
  IF v <> -600 THEN
    RAISE EXCEPTION 'pre-cutover paid refund open basis is %, expected -600', v;
  END IF;
  SELECT rake_generated, status INTO n, t FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000015'
     AND user_id = '20000000-0000-4000-8000-000000000016'
     AND period_start = '2026-08-31';
  IF n <> 6 OR t <> 'paid' THEN
    RAISE EXCEPTION 'pre-cutover paid source period was mutated: basis %, status %', n, t;
  END IF;
END
$assert_pre_cutover_paid_origin_future_refund$;

-- fn_leave_seat_and_refund expresses the same lawful unregister by deleting
-- the positive tournament fee. The paid pre-cutover case must have the exact
-- same accounting outcome as the negative-record path.
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000111';

DO $assert_pre_cutover_paid_origin_future_delete$
DECLARE
  v bigint;
  n numeric;
  t text;
  b boolean;
  v_offset_day date;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.rake_records
     WHERE id = '50000000-0000-4000-8000-000000000111'
  ) THEN
    RAISE EXCEPTION 'pre-cutover paid-origin fee deletion did not commit';
  END IF;
  SELECT basis_origin INTO t FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000111';
  IF t <> 'historical_source_evidence' THEN
    RAISE EXCEPTION 'pre-cutover paid deleted original evidence origin is %', t;
  END IF;
  SELECT reversed_cents, applied_to_basis, reason INTO v, b, t
    FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000111';
  IF v <> 700 OR b IS NOT TRUE OR t <> 'source_record_deleted' THEN
    RAISE EXCEPTION
      'pre-cutover paid fee delete reversal is cents %, applied %, reason %',
      v, b, t;
  END IF;
  SELECT cents, offset_day INTO v, v_offset_day
    FROM public.rakeback_closed_period_offsets
   WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000111'
     AND user_id = '20000000-0000-4000-8000-000000000017';
  IF v <> 700 THEN
    RAISE EXCEPTION 'pre-cutover paid fee delete offset is %, expected 700', v;
  END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000016'
     AND user_id = '20000000-0000-4000-8000-000000000017'
     AND day = v_offset_day;
  IF v <> -700 THEN
    RAISE EXCEPTION 'pre-cutover paid fee delete open basis is %, expected -700', v;
  END IF;
  SELECT rake_generated, status INTO n, t FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000016'
     AND user_id = '20000000-0000-4000-8000-000000000017'
     AND period_start = '2026-08-31';
  IF n <> 7 OR t <> 'paid' THEN
    RAISE EXCEPTION
      'pre-cutover paid deleted source period was mutated: basis %, status %',
      n, t;
  END IF;
END
$assert_pre_cutover_paid_origin_future_delete$;

-- A paid historical source can allocate fewer cents than players.  Zero-cent
-- allocator rows are immutable provenance, but only positive receipts have a
-- basis to reverse.  Deleting this one-cent/six-player source must therefore
-- post exactly one cent for the sole positive recipient and must not be
-- misclassified as "not applied" merely because five shares are zero.
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000113';

DO $assert_historical_low_cent_paid_delete$
DECLARE
  v bigint;
  t text;
  b boolean;
  v_offset_day date;
BEGIN
  SELECT count(*) INTO v
    FROM public.rakeback_accrual_receipts
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000113';
  IF v <> 6 THEN
    RAISE EXCEPTION 'historical low-cent source has % shares, expected 6', v;
  END IF;
  SELECT count(*) INTO v
    FROM public.rakeback_accrual_receipts
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000113'
     AND cents > 0;
  IF v <> 1 THEN
    RAISE EXCEPTION 'historical low-cent source has % positive receipts, expected 1', v;
  END IF;
  SELECT reversed_cents, applied_to_basis, reason INTO v, b, t
    FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000113';
  IF v <> 1 OR b IS NOT TRUE OR t <> 'source_record_deleted' THEN
    RAISE EXCEPTION
      'historical low-cent paid delete reversal is cents %, applied %, reason %',
      v, b, t;
  END IF;
  SELECT cents, offset_day INTO v, v_offset_day
    FROM public.rakeback_closed_period_offsets
   WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000113'
     AND user_id = '20000000-0000-4000-8000-000000000020';
  IF v <> 1 THEN
    RAISE EXCEPTION 'historical low-cent paid delete offset is %, expected 1', v;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rakeback_closed_period_offsets
     WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000113'
       AND user_id <> '20000000-0000-4000-8000-000000000020'
  ) THEN
    RAISE EXCEPTION 'historical low-cent zero share received an offset';
  END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000018'
     AND user_id = '20000000-0000-4000-8000-000000000020'
     AND day = v_offset_day;
  IF v <> -1 THEN
    RAISE EXCEPTION 'historical low-cent open basis is %, expected -1', v;
  END IF;
  SELECT status INTO t FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000018'
     AND user_id = '20000000-0000-4000-8000-000000000020'
     AND period_start = '2026-08-31';
  IF t <> 'paid' THEN
    RAISE EXCEPTION 'historical low-cent paid source period was mutated';
  END IF;
END
$assert_historical_low_cent_paid_delete$;

-- A deal can change after the paid source week. Even when today's policy rate
-- resolves to zero, a negative offset is a receivable and needs a real pending
-- period so close can carry it forward rather than strand it in daily state.
INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, player_contributions,
  is_tournament, tournament_id, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000512',
  '10000000-0000-4000-8000-000000000017', -8.00,
  '2026-09-08 10:45:00+00', NULL,
  true, '60000000-0000-4000-8000-000000000017',
  'fn_unregister_from_tournament',
  '{"kind":"tournament_fee_refund","original_rake_record_id":"50000000-0000-4000-8000-000000000112","registration_id":"pre-cutover-paid-zero-rate-refund","user_id":"20000000-0000-4000-8000-000000000018"}'::jsonb,
  'DEALT_EQUAL'
);

DO $assert_zero_rate_refund_period_and_carry$
DECLARE
  v bigint;
  n numeric;
  r numeric;
  t text;
  v_period_id uuid;
  v_offset_start date;
BEGIN
  SELECT offset_period_start INTO v_offset_start
    FROM public.rakeback_closed_period_offsets
   WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000112'
     AND user_id = '20000000-0000-4000-8000-000000000018';
  SELECT id, rake_generated, rakeback_rate, status
    INTO v_period_id, n, r, t
    FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000017'
     AND user_id = '20000000-0000-4000-8000-000000000018'
     AND period_start = v_offset_start;
  IF v_period_id IS NULL OR n <> -8 OR r <> 0 OR t <> 'pending' THEN
    RAISE EXCEPTION
      'zero-rate refund period is id %, basis %, rate %, status %',
      v_period_id, n, r, t;
  END IF;
  PERFORM public.fn_close_settlement_period(v_period_id);
  SELECT status INTO t FROM public.rakeback_periods WHERE id = v_period_id;
  IF t <> 'paid' THEN RAISE EXCEPTION 'zero-rate negative period did not close'; END IF;
  SELECT cents INTO v FROM public.rakeback_period_carries
   WHERE from_period_id = v_period_id
     AND to_period_start = v_offset_start + 7;
  IF v <> 800 THEN RAISE EXCEPTION 'zero-rate refund carry is %, expected 800', v; END IF;
  SELECT rake_generated, rakeback_rate, status INTO n, r, t
    FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000017'
     AND user_id = '20000000-0000-4000-8000-000000000018'
     AND period_start = v_offset_start + 7;
  IF n <> -8 OR r <> 0 OR t <> 'pending' THEN
    RAISE EXCEPTION
      'zero-rate carried period is basis %, rate %, status %', n, r, t;
  END IF;
END
$assert_zero_rate_refund_period_and_carry$;

-- A future tournament can be bought in one week, have that week paid, and be
-- lawfully unregistered before the event in a later week.  The chip refund's
-- negative source row must commit.  Paid history stays byte-for-byte intact;
-- the exact basis moves to the first open period and, if still negative at
-- close, carries forward instead of disappearing.
INSERT INTO public.rake_records (
  id, table_id, club_id, rake_amount, created_at, player_contributions,
  is_tournament, tournament_id, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000501',
  '30000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000003', 5.00,
  '2026-09-08 10:00:00+00',
  '{"20000000-0000-4000-8000-000000000003":50}'::jsonb,
  true, '60000000-0000-4000-8000-000000000003',
  'fn_register_for_tournament',
  '{"kind":"tournament_fee","registration_id":"registration-paid-origin","user_id":"20000000-0000-4000-8000-000000000003"}'::jsonb,
  'DEALT_EQUAL'
);

UPDATE public.rakeback_periods
   SET status = 'paid', paid_at = '2026-09-14 00:00:00+00',
       rake_generated = 5.00, total_rake_paid = 5.00,
       rakeback_rate = 0.10, rakeback_earned = 0.50, rakeback_amount = 0.50
 WHERE club_id = '10000000-0000-4000-8000-000000000003'
   AND user_id = '20000000-0000-4000-8000-000000000003'
   AND period_start = '2026-09-07';

INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, player_contributions,
  is_tournament, tournament_id, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000502',
  '10000000-0000-4000-8000-000000000003', -5.00,
  '2026-09-08 11:00:00+00', NULL,
  true, '60000000-0000-4000-8000-000000000003',
  'fn_unregister_from_tournament',
  '{"kind":"tournament_fee_refund","registration_id":"registration-paid-origin","user_id":"20000000-0000-4000-8000-000000000003"}'::jsonb,
  'DEALT_EQUAL'
);

DO $assert_paid_origin_refund$
DECLARE
  v bigint;
  n numeric;
  t text;
  v_period_id uuid;
  v_offset_day date;
  v_offset_start date;
BEGIN
  SELECT count(*) INTO v FROM public.rake_records
   WHERE id = '50000000-0000-4000-8000-000000000502';
  IF v <> 1 THEN RAISE EXCEPTION 'paid-origin negative source did not commit'; END IF;
  SELECT count(*) INTO v FROM public.rakeback_compensation_links
   WHERE compensation_rake_record_id = '50000000-0000-4000-8000-000000000502'
     AND original_rake_record_id = '50000000-0000-4000-8000-000000000501'
     AND original_cents = 500;
  IF v <> 1 THEN RAISE EXCEPTION 'paid-origin refund has no exact original link'; END IF;
  SELECT cents, offset_day, offset_period_start
    INTO v, v_offset_day, v_offset_start
    FROM public.rakeback_closed_period_offsets
   WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000501'
     AND user_id = '20000000-0000-4000-8000-000000000003';
  IF v <> 500 THEN RAISE EXCEPTION 'paid-origin open-period offset is %, expected 500', v; END IF;
  SELECT rake_generated, status INTO n, t FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000003'
     AND user_id = '20000000-0000-4000-8000-000000000003'
     AND period_start = '2026-09-07';
  IF n <> 5 OR t <> 'paid' THEN
    RAISE EXCEPTION 'paid source period was mutated: basis %, status %', n, t;
  END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
     WHERE club_id = '10000000-0000-4000-8000-000000000003'
     AND user_id = '20000000-0000-4000-8000-000000000003'
     AND day = v_offset_day;
  IF v <> -500 THEN RAISE EXCEPTION 'current open basis is %, expected -500', v; END IF;

  SELECT id INTO STRICT v_period_id FROM public.rakeback_periods
     WHERE club_id = '10000000-0000-4000-8000-000000000003'
     AND user_id = '20000000-0000-4000-8000-000000000003'
     AND period_start = v_offset_start;
  PERFORM public.fn_close_settlement_period(v_period_id);
  SELECT status INTO t FROM public.rakeback_periods WHERE id = v_period_id;
  IF t <> 'paid' THEN RAISE EXCEPTION 'negative offset period did not close'; END IF;
  SELECT cents INTO v FROM public.rakeback_period_carries
   WHERE from_period_id = v_period_id
     AND to_period_start = v_offset_start + 7;
  IF v <> 500 THEN RAISE EXCEPTION 'negative basis carry is %, expected 500', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
     WHERE club_id = '10000000-0000-4000-8000-000000000003'
     AND user_id = '20000000-0000-4000-8000-000000000003'
     AND day = v_offset_start + 7;
  IF v <> -500 THEN RAISE EXCEPTION 'carried basis is %, expected -500', v; END IF;
END
$assert_paid_origin_refund$;

-- Fingerprints name an instant, not a session rendering of that instant.
-- Prove both the pure function and the real relink/delete/reinsert path across
-- UTC and America/Chicago sessions.
DO $assert_timezone_stable_fingerprint$
DECLARE
  f_utc text;
  f_chicago text;
BEGIN
  PERFORM set_config('TimeZone', 'UTC', false);
  f_utc := public.fn_rakeback_source_fingerprint(
    '50000000-0000-4000-8000-000000000601',
    '10000000-0000-4000-8000-000000000001', '2026-09-08', 100,
    'DEALT_EQUAL',
    '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
    NULL, '30000000-0000-4000-8000-000000000006', 900001, NULL, false,
    'timezone_probe', '2026-09-08 00:30:00+00'::timestamptz,
    '{"hand_number":900001}'::jsonb,
    '{"20000000-0000-4000-8000-000000000001":100}'::jsonb
  );
  PERFORM set_config('TimeZone', 'America/Chicago', false);
  f_chicago := public.fn_rakeback_source_fingerprint(
    '50000000-0000-4000-8000-000000000601',
    '10000000-0000-4000-8000-000000000001', '2026-09-08', 100,
    'DEALT_EQUAL',
    '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
    NULL, '30000000-0000-4000-8000-000000000006', 900001, NULL, false,
    'timezone_probe', '2026-09-07 19:30:00-05'::timestamptz,
    '{"hand_number":900001}'::jsonb,
    '{"20000000-0000-4000-8000-000000000001":100}'::jsonb
  );
  IF f_utc <> f_chicago THEN
    RAISE EXCEPTION 'the same instant fingerprints differently by TimeZone';
  END IF;
END
$assert_timezone_stable_fingerprint$;

SET TIME ZONE 'UTC';
INSERT INTO public.rake_records (
  id, hand_id, table_id, global_hand_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000601', NULL,
  '30000000-0000-4000-8000-000000000006',
  900001,
  '10000000-0000-4000-8000-000000000001', 1.00,
  '2026-09-08 00:30:00+00',
  '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
  'timezone_probe', '{"hand_number":900001}'::jsonb, 'DEALT_EQUAL'
);
SET TIME ZONE 'America/Chicago';
SELECT public.fn_relink_rake_record_to_hand(
  '30000000-0000-4000-8000-000000000006', 900001,
  '40000000-0000-4000-8000-000000000601'
);
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000601';
DO $assert_reversed_uuid_cannot_reappear$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.rakeback_source_relinks
     WHERE rake_record_id = '50000000-0000-4000-8000-000000000601'
       AND to_hand_id = '40000000-0000-4000-8000-000000000601'
  ) THEN
    RAISE EXCEPTION 'authorized cross-TimeZone relink has no receipt';
  END IF;
  BEGIN
    INSERT INTO public.rake_records (
      id, hand_id, table_id, club_id, rake_amount, created_at,
      player_contributions, source, metadata, rake_method
    ) VALUES (
      '50000000-0000-4000-8000-000000000601',
      '40000000-0000-4000-8000-000000000601',
      '30000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000001', 1.00,
      '2026-09-07 19:30:00-05',
      '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
      'timezone_probe', '{"hand_number":900001}'::jsonb, 'DEALT_EQUAL'
    );
    RAISE EXCEPTION 'PROBE_FAILED reversed UUID was reinserted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED reversed UUID was reinserted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%cannot be reinserted after its source was reversed%' THEN
      RAISE;
    END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.rake_records
     WHERE id = '50000000-0000-4000-8000-000000000601'
  ) THEN
    RAISE EXCEPTION 'rejected UUID replay escaped its subtransaction';
  END IF;
END
$assert_reversed_uuid_cannot_reappear$;
SET TIME ZONE 'UTC';

-- Both compatible source orders account for one hand exactly once.  If the
-- null-hand row wins first, the linked row appends an exact reversal and a
-- canonical accrual in the same transaction.  If linked wins first, the later
-- null row is recognized as the ghost before it touches basis.
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000701', NULL,
  '30000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000004', 1.23,
  '2026-09-08 12:00:00+00',
  '{"20000000-0000-4000-8000-000000000004":10}'::jsonb,
  'null_first', '{"hand_number":1000701}'::jsonb, 'DEALT_EQUAL'
);
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000702',
  '40000000-0000-4000-8000-000000000702',
  '30000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000004', 1.23,
  '2026-09-08 12:00:01+00',
  '{"20000000-0000-4000-8000-000000000004":10}'::jsonb,
  'linked_second', '{"hand_number":1000701}'::jsonb, 'DEALT_EQUAL'
);
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000703',
  '40000000-0000-4000-8000-000000000703',
  '30000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000004', 2.34,
  '2026-09-08 12:01:00+00',
  '{"20000000-0000-4000-8000-000000000004":10}'::jsonb,
  'linked_first', '{"hand_number":1000702}'::jsonb, 'DEALT_EQUAL'
);
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000704', NULL,
  '30000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000004', 2.34,
  '2026-09-08 12:01:01+00',
  '{"20000000-0000-4000-8000-000000000004":10}'::jsonb,
  'null_second', '{"hand_number":1000702}'::jsonb, 'DEALT_EQUAL'
);

DO $assert_ghost_order_independence$
DECLARE
  v bigint;
BEGIN
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000004'
     AND user_id = '20000000-0000-4000-8000-000000000004'
     AND day = '2026-09-08';
  IF v <> 357 THEN RAISE EXCEPTION 'ghost order basis is %, expected 357', v; END IF;
  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000004'
     AND day = '2026-09-08';
  IF v <> 2 THEN RAISE EXCEPTION 'ghost order witness is %, expected 2', v; END IF;
  SELECT count(*) INTO v FROM public.rakeback_source_supersessions
   WHERE ghost_rake_record_id = '50000000-0000-4000-8000-000000000701'
     AND canonical_rake_record_id = '50000000-0000-4000-8000-000000000702';
  IF v <> 1 THEN RAISE EXCEPTION 'null-first source has no canonical supersession'; END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000701'
     AND reason = 'superseded_ghost_twin' AND reversed_cents = 123;
  IF v <> 1 THEN RAISE EXCEPTION 'null-first source has no exact reversal'; END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000704';
  IF v <> 0 THEN RAISE EXCEPTION 'linked-first ghost received an accrual'; END IF;
END
$assert_ghost_order_independence$;

-- Every production refund writer reaches the same canonical compensation
-- door.  These are the exact rake_records shapes emitted by tournament
-- unregister, atomic cancellation, GameServer/tournamentRecovery cancellation,
-- spin cancellation, and the leave-seat DELETE path. Human fee sources arrive
-- without player_contributions; the audited BEFORE INSERT dependency must name
-- the user before this migration's AFTER INSERT accounting trigger runs.
INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, player_contributions,
  is_tournament, tournament_id, source, metadata, rake_method
) VALUES
  ('50000000-0000-4000-8000-000000000801',
   '10000000-0000-4000-8000-000000000005', 1.50,
   '2026-09-08 13:00:00+00',
   NULL,
   true, '60000000-0000-4000-8000-000000000005',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","user_id":"20000000-0000-4000-8000-000000000005","registration_id":"route-unregister"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000811',
   '10000000-0000-4000-8000-000000000006', 2.00,
   '2026-09-08 13:01:00+00',
   NULL,
   true, '60000000-0000-4000-8000-000000000006',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","user_id":"20000000-0000-4000-8000-000000000006"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000821',
   '10000000-0000-4000-8000-000000000007', 2.50,
   '2026-09-08 13:02:00+00',
   NULL,
   true, '60000000-0000-4000-8000-000000000007',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","user_id":"20000000-0000-4000-8000-000000000007"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000831',
   '10000000-0000-4000-8000-000000000008', 3.01,
   '2026-09-08 13:03:00+00',
   '{"20000000-0000-4000-8000-000000000008":10,"20000000-0000-4000-8000-000000000009":10}'::jsonb,
   true, '60000000-0000-4000-8000-000000000008',
   'fn_spin_book_entry', '{"kind":"spin_rake"}'::jsonb,
   'DEALT_EQUAL');

-- fn_unregister_from_tournament: registration-scoped negative fee row.
INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, is_tournament, tournament_id,
  source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000802',
  '10000000-0000-4000-8000-000000000005', -1.50,
  '2026-09-08 14:00:00+00', true,
  '60000000-0000-4000-8000-000000000005',
  'fn_unregister_from_tournament',
  '{"kind":"tournament_fee_refund","user_id":"20000000-0000-4000-8000-000000000005","registration_id":"route-unregister"}'::jsonb,
  'DEALT_EQUAL'
);
-- atomic_cancel_tournament: player-scoped aggregate fee reversal.
INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, is_tournament, tournament_id,
  source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000812',
  '10000000-0000-4000-8000-000000000006', -2.00,
  '2026-09-08 14:01:00+00', true,
  '60000000-0000-4000-8000-000000000006',
  'atomic_cancel_tournament',
  '{"kind":"tournament_fee_refund","user_id":"20000000-0000-4000-8000-000000000006"}'::jsonb,
  'DEALT_EQUAL'
);
-- tournamentRecovery/GameServer.cancel_refund emits the same user selector.
INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, is_tournament, tournament_id,
  source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000822',
  '10000000-0000-4000-8000-000000000007', -2.50,
  '2026-09-08 14:02:00+00', true,
  '60000000-0000-4000-8000-000000000007',
  'GameServer.cancel_refund',
  '{"kind":"tournament_fee_refund","user_id":"20000000-0000-4000-8000-000000000007"}'::jsonb,
  'DEALT_EQUAL'
);
-- Spin cancellation names the exact aggregate original and keeps its shares.
INSERT INTO public.rake_records (
  id, club_id, rake_amount, created_at, player_contributions,
  is_tournament, tournament_id, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000832',
  '10000000-0000-4000-8000-000000000008', -3.01,
  '2026-09-08 14:03:00+00',
  '{"20000000-0000-4000-8000-000000000008":10,"20000000-0000-4000-8000-000000000009":10}'::jsonb,
  true, '60000000-0000-4000-8000-000000000008',
  'atomic_cancel_tournament',
  '{"kind":"spin_rake_refund","original_source":"fn_spin_book_entry","original_rake_record_id":"50000000-0000-4000-8000-000000000831"}'::jsonb,
  'DEALT_EQUAL'
);

-- fn_leave_seat_and_refund removes its exact positive reservation source.
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000841',
  '40000000-0000-4000-8000-000000000841',
  '30000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000009', 0.75,
  '2026-09-08 13:04:00+00',
  '{"20000000-0000-4000-8000-000000000010":10}'::jsonb,
  'fn_join_table_reservation', '{"kind":"seat_reservation"}'::jsonb,
  'DEALT_EQUAL'
);
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000841';

DO $assert_refund_route_parity$
DECLARE
  v bigint;
BEGIN
  SELECT count(*) INTO v FROM public.rakeback_accrual_receipts
   WHERE (rake_record_id, user_id) IN (
     ('50000000-0000-4000-8000-000000000801'::uuid,
      '20000000-0000-4000-8000-000000000005'::uuid),
     ('50000000-0000-4000-8000-000000000811'::uuid,
      '20000000-0000-4000-8000-000000000006'::uuid),
     ('50000000-0000-4000-8000-000000000821'::uuid,
      '20000000-0000-4000-8000-000000000007'::uuid)
   );
  IF v <> 3 THEN
    RAISE EXCEPTION 'tournament attribution dependency named only % of 3 fee sources', v;
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_compensation_records
   WHERE rake_record_id IN (
     '50000000-0000-4000-8000-000000000802',
     '50000000-0000-4000-8000-000000000812',
     '50000000-0000-4000-8000-000000000822',
     '50000000-0000-4000-8000-000000000832'
   ) AND applied_to_basis AND linked_cents = compensation_cents;
  IF v <> 4 THEN RAISE EXCEPTION 'only % of 4 negative refund routes balanced', v; END IF;
  SELECT count(*) INTO v FROM public.rakeback_compensation_links
   WHERE compensation_rake_record_id IN (
     '50000000-0000-4000-8000-000000000802',
     '50000000-0000-4000-8000-000000000812',
     '50000000-0000-4000-8000-000000000822',
     '50000000-0000-4000-8000-000000000832'
   );
  IF v <> 4 THEN RAISE EXCEPTION 'refund routes produced % exact links, expected 4', v; END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_reversals
   WHERE rake_record_id IN (
     '50000000-0000-4000-8000-000000000801',
     '50000000-0000-4000-8000-000000000811',
     '50000000-0000-4000-8000-000000000821',
     '50000000-0000-4000-8000-000000000831'
   ) AND reason = 'negative_source_compensation';
  IF v <> 4 THEN RAISE EXCEPTION 'refund routes produced % original reversals', v; END IF;
  IF EXISTS (
    SELECT 1 FROM public.rakeback_daily_user d
     WHERE d.club_id IN (
       '10000000-0000-4000-8000-000000000005',
       '10000000-0000-4000-8000-000000000006',
       '10000000-0000-4000-8000-000000000007',
       '10000000-0000-4000-8000-000000000008',
       '10000000-0000-4000-8000-000000000009'
     ) AND d.cents <> 0
  ) THEN
    RAISE EXCEPTION 'a refund route left rakeback basis behind';
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000841'
     AND reason = 'source_record_deleted' AND reversed_cents = 75;
  IF v <> 1 THEN RAISE EXCEPTION 'leave-seat DELETE has no exact reversal'; END IF;
END
$assert_refund_route_parity$;

-- Seed the two-session serialization probes run after this file.  One source
-- races its period close with a second accrual; another races close with its
-- exact DELETE reversal.
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES
  ('50000000-0000-4000-8000-000000000901',
   '40000000-0000-4000-8000-000000000901',
   '30000000-0000-4000-8000-000000000009',
   '10000000-0000-4000-8000-000000000010', 1.00,
   '2026-09-08 15:00:00+00',
   '{"20000000-0000-4000-8000-000000000011":10}'::jsonb,
   'close_accrual_seed', '{"hand_number":900901}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000911',
   '40000000-0000-4000-8000-000000000911',
   '30000000-0000-4000-8000-000000000009',
   '10000000-0000-4000-8000-000000000011', 1.00,
   '2026-09-08 15:01:00+00',
   '{"20000000-0000-4000-8000-000000000012":10}'::jsonb,
   'close_reversal_seed', '{"hand_number":900911}'::jsonb, 'DEALT_EQUAL');

-- The source door is deliberately bounded by the number of players in this
-- record, not by the size of rake_records or the age of the week. Exercise 250
-- sequential records against one hot period row, then roll the fixture back.
DO $bounded_cost$
DECLARE
  started timestamptz := clock_timestamp();
  elapsed_ms numeric := 0;
BEGIN
  BEGIN
    INSERT INTO public.rake_records (
      id, hand_id, table_id, club_id, rake_amount, created_at,
      player_contributions, source, metadata, rake_method
    )
    SELECT gen_random_uuid(), gen_random_uuid(),
           '30000000-0000-4000-8000-000000000002'::uuid,
           '10000000-0000-4000-8000-000000000002'::uuid,
           1.00, '2026-09-08 08:00:00+00'::timestamptz + g * interval '1 millisecond',
           '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
           'bounded_cost_probe', jsonb_build_object('hand_number', 2000000 + g),
           'DEALT_EQUAL'
      FROM generate_series(1, 250) g;
    elapsed_ms := extract(epoch FROM (clock_timestamp() - started)) * 1000;
    RAISE EXCEPTION 'ROLLBACK_BOUNDED_COST';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_BOUNDED_COST' THEN RAISE; END IF;
  END;
  IF elapsed_ms > 5000 THEN
    RAISE EXCEPTION '250 source accruals took % ms, expected at most 5000', elapsed_ms;
  END IF;
  IF EXISTS (SELECT 1 FROM public.rake_records WHERE source = 'bounded_cost_probe') THEN
    RAISE EXCEPTION 'bounded-cost fixture escaped its subtransaction';
  END IF;
  RAISE NOTICE '250 source accruals including exact receipts and projections: % ms',
    round(elapsed_ms, 3);
END
$bounded_cost$;

DO $assert_refusals$
BEGIN
  BEGIN
    INSERT INTO public.rake_records (
      id, hand_id, table_id, club_id, rake_amount, created_at,
      player_contributions, source, metadata, rake_method
    ) VALUES (
      '50000000-0000-4000-8000-000000000301',
      '40000000-0000-4000-8000-000000000301',
      '30000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000002', 1.00,
      '2026-09-08 07:00:00+00', '{"not-a-user":"bad"}'::jsonb,
      'invalid_probe', '{"hand_number":1000301}'::jsonb, 'DEALT_EQUAL'
    );
    RAISE EXCEPTION 'PROBE_FAILED invalid attribution committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED invalid attribution committed' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%allocated % cents across % shares%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.rake_records
              WHERE id = '50000000-0000-4000-8000-000000000301') THEN
    RAISE EXCEPTION 'invalid source row survived its refused accrual';
  END IF;

  UPDATE public.rakeback_periods SET status = 'paid'
   WHERE club_id = '10000000-0000-4000-8000-000000000001'
     AND user_id = '20000000-0000-4000-8000-000000000001'
     AND period_start = '2026-09-07';
  BEGIN
    INSERT INTO public.rake_records (
      id, hand_id, table_id, club_id, rake_amount, created_at,
      player_contributions, source, metadata, rake_method
    ) VALUES (
      '50000000-0000-4000-8000-000000000302',
      '40000000-0000-4000-8000-000000000302',
      '30000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001', 1.00,
      '2026-09-08 07:01:00+00',
      '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
      'closed_probe', '{"hand_number":1000302}'::jsonb, 'DEALT_EQUAL'
    );
    RAISE EXCEPTION 'PROBE_FAILED closed-period source committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PROBE_FAILED closed-period source committed' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%immutable closed rakeback period%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.rake_records
              WHERE id = '50000000-0000-4000-8000-000000000302') THEN
    RAISE EXCEPTION 'closed-period source row survived its refused accrual';
  END IF;
END
$assert_refusals$;

DO $assert_contract$
DECLARE
  body text;
BEGIN
  SELECT prosrc INTO body FROM pg_proc
   WHERE oid = 'public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure;
  IF body ~ 'rake_records|DELETE[[:space:]]+FROM[[:space:]]+public.rakeback_daily_user' THEN
    RAISE EXCEPTION 'compatibility day RPC still scans/rebuilds source';
  END IF;
  SELECT prosrc INTO body FROM pg_proc
   WHERE oid = 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure;
  IF body ~ 'rake_records' THEN
    RAISE EXCEPTION 'compatibility period RPC still scans the source ledger';
  END IF;
  IF has_function_privilege(
       'service_role', 'public.fn_rakeback_accrue_source_record()', 'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.fn_rakeback_reverse_deleted_source_record()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service role can call a trigger-only mutation function';
  END IF;
  IF NOT (
    SELECT relrowsecurity FROM pg_class
     WHERE oid = 'public.rakeback_accrual_records'::regclass
  ) THEN
    RAISE EXCEPTION 'accrual history does not enforce RLS';
  END IF;
  IF NOT has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'SELECT'
     ) OR has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'INSERT'
     ) OR has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'UPDATE'
     ) OR has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'DELETE'
     ) OR has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'TRUNCATE'
     ) OR has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'REFERENCES'
     ) OR has_table_privilege(
       'authenticated', 'public.rakeback_periods', 'TRIGGER'
     ) OR EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = 'public.rakeback_periods'::regclass
          AND p.polname = 'rakeback_periods_update_own'
     ) THEN
    RAISE EXCEPTION 'browser still has a direct rakeback period mutation door';
  END IF;
END
$assert_contract$;

SELECT 'RAKEBACK_SOURCE_ACCRUAL_ASSERTIONS_OK' AS result;
