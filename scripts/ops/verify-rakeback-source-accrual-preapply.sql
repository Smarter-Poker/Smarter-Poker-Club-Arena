\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- PostgreSQL permits DML against session-temporary tables inside a read-only
-- transaction, but it forbids CREATE TABLE AS there. Create empty scratch
-- relations before the audited snapshot; every population and invariant below
-- still executes in the one repeatable-read, read-only transaction.
CREATE TEMP TABLE rakeback_cutover_basis (
  day date NOT NULL
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE rakeback_cutover_compensation_links (
  compensation_rake_record_id uuid NOT NULL,
  original_rake_record_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (compensation_rake_record_id, original_rake_record_id)
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE rakeback_cutover_unapplied_compensations (
  compensation_rake_record_id uuid PRIMARY KEY,
  reason text NOT NULL
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE rakeback_cutover_expected_daily_user (
  club_id uuid NOT NULL,
  day date NOT NULL,
  user_id uuid NOT NULL,
  cents bigint NOT NULL
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE rakeback_cutover_counts (
  club_id uuid NOT NULL,
  day date NOT NULL,
  exact_rows bigint NOT NULL,
  source_cents bigint NOT NULL
) ON COMMIT PRESERVE ROWS;

BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SET LOCAL lock_timeout = '10s';
SET LOCAL timezone = 'UTC';

DO $dependency_preconditions$
DECLARE
  v_bad text := '';
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure
     )) <> 'b00b5d017cb5a3699038e1bb8896b5d6' THEN
    v_bad := v_bad || ' fn_rakeback_recompute_day';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure
     )) <> '2078fb6e89f22704096974ecf933e385' THEN
    v_bad := v_bad || ' fn_rakeback_recompute_periods';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_allocate_rake_credits(numeric,jsonb,text)'::regprocedure
     )) <> '74d61a3e0caf1037f6e6633eff0dd611' THEN
    v_bad := v_bad || ' fn_allocate_rake_credits';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_player_rakeback_rate(uuid,uuid,numeric)'::regprocedure
     )) <> 'f9b2424384371f47f9fba2006a3f646d' THEN
    v_bad := v_bad || ' fn_player_rakeback_rate';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_rake_record_is_ghost_twin(uuid,uuid,jsonb)'::regprocedure
     )) <> 'd59ea94ab309a36c5d5a1298cbc604d3' THEN
    v_bad := v_bad || ' fn_rake_record_is_ghost_twin';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_tournament_fee_names_its_player()'::regprocedure
     )) <> 'a34e26b81ceeda38237b739245ff11f6' THEN
    v_bad := v_bad || ' fn_tournament_fee_names_its_player';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.rake_records'::regclass
       AND t.tgname = 'trg_tournament_fee_names_its_player'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
       AND md5(pg_get_triggerdef(t.oid)) = 'b78ca0d8726cc7fce4d66ef6c2030027'
  ) THEN
    v_bad := v_bad || ' trg_tournament_fee_names_its_player';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_close_settlement_period(uuid)'::regprocedure
     )) <> '0af831a32835021d60f7098e07ce4ad5' THEN
    v_bad := v_bad || ' fn_close_settlement_period';
  END IF;
  IF md5(pg_get_functiondef(
       'public.fn_relink_rake_record_to_hand(uuid,bigint,uuid)'::regprocedure
     )) <> '708827dbc7fabd0b753d3a7b8596f076' THEN
    v_bad := v_bad || ' fn_relink_rake_record_to_hand';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('public.rakeback_daily_user_club_user_day_idx')
       AND indisvalid AND indisready
  ) THEN
    v_bad := v_bad || ' rakeback_daily_user_club_user_day_idx';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.rakeback_periods'::regclass
       AND c.conname =
           'rakeback_periods_user_id_club_id_period_start_period_end_key'
       AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) =
           'UNIQUE (user_id, club_id, period_start, period_end)'
  ) THEN
    v_bad := v_bad || ' rakeback_periods legacy four-column unique';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION
      'rakeback accrual dependencies changed after the 2026-09-08 audit:%',
      v_bad;
  END IF;
END
$dependency_preconditions$;

DO $pristine_release_state$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM supabase_migrations.schema_migrations
   WHERE name = 'rakeback_accrues_atomically_with_its_source';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'rakeback source-accrual migration name is not pristine: % rows', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM unnest(ARRAY[
      'public.rakeback_basis_epoch',
      'public.rakeback_cutover_daily_user',
      'public.rakeback_cutover_daily_state',
      'public.rakeback_cutover_source_records',
      'public.rakeback_accrual_records',
      'public.rakeback_accrual_receipts',
      'public.rakeback_accrual_reversals',
      'public.rakeback_accrual_reversal_receipts',
      'public.rakeback_compensation_records',
      'public.rakeback_compensation_links',
      'public.rakeback_closed_period_offsets',
      'public.rakeback_period_carries',
      'public.rakeback_source_relinks',
      'public.rakeback_source_supersessions'
    ]::text[]) AS expected(relation_name)
   WHERE to_regclass(expected.relation_name) IS NOT NULL;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'rakeback source-accrual objects exist without a ledger receipt: % sentinel tables',
      v_bad;
  END IF;

  IF to_regclass('public.rakeback_periods_one_pending_user_club_week_idx') IS NOT NULL THEN
    RAISE EXCEPTION
      'rakeback pending-period identity index exists without a ledger receipt';
  END IF;

  SELECT count(*) INTO v_bad
    FROM unnest(ARRAY[
      'public.fn_rakeback_lock_period_keys(uuid,date,date,uuid[])',
      'public.fn_rakeback_lock_period_id(uuid)',
      'public.fn_rakeback_resolve_open_period(uuid,uuid,date)',
      'public.fn_rakeback_carry_negative_period(uuid,uuid,uuid,date,date,numeric)',
      'public.fn_rakeback_source_fingerprint(uuid,uuid,date,bigint,text,jsonb,uuid,uuid,bigint,uuid,boolean,text,timestamp with time zone,jsonb,jsonb)',
      'public.fn_rakeback_materialize_cutover_record(uuid)',
      'public.fn_rakeback_apply_reversal_basis(uuid,uuid,date,text,boolean)',
      'public.fn_rakeback_supersede_ghost_source(uuid,uuid,date)',
      'public.fn_rakeback_accrue_source_record()',
      'public.fn_rakeback_compensate_source_record()',
      'public.fn_rakeback_reverse_deleted_source_record()',
      'public.fn_rakeback_source_basis_is_immutable()',
      'public.fn_rakeback_record_hand_relink()',
      'public.fn_rakeback_receipt_is_immutable()'
    ]::text[]) AS expected(function_signature)
   WHERE to_regprocedure(expected.function_signature) IS NOT NULL;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'rakeback source-accrual functions exist without a ledger receipt: %', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgname = ANY(ARRAY[
       'trg_rakeback_accrues_with_rake_record',
       'trg_rakeback_compensates_with_negative_record',
       'trg_rakeback_accrues_with_first_attribution',
       'trg_rakeback_records_one_authorized_hand_relink',
       'trg_rakeback_source_basis_is_immutable',
       'trg_rakeback_source_delete_is_reversed',
       'trg_rakeback_epoch_is_immutable',
       'trg_rakeback_cutover_user_is_immutable',
       'trg_rakeback_cutover_state_is_immutable',
       'trg_rakeback_cutover_source_is_immutable',
       'trg_rakeback_accrual_record_is_immutable',
       'trg_rakeback_accrual_receipt_is_immutable',
       'trg_rakeback_accrual_reversal_is_immutable',
       'trg_rakeback_accrual_reversal_receipt_is_immutable',
       'trg_rakeback_compensation_record_is_immutable',
       'trg_rakeback_compensation_link_is_immutable',
       'trg_rakeback_closed_period_offset_is_immutable',
       'trg_rakeback_period_carry_is_immutable',
       'trg_rakeback_source_relink_is_immutable',
       'trg_rakeback_source_supersession_is_immutable'
     ]::text[]);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'rakeback source-accrual triggers exist without a ledger receipt: %', v_bad;
  END IF;
END
$pristine_release_state$;

DO $no_conflicting_writers$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(DISTINCT l.pid) INTO v_bad
    FROM pg_locks l
   WHERE l.pid <> pg_backend_pid()
     AND l.granted
     AND l.relation IN (
       'public.rake_records'::regclass,
       'public.rakeback_daily_user'::regclass,
       'public.rakeback_daily_state'::regclass,
       'public.rakeback_periods'::regclass,
       'public.rakeback_period_payouts'::regclass
     )
     AND l.mode IN (
       'RowExclusiveLock',
       'ShareUpdateExclusiveLock',
       'ShareRowExclusiveLock',
       'ExclusiveLock',
       'AccessExclusiveLock'
     );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'RAKEBACK_SOURCE_WRITERS_NOT_DRAINED: % conflicting backends still hold hot-table locks',
      v_bad;
  END IF;
END
$no_conflicting_writers$;

DO $pending_payout_children$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.rakeback_periods p
    JOIN public.rakeback_period_payouts pp ON pp.rakeback_period_id = p.id
   WHERE p.status = 'pending';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'RAKEBACK_PENDING_PERIOD_HAS_PAYOUT_CHILD: % pending rows already own payout evidence',
      v_bad;
  END IF;
END
$pending_payout_children$;

INSERT INTO rakeback_cutover_basis (day)
SELECT date_trunc(
         'week',
         COALESCE(
           (SELECT min(period_start)
              FROM public.rakeback_periods
             WHERE status = 'pending'),
           CURRENT_DATE
         )::timestamp
       )::date AS day;

DO $source_shape$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.rake_records r
    CROSS JOIN rakeback_cutover_basis b
   WHERE r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.player_contributions <> '{}'::jsonb
     AND (
       r.club_id IS NULL
       OR r.created_at IS NULL
       OR (
         r.created_at >= (b.day::timestamp AT TIME ZONE 'UTC')
         AND (
           jsonb_typeof(r.player_contributions) <> 'object'
           OR round(r.rake_amount * 100)::bigint <= 0
         )
       )
     );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      '% positive source rows cannot enter the exact rakeback cutover', v_bad;
  END IF;
END
$source_shape$;

DO $link_cutover_compensations$
DECLARE
  v_negative record;
  v_negative_cents bigint;
  v_linked_cents bigint;
  v_attributed_candidates bigint;
  v_original_id uuid;
  v_user_id uuid;
  v_registration_id text;
BEGIN
  FOR v_negative IN
    SELECT r.*
      FROM public.rake_records r
     WHERE r.rake_amount < 0
       AND round(abs(r.rake_amount) * 100)::bigint > 0
     ORDER BY r.created_at, r.id
  LOOP
    IF v_negative.club_id IS NULL OR v_negative.created_at IS NULL THEN
      RAISE EXCEPTION
        'negative rake record % has no club or accounting time', v_negative.id;
    END IF;
    v_negative_cents := round(abs(v_negative.rake_amount) * 100)::bigint;
    v_original_id := NULL;
    v_user_id := NULL;
    v_registration_id := NULLIF(v_negative.metadata->>'registration_id', '');

    IF COALESCE(v_negative.metadata->>'original_rake_record_id', '')
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      v_original_id := (v_negative.metadata->>'original_rake_record_id')::uuid;
    ELSIF COALESCE(v_negative.metadata->>'user_id', '')
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      v_user_id := (v_negative.metadata->>'user_id')::uuid;
    ELSIF NULLIF(v_negative.metadata->>'original_rake_record_id', '') IS NOT NULL
       OR NULLIF(v_negative.metadata->>'user_id', '') IS NOT NULL THEN
      RAISE EXCEPTION 'negative rake record % has a malformed source selector',
        v_negative.id;
    END IF;

    INSERT INTO rakeback_cutover_compensation_links (
      compensation_rake_record_id, original_rake_record_id
    )
    SELECT v_negative.id, p.id
      FROM public.rake_records p
     WHERE p.rake_amount > 0
       AND p.club_id = v_negative.club_id
       AND p.tournament_id IS NOT DISTINCT FROM v_negative.tournament_id
       AND p.created_at <= v_negative.created_at
       AND round(p.rake_amount * 100)::bigint > 0
       AND p.player_contributions IS NOT NULL
       AND p.player_contributions <> '{}'::jsonb
       AND jsonb_typeof(p.player_contributions) = 'object'
       AND NOT public.fn_rake_record_is_ghost_twin(p.hand_id, p.table_id, p.metadata)
       AND (
         (v_original_id IS NOT NULL AND p.id = v_original_id)
         OR (
           v_original_id IS NULL
           AND v_registration_id IS NOT NULL
           AND p.metadata->>'registration_id' = v_registration_id
           AND (v_user_id IS NULL OR p.metadata->>'user_id' = v_user_id::text)
         )
         OR (
           v_original_id IS NULL
           AND v_registration_id IS NULL
           AND v_user_id IS NOT NULL
           AND p.metadata->>'user_id' = v_user_id::text
           AND (SELECT count(*)
                  FROM public.fn_allocate_rake_credits(
                    p.rake_amount, p.player_contributions,
                    COALESCE(p.rake_method, 'DEALT_EQUAL')
                  ) a) = 1
           AND EXISTS (
             SELECT 1
               FROM public.fn_allocate_rake_credits(
                 p.rake_amount, p.player_contributions,
                 COALESCE(p.rake_method, 'DEALT_EQUAL')
               ) a
              WHERE a.user_id = v_user_id
           )
         )
         OR (
           v_original_id IS NULL
           AND v_registration_id IS NULL
           AND v_user_id IS NULL
           AND v_negative.player_contributions IS NOT NULL
           AND jsonb_typeof(v_negative.player_contributions) = 'object'
           AND v_negative.player_contributions <> '{}'::jsonb
           AND p.player_contributions = v_negative.player_contributions
           AND round(p.rake_amount * 100)::bigint = v_negative_cents
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM rakeback_cutover_compensation_links l
          WHERE l.original_rake_record_id = p.id
       )
     ORDER BY p.created_at, p.id;

    SELECT COALESCE(sum(round(p.rake_amount * 100)::bigint), 0)
      INTO v_linked_cents
      FROM rakeback_cutover_compensation_links l
      JOIN public.rake_records p ON p.id = l.original_rake_record_id
     WHERE l.compensation_rake_record_id = v_negative.id;

    IF v_linked_cents = v_negative_cents THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_attributed_candidates
      FROM public.rake_records p
     WHERE p.rake_amount > 0
       AND p.club_id = v_negative.club_id
       AND p.tournament_id IS NOT DISTINCT FROM v_negative.tournament_id
       AND p.created_at <= v_negative.created_at
       AND round(p.rake_amount * 100)::bigint > 0
       AND p.player_contributions IS NOT NULL
       AND p.player_contributions <> '{}'::jsonb
       AND jsonb_typeof(p.player_contributions) = 'object'
       AND NOT public.fn_rake_record_is_ghost_twin(p.hand_id, p.table_id, p.metadata)
       AND (
         (v_original_id IS NOT NULL AND p.id = v_original_id)
         OR (v_registration_id IS NOT NULL
             AND p.metadata->>'registration_id' = v_registration_id)
         OR (v_user_id IS NOT NULL AND p.metadata->>'user_id' = v_user_id::text)
         OR (v_original_id IS NULL AND v_registration_id IS NULL
             AND v_user_id IS NULL)
       );

    IF v_linked_cents = 0 AND v_attributed_candidates = 0 THEN
      INSERT INTO rakeback_cutover_unapplied_compensations
        (compensation_rake_record_id, reason)
      VALUES (v_negative.id, 'legacy_source_had_no_attributed_open_basis');
    ELSE
      RAISE EXCEPTION
        'negative rake record % links % cents to an open attributed basis; expected exactly %',
        v_negative.id, v_linked_cents, v_negative_cents;
    END IF;
  END LOOP;
END
$link_cutover_compensations$;

INSERT INTO rakeback_cutover_expected_daily_user (
  club_id, day, user_id, cents
)
SELECT r.club_id,
       (r.created_at AT TIME ZONE 'UTC')::date AS day,
       a.user_id,
       sum(round(a.credit * 100)::bigint)::bigint AS cents
  FROM public.rake_records r
  CROSS JOIN rakeback_cutover_basis b
  CROSS JOIN LATERAL public.fn_allocate_rake_credits(
    r.rake_amount,
    r.player_contributions,
    COALESCE(r.rake_method, 'DEALT_EQUAL')
  ) a
 WHERE r.created_at >= (b.day::timestamp AT TIME ZONE 'UTC')
   AND r.club_id IS NOT NULL
   AND r.rake_amount > 0
   AND round(r.rake_amount * 100)::bigint > 0
   AND r.player_contributions IS NOT NULL
   AND r.player_contributions <> '{}'::jsonb
   AND jsonb_typeof(r.player_contributions) = 'object'
   AND NOT CASE
     WHEN r.hand_id IS NULL
      AND r.table_id IS NOT NULL
      AND COALESCE(r.metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
      AND (r.metadata->>'hand_number')::bigint >= 1000000
     THEN public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
     ELSE false
   END
   AND NOT EXISTS (
     SELECT 1 FROM rakeback_cutover_compensation_links l
      WHERE l.original_rake_record_id = r.id
   )
 GROUP BY r.club_id, (r.created_at AT TIME ZONE 'UTC')::date, a.user_id;

INSERT INTO rakeback_cutover_counts (
  club_id, day, exact_rows, source_cents
)
WITH source_days AS (
  SELECT r.club_id,
         (r.created_at AT TIME ZONE 'UTC')::date AS day,
         count(*)::bigint AS exact_rows,
         sum(round(r.rake_amount * 100)::bigint)::bigint AS source_cents
    FROM public.rake_records r
    CROSS JOIN rakeback_cutover_basis b
   WHERE r.created_at >= (b.day::timestamp AT TIME ZONE 'UTC')
     AND r.club_id IS NOT NULL
     AND r.rake_amount > 0
     AND round(r.rake_amount * 100)::bigint > 0
     AND r.player_contributions IS NOT NULL
     AND r.player_contributions <> '{}'::jsonb
     AND jsonb_typeof(r.player_contributions) = 'object'
     AND NOT CASE
       WHEN r.hand_id IS NULL
        AND r.table_id IS NOT NULL
        AND COALESCE(r.metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
        AND (r.metadata->>'hand_number')::bigint >= 1000000
       THEN public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
       ELSE false
     END
     AND NOT EXISTS (
       SELECT 1 FROM rakeback_cutover_compensation_links l
        WHERE l.original_rake_record_id = r.id
     )
   GROUP BY r.club_id, (r.created_at AT TIME ZONE 'UTC')::date
), pending_days AS (
  SELECT DISTINCT p.club_id, g.day::date AS day
    FROM public.rakeback_periods p
    CROSS JOIN LATERAL generate_series(
      p.period_start, p.period_end, interval '1 day'
    ) g(day)
   WHERE p.status = 'pending'
), days AS (
  SELECT club_id, day FROM source_days
  UNION
  SELECT club_id, day FROM pending_days
)
SELECT d.club_id,
       d.day,
       COALESCE(s.exact_rows, 0)::bigint AS exact_rows,
       COALESCE(s.source_cents, 0)::bigint AS source_cents
  FROM days d
  LEFT JOIN source_days s USING (club_id, day);

DO $canonical_basis_balances$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM rakeback_cutover_counts c
    LEFT JOIN (
      SELECT club_id, day, sum(cents)::bigint AS allocated_cents
        FROM rakeback_cutover_expected_daily_user
       GROUP BY club_id, day
    ) a USING (club_id, day)
   WHERE c.source_cents <> COALESCE(a.allocated_cents, 0);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      '% cutover club-days do not allocate exactly to their source cents',
      v_bad;
  END IF;
END
$canonical_basis_balances$;

SELECT format(
  'RAKEBACK_SOURCE_ACCRUAL_PREAPPLY_OK basis_from_day=%s source_days=%s source_rows=%s source_cents=%s player_rows=%s compensation_links=%s unapplied_legacy_refunds=%s',
  (SELECT day FROM rakeback_cutover_basis),
  (SELECT count(*) FROM rakeback_cutover_counts),
  (SELECT COALESCE(sum(exact_rows), 0) FROM rakeback_cutover_counts),
  (SELECT COALESCE(sum(source_cents), 0) FROM rakeback_cutover_counts),
  (SELECT count(*) FROM rakeback_cutover_expected_daily_user),
  (SELECT count(*) FROM rakeback_cutover_compensation_links),
  (SELECT count(*) FROM rakeback_cutover_unapplied_compensations)
);

ROLLBACK;
