\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL timezone = 'UTC';

DO $receipts_balance$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM public.rakeback_accrual_records h
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, COALESCE(sum(r.cents), 0) AS cents
        FROM public.rakeback_accrual_receipts r
       WHERE r.rake_record_id = h.rake_record_id
    ) x ON true
   WHERE x.n <> h.share_count OR x.cents <> h.allocated_cents;
  IF bad <> 0 THEN RAISE EXCEPTION '% accrual headers do not balance to their lines', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_accrual_reversals h
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, COALESCE(sum(r.cents), 0) AS cents
        FROM public.rakeback_accrual_reversal_receipts r
       WHERE r.rake_record_id = h.rake_record_id
    ) x ON true
   WHERE x.n <> h.share_count OR x.cents <> h.reversed_cents;
  IF bad <> 0 THEN RAISE EXCEPTION '% reversal headers do not balance to their lines', bad; END IF;
END
$receipts_balance$;

DO $daily_basis_balance$
DECLARE
  bad bigint;
BEGIN
  WITH movements AS (
    SELECT club_id, day, user_id, cents
      FROM public.rakeback_cutover_daily_user
    UNION ALL
    SELECT r.club_id, r.day, r.user_id, r.cents
      FROM public.rakeback_accrual_receipts r
      JOIN public.rakeback_accrual_records h USING (rake_record_id)
     WHERE h.basis_origin = 'source_transaction'
    UNION ALL
    SELECT r.club_id, r.day, r.user_id, -r.cents
      FROM public.rakeback_accrual_reversal_receipts r
      JOIN public.rakeback_accrual_reversals h USING (rake_record_id)
      LEFT JOIN public.rakeback_compensation_records c
        ON c.rake_record_id = h.compensation_rake_record_id
     WHERE h.applied_to_basis
       AND NOT EXISTS (
         SELECT 1 FROM public.rakeback_closed_period_offsets o
          WHERE o.original_rake_record_id = r.rake_record_id
            AND o.user_id = r.user_id
       )
       -- Historical negative rows were already netted into the locked cutover
       -- snapshot. Runtime/direct reversals were not.
       AND NOT (h.reason = 'negative_source_compensation'
                AND c.basis_origin = 'cutover')
    UNION ALL
    SELECT o.club_id, o.offset_day, o.user_id, -o.cents
      FROM public.rakeback_closed_period_offsets o
    UNION ALL
    SELECT c.club_id, c.to_day, c.user_id, -c.cents
      FROM public.rakeback_period_carries c
  ), expected AS (
    SELECT club_id, day, user_id, sum(cents)::bigint AS cents
      FROM movements GROUP BY club_id, day, user_id
  ), compared AS (
    SELECT COALESCE(e.club_id, d.club_id) AS club_id,
           COALESCE(e.day, d.day) AS day,
           COALESCE(e.user_id, d.user_id) AS user_id,
           COALESCE(e.cents, 0) AS expected_cents,
           COALESCE(d.cents, 0) AS actual_cents
      FROM expected e
      FULL JOIN (
        SELECT d.* FROM public.rakeback_daily_user d
         WHERE d.day >= (
           SELECT basis_from_day FROM public.rakeback_basis_epoch WHERE singleton
         )
      ) d
        ON d.club_id = e.club_id AND d.day = e.day AND d.user_id = e.user_id
  )
  SELECT count(*) INTO bad FROM compared WHERE expected_cents <> actual_cents;
  IF bad <> 0 THEN RAISE EXCEPTION '% daily player balances differ from immutable movements', bad; END IF;

  WITH movements AS (
    SELECT club_id, day, rows_seen AS records
      FROM public.rakeback_cutover_daily_state
    UNION ALL
    SELECT club_id, day, 1::bigint
      FROM public.rakeback_accrual_records
     WHERE basis_origin = 'source_transaction'
    UNION ALL
    SELECT a.club_id, a.day, (-1)::bigint
     FROM public.rakeback_accrual_reversals r
      JOIN public.rakeback_accrual_records a USING (rake_record_id)
     WHERE r.applied_to_basis
       AND a.basis_origin <> 'historical_source_evidence'
       AND NOT EXISTS (
         SELECT 1 FROM public.rakeback_compensation_records c
          WHERE c.rake_record_id = r.compensation_rake_record_id
            AND c.basis_origin = 'cutover'
       )
  ), expected AS (
    SELECT club_id, day, sum(records)::bigint AS rows_seen
      FROM movements GROUP BY club_id, day
  )
  SELECT count(*) INTO bad
    FROM expected e
    FULL JOIN (
      SELECT d.* FROM public.rakeback_daily_state d
       WHERE d.day >= (
         SELECT basis_from_day FROM public.rakeback_basis_epoch WHERE singleton
       )
    ) d USING (club_id, day)
   WHERE COALESCE(e.rows_seen, 0) <> COALESCE(d.rows_seen, 0);
  IF bad <> 0 THEN RAISE EXCEPTION '% daily witnesses differ from immutable movements', bad; END IF;
END
$daily_basis_balance$;

DO $doors_are_armed$
DECLARE
  bad bigint;
  body text;
BEGIN
  SELECT count(*) INTO bad FROM pg_trigger
   WHERE tgrelid = 'public.rake_records'::regclass
     AND tgname IN (
       'trg_rakeback_accrues_with_rake_record',
       'trg_rakeback_compensates_with_negative_record',
       'trg_rakeback_accrues_with_first_attribution',
       'trg_rakeback_records_one_authorized_hand_relink',
       'trg_rakeback_source_basis_is_immutable',
       'trg_rakeback_source_delete_is_reversed'
     )
     AND tgenabled = 'O';
  IF bad <> 6 THEN RAISE EXCEPTION 'only % of 6 rakeback source triggers are armed', bad; END IF;

  SELECT prosrc INTO body FROM pg_proc
   WHERE oid = 'public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure;
  IF body ~ 'rake_records' THEN RAISE EXCEPTION 'day compatibility RPC reads rake_records'; END IF;
  SELECT prosrc INTO body FROM pg_proc
   WHERE oid = 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure;
  IF body ~ 'rake_records' THEN RAISE EXCEPTION 'period compatibility RPC reads rake_records'; END IF;

  IF has_function_privilege(
       'service_role', 'public.fn_rakeback_accrue_source_record()', 'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.fn_rakeback_compensate_source_record()', 'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.fn_rakeback_reverse_deleted_source_record()', 'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.fn_rakeback_record_hand_relink()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service_role can invoke a trigger-only mutation function';
  END IF;
  IF has_table_privilege('service_role', 'public.rakeback_daily_user', 'INSERT')
     OR has_table_privilege('service_role', 'public.rakeback_daily_user', 'UPDATE')
     OR has_table_privilege('service_role', 'public.rakeback_daily_state', 'INSERT')
     OR has_table_privilege('service_role', 'public.rakeback_daily_state', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can directly mutate the atomic daily basis';
  END IF;
  IF has_table_privilege('anon', 'public.rakeback_periods', 'INSERT')
     OR has_table_privilege('anon', 'public.rakeback_periods', 'UPDATE')
     OR has_table_privilege('anon', 'public.rakeback_periods', 'DELETE')
     OR has_table_privilege('authenticated', 'public.rakeback_periods', 'INSERT')
     OR has_table_privilege('authenticated', 'public.rakeback_periods', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.rakeback_periods', 'DELETE')
     OR has_table_privilege('authenticated', 'public.rakeback_periods', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.rakeback_periods', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.rakeback_periods', 'TRIGGER')
     OR EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = 'public.rakeback_periods'::regclass
          AND p.polname = 'rakeback_periods_update_own'
  ) THEN
    RAISE EXCEPTION 'browser still has a direct rakeback period mutation door';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM public.rakeback_periods p
        WHERE p.status = 'pending'
          AND p.period_end IS DISTINCT FROM p.period_start + 6
     ) OR EXISTS (
       SELECT 1
         FROM public.rakeback_periods p
        WHERE p.status = 'pending'
        GROUP BY p.user_id, p.club_id, p.period_start
       HAVING count(*) <> 1
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_index i
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
$doors_are_armed$;

DO $ledger_security$
DECLARE
  table_name text;
  trigger_name text;
  protected_tables text[][] := ARRAY[
    ARRAY['rakeback_basis_epoch', 'trg_rakeback_epoch_is_immutable'],
    ARRAY['rakeback_cutover_daily_user', 'trg_rakeback_cutover_user_is_immutable'],
    ARRAY['rakeback_cutover_daily_state', 'trg_rakeback_cutover_state_is_immutable'],
    ARRAY['rakeback_cutover_source_records', 'trg_rakeback_cutover_source_is_immutable'],
    ARRAY['rakeback_accrual_records', 'trg_rakeback_accrual_record_is_immutable'],
    ARRAY['rakeback_accrual_receipts', 'trg_rakeback_accrual_receipt_is_immutable'],
    ARRAY['rakeback_accrual_reversals', 'trg_rakeback_accrual_reversal_is_immutable'],
    ARRAY['rakeback_accrual_reversal_receipts', 'trg_rakeback_accrual_reversal_receipt_is_immutable'],
    ARRAY['rakeback_compensation_records', 'trg_rakeback_compensation_record_is_immutable'],
    ARRAY['rakeback_compensation_links', 'trg_rakeback_compensation_link_is_immutable'],
    ARRAY['rakeback_closed_period_offsets', 'trg_rakeback_closed_period_offset_is_immutable'],
    ARRAY['rakeback_period_carries', 'trg_rakeback_period_carry_is_immutable'],
    ARRAY['rakeback_source_relinks', 'trg_rakeback_source_relink_is_immutable'],
    ARRAY['rakeback_source_supersessions', 'trg_rakeback_source_supersession_is_immutable']
  ];
  item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY protected_tables LOOP
    table_name := item[1];
    trigger_name := item[2];
    IF NOT (SELECT c.relrowsecurity FROM pg_class c
             WHERE c.oid = ('public.' || table_name)::regclass) THEN
      RAISE EXCEPTION '% does not enforce RLS', table_name;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || table_name, 'SELECT')
       OR has_table_privilege('service_role', 'public.' || table_name, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || table_name, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || table_name, 'DELETE')
       OR has_table_privilege('anon', 'public.' || table_name, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || table_name, 'SELECT') THEN
      RAISE EXCEPTION '% does not have the audited read-only ACL', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = ('public.' || table_name)::regclass
         AND t.tgname = trigger_name
         AND t.tgenabled = 'O'
         AND NOT t.tgisinternal
         AND p.proname = 'fn_rakeback_receipt_is_immutable'
    ) THEN
      RAISE EXCEPTION '% has no enabled immutability trigger', table_name;
    END IF;
  END LOOP;
END
$ledger_security$;

DO $compensation_integrity$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM public.rakeback_compensation_records c
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS n,
             COALESCE(sum(l.original_cents), 0)::bigint AS cents
        FROM public.rakeback_compensation_links l
       WHERE l.compensation_rake_record_id = c.rake_record_id
    ) x ON true
   WHERE x.n <> c.linked_original_count OR x.cents <> c.linked_cents;
  IF bad <> 0 THEN
    RAISE EXCEPTION '% compensation headers do not balance to exact links', bad;
  END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_compensation_links l
    JOIN public.rakeback_accrual_records a
      ON a.rake_record_id = l.original_rake_record_id
    LEFT JOIN public.rakeback_accrual_reversals r
      ON r.rake_record_id = l.original_rake_record_id
   WHERE l.original_cents <> a.source_rake_cents
      OR r.rake_record_id IS NULL
      OR r.reason <> 'negative_source_compensation'
      OR r.compensation_rake_record_id <> l.compensation_rake_record_id
      OR r.reversed_cents <> l.original_cents;
  IF bad <> 0 THEN
    RAISE EXCEPTION '% compensation links do not have matching original reversals', bad;
  END IF;

  SELECT count(*) INTO bad
    FROM public.rake_records n
    LEFT JOIN public.rakeback_compensation_records c
      ON c.rake_record_id = n.id
   WHERE n.rake_amount < 0
     AND round(abs(n.rake_amount) * 100)::bigint > 0
     AND c.rake_record_id IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '% negative source rows lack compensation receipts', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_compensation_records c
    LEFT JOIN public.rake_records n ON n.id = c.rake_record_id
   WHERE n.id IS NULL OR n.rake_amount >= 0;
  IF bad <> 0 THEN RAISE EXCEPTION '% compensation receipts lost their immutable negative source', bad; END IF;
END
$compensation_integrity$;

DO $offset_carry_and_supersession_integrity$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM public.rakeback_closed_period_offsets o
    JOIN public.rakeback_accrual_reversal_receipts r
      ON r.rake_record_id = o.original_rake_record_id
     AND r.user_id = o.user_id
    JOIN public.rakeback_accrual_reversals h
      ON h.rake_record_id = o.original_rake_record_id
    JOIN public.rakeback_periods p ON p.id = o.source_period_id
   WHERE o.cents <> r.cents
      OR o.reason <> h.reason
      OR o.compensation_rake_record_id IS DISTINCT FROM h.compensation_rake_record_id
      OR p.status = 'pending';
  IF bad <> 0 THEN RAISE EXCEPTION '% closed-period offsets differ from source lines', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_period_carries c
    JOIN public.rakeback_periods p ON p.id = c.from_period_id
   WHERE p.status = 'pending'
      OR p.club_id <> c.club_id
      OR p.user_id <> c.user_id
      OR p.period_start <> c.from_period_start
      OR p.period_end <> c.from_period_end;
  IF bad <> 0 THEN RAISE EXCEPTION '% negative carries differ from their closed period', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_source_supersessions s
    JOIN public.rakeback_accrual_records g
      ON g.rake_record_id = s.ghost_rake_record_id
    JOIN public.rakeback_accrual_records c
      ON c.rake_record_id = s.canonical_rake_record_id
    LEFT JOIN public.rakeback_accrual_reversals r
      ON r.rake_record_id = s.ghost_rake_record_id
   WHERE g.source_fingerprint <> s.ghost_fingerprint
      OR c.source_fingerprint <> s.canonical_fingerprint
      OR g.source_rake_cents <> s.rake_cents
      OR c.source_rake_cents <> s.rake_cents
      OR r.reason <> 'superseded_ghost_twin'
      OR r.reversed_cents <> s.rake_cents;
  IF bad <> 0 THEN RAISE EXCEPTION '% ghost supersessions do not conserve one source', bad; END IF;
END
$offset_carry_and_supersession_integrity$;

DO $source_coverage$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM public.rake_records r
    CROSS JOIN public.rakeback_basis_epoch e
    LEFT JOIN public.rakeback_cutover_source_records c
      ON c.rake_record_id = r.id
    LEFT JOIN public.rakeback_accrual_records a ON a.rake_record_id = r.id
   WHERE e.singleton
     AND (r.created_at AT TIME ZONE 'UTC')::date >= e.basis_from_day
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.player_contributions <> '{}'::jsonb
     AND NOT CASE
       WHEN r.hand_id IS NULL
        AND r.table_id IS NOT NULL
        AND COALESCE(r.metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
        AND (r.metadata->>'hand_number')::bigint >= 1000000
       THEN public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
       ELSE false
     END
     AND c.rake_record_id IS NULL
     AND a.rake_record_id IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '% non-cutover atomic-epoch sources have no accrual receipt', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_accrual_records a
    LEFT JOIN public.rake_records r ON r.id = a.rake_record_id
    LEFT JOIN public.rakeback_accrual_reversals x USING (rake_record_id)
   WHERE a.basis_origin = 'source_transaction'
     AND r.id IS NULL
     AND x.rake_record_id IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '% accrued sources vanished without a reversal', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.rakeback_accrual_reversals x
    JOIN public.rake_records r ON r.id = x.rake_record_id
   WHERE x.reason IN (
     'source_record_deleted',
     'source_deleted_before_basis_epoch_no_balance_change'
   );
  IF bad <> 0 THEN RAISE EXCEPTION '% deletion reversals still have a source row', bad; END IF;
END
$source_coverage$;

SELECT jsonb_build_object(
  'contract', 'smarter-poker.rakeback-source-accrual.v1',
  'epoch', (SELECT to_jsonb(e) FROM public.rakeback_basis_epoch e WHERE singleton),
  'accruals', (SELECT count(*) FROM public.rakeback_accrual_records),
  'accrual_cents', (SELECT COALESCE(sum(allocated_cents), 0) FROM public.rakeback_accrual_records),
  'reversals', (SELECT count(*) FROM public.rakeback_accrual_reversals),
  'reversal_cents', (SELECT COALESCE(sum(reversed_cents), 0) FROM public.rakeback_accrual_reversals)
) AS rakeback_source_accrual_status;

ROLLBACK;
