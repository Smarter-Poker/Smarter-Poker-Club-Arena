"""Rollback-only PostgreSQL 17 matrix for frozen satellite entitlements."""


def verify_satellite_entitlement_cents(run, materialize_definition):
    """Execute the latest migrated materializer body, then roll back every row."""
    ddl = """
ALTER TABLE public.tournaments
  ADD PRIMARY KEY (id),
  ADD COLUMN variant text,
  ADD COLUMN tournament_type text,
  ADD COLUMN satellite_target_id uuid,
  ADD COLUMN satellite_seats integer,
  ADD COLUMN prize_pool numeric(15,2);

CREATE TABLE public.tournament_satellite_economic_snapshots (
  tournament_id uuid PRIMARY KEY,
  target_tournament_id uuid,
  configured_seats integer NOT NULL,
  ticket_value numeric(15,2) NOT NULL,
  source_contract_hash text NOT NULL,
  target_contract_hash text
);

CREATE TABLE public.tournament_entry_close_receipts (
  tournament_id uuid PRIMARY KEY,
  final_prize_pool numeric(15,2) NOT NULL,
  entry_closed_at timestamptz NOT NULL
);

CREATE TABLE public.tournament_satellite_entitlements (
  tournament_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  target_tournament_id uuid,
  award_kind text NOT NULL CHECK (award_kind IN ('seat_or_cash', 'cash')),
  ticket_value numeric(15,2) NOT NULL CHECK (ticket_value >= 0),
  remainder_value numeric(15,2) NOT NULL CHECK (remainder_value >= 0),
  source_pool numeric(15,2) NOT NULL CHECK (source_pool >= 0),
  entry_closed_at timestamptz NOT NULL,
  PRIMARY KEY (tournament_id, position)
);
"""

    matrix = """
DO $satellite_cent_matrix$
DECLARE
  v_case record;
  v_source uuid;
  v_target uuid;
  v_result jsonb;
  v_replay jsonb;
  v_expected_seats integer;
  v_expected_remainder integer;
  v_expected_depth integer;
  v_expected_remainder_position integer;
  v_count integer;
  v_min_position integer;
  v_max_position integer;
  v_position_sum integer;
  v_value_cents integer;
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      (1, '.30/.10 exact multiple', 30, 10, 10),
      (2, '.29/.10 one cent below', 29, 10, 10),
      (3, '.31/.10 one cent above', 31, 10, 10),
      (4, '.31/.10 short-field cap', 31, 10, 2)
    ) AS cases(case_no, label, pool_cents, ticket_cents, field_size)
  LOOP
    v_source := (
      '10000000-0000-4000-8000-' || lpad(v_case.case_no::text, 12, '0')
    )::uuid;
    v_target := (
      '20000000-0000-4000-8000-' || lpad(v_case.case_no::text, 12, '0')
    )::uuid;

    INSERT INTO public.tournaments (
      id, status, variant, tournament_type, satellite_target_id,
      satellite_seats, prize_pool, prize_pool_finalized
    ) VALUES
      (v_target, 'REGISTERING', 'mtt', 'MTT', NULL, 0, 0, false),
      (v_source, 'COMPLETING', 'satellite', 'SATELLITE', v_target, 0,
       v_case.pool_cents::numeric / 100, true);

    INSERT INTO public.tournament_satellite_economic_snapshots (
      tournament_id, target_tournament_id, configured_seats, ticket_value,
      source_contract_hash, target_contract_hash
    ) VALUES (
      v_source, v_target, 0, v_case.ticket_cents::numeric / 100,
      repeat('a', 64), repeat('b', 64)
    );

    INSERT INTO public.tournament_entry_close_receipts (
      tournament_id, final_prize_pool, entry_closed_at
    ) VALUES (
      v_source, v_case.pool_cents::numeric / 100,
      '2026-09-08 20:00:00+00'::timestamptz
    );

    INSERT INTO public.tournament_players (tournament_id, user_id)
    SELECT v_source, (
      '30000000-0000-4000-8000-' ||
      lpad((v_case.case_no * 100 + n)::text, 12, '0')
    )::uuid
      FROM generate_series(1, v_case.field_size) AS players(n);

    v_result := public.fn_materialize_satellite_entitlements_locked(v_source);
    v_expected_seats := LEAST(
      v_case.field_size,
      floor(v_case.pool_cents::numeric / v_case.ticket_cents)::integer
    );
    v_expected_remainder :=
      v_case.pool_cents - v_expected_seats * v_case.ticket_cents;
    v_expected_remainder_position := CASE
      WHEN v_expected_remainder > 0
        THEN LEAST(v_expected_seats + 1, v_case.field_size)
      ELSE NULL
    END;
    v_expected_depth := v_expected_seats + CASE
      WHEN v_expected_remainder_position > v_expected_seats THEN 1
      ELSE 0
    END;

    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'ready')::boolean, false) IS NOT TRUE
       OR (v_result->>'award_depth')::integer <> v_expected_depth THEN
      RAISE EXCEPTION '% returned the wrong plan: %', v_case.label, v_result;
    END IF;

    SELECT count(*)::integer, min(position), max(position), sum(position)::integer
      INTO v_count, v_min_position, v_max_position, v_position_sum
      FROM public.tournament_satellite_entitlements
     WHERE tournament_id = v_source;
    IF v_count <> v_expected_depth
       OR v_min_position <> 1
       OR v_max_position <> v_expected_depth
       OR v_position_sum <> (v_expected_depth * (v_expected_depth + 1)) / 2 THEN
      RAISE EXCEPTION
        '% did not materialize contiguous positions 1..%: count %, min %, max %, sum %',
        v_case.label, v_expected_depth, v_count, v_min_position,
        v_max_position, v_position_sum;
    END IF;

    IF (
      SELECT count(*)
        FROM public.tournament_satellite_entitlements
       WHERE tournament_id = v_source
         AND award_kind = 'seat_or_cash'
         AND round(ticket_value * 100)::integer = v_case.ticket_cents
    ) <> v_expected_seats THEN
      RAISE EXCEPTION '% materialized the wrong funded-seat count', v_case.label;
    END IF;

    IF (
      SELECT count(*)
        FROM public.tournament_satellite_entitlements
       WHERE tournament_id = v_source
         AND award_kind = 'cash'
    ) <> (CASE
      WHEN v_expected_remainder > 0 AND v_expected_seats < v_case.field_size THEN 1
      ELSE 0
    END) THEN
      RAISE EXCEPTION '% materialized the wrong cash-only row count', v_case.label;
    END IF;

    IF COALESCE((
      SELECT sum(round(remainder_value * 100)::integer)
        FROM public.tournament_satellite_entitlements
       WHERE tournament_id = v_source
    ), 0) <> v_expected_remainder THEN
      RAISE EXCEPTION '% materialized the wrong remainder cents', v_case.label;
    END IF;

    IF v_expected_remainder > 0 AND NOT EXISTS (
      SELECT 1
        FROM public.tournament_satellite_entitlements
       WHERE tournament_id = v_source
         AND position = v_expected_remainder_position
         AND round(remainder_value * 100)::integer = v_expected_remainder
    ) THEN
      RAISE EXCEPTION '% put the remainder on the wrong position', v_case.label;
    END IF;

    SELECT sum(
      round(ticket_value * 100)::integer +
      round(remainder_value * 100)::integer
    )::integer
      INTO v_value_cents
      FROM public.tournament_satellite_entitlements
     WHERE tournament_id = v_source;
    IF v_value_cents <> v_case.pool_cents THEN
      RAISE EXCEPTION '% failed exact cent conservation: % versus %',
        v_case.label, v_value_cents, v_case.pool_cents;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.tournament_satellite_entitlements
       WHERE tournament_id = v_source
         AND round(source_pool * 100)::integer <> v_case.pool_cents
    ) THEN
      RAISE EXCEPTION '% stamped the wrong source pool', v_case.label;
    END IF;

    v_replay := public.fn_materialize_satellite_entitlements_locked(v_source);
    IF v_replay IS DISTINCT FROM v_result OR (
      SELECT count(*)
        FROM public.tournament_satellite_entitlements
       WHERE tournament_id = v_source
    ) <> v_expected_depth THEN
      RAISE EXCEPTION '% changed on deterministic replay: %', v_case.label, v_replay;
    END IF;
  END LOOP;
END;
$satellite_cent_matrix$;
"""

    run("BEGIN;\n" + ddl + "\n" + materialize_definition + "\n" + matrix + "\nROLLBACK;")

    # The shared accounting fixture already owns tournaments.status,
    # tournaments.prize_pool_finalized, and tournament_players.  This probe
    # must use that canonical shape instead of trying to create a second copy;
    # only the satellite-specific additions belong to this rollback boundary.
    # The probe is not allowed to leave a helper or widened tournaments shape
    # in the shared isolated database.
    run("""
DO $satellite_cent_rollback_proof$
BEGIN
  IF to_regprocedure(
       'public.fn_materialize_satellite_entitlements_locked(uuid)'
     ) IS NOT NULL
     OR to_regclass('public.tournament_satellite_economic_snapshots') IS NOT NULL
     OR to_regclass('public.tournament_entry_close_receipts') IS NOT NULL
     OR to_regclass('public.tournament_satellite_entitlements') IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tournaments'
          AND column_name IN (
            'variant', 'tournament_type', 'satellite_target_id',
            'satellite_seats', 'prize_pool'
          )
     ) THEN
    RAISE EXCEPTION 'satellite cent matrix left fixture state behind';
  END IF;
END;
$satellite_cent_rollback_proof$;
""")
    print(
        "Satellite entitlement cents: 4 matrix cases and 4 deterministic replays passed; transaction rolled back",
        flush=True,
    )
