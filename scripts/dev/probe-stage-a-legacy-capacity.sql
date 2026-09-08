\set ON_ERROR_STOP on

/* Dedicated rolling-window tournaments: one proves a committed old raw
   insert, and one is reserved for the two-session cutover boundary probe. */
INSERT INTO public.tournaments (id, name, status) VALUES
  ('10000000-0000-4000-8000-000000000003', 'Legacy Capacity A', 'RUNNING'),
  ('10000000-0000-4000-8000-000000000004', 'Legacy Capacity Boundary', 'RUNNING');

INSERT INTO public.engine_tournament_leases (
  tournament_id,
  instance_id,
  engine_version,
  heartbeat_at,
  lease_generation,
  protocol_version
) VALUES
  (
    '10000000-0000-4000-8000-000000000003',
    'pg17-legacy-a',
    'old-engine',
    clock_timestamp(),
    '50000000-0000-4000-8000-000000000003',
    1
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'pg17-legacy-boundary',
    'old-engine',
    clock_timestamp(),
    '50000000-0000-4000-8000-000000000004',
    1
  );

/* Exact old request shape: service-role PostgREST POST /tables, no Smarter
   actor headers, and the Stage-A hook's legacy-unmarked transaction marker. */
BEGIN;
SELECT set_config('request.headers', '{}', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.method', 'POST', true);
SELECT set_config('request.path', '/rest/v1/tables', true);
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
INSERT INTO public.tables (
  id,
  tournament_id,
  status,
  current_players,
  max_players
) VALUES (
  '20000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000003',
  'running',
  0,
  9
);
COMMIT;

DO $assert_legacy_capacity_receipt$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tournament_table_origins o
      JOIN public.tournament_capacity_table_receipts c
        ON c.table_id = o.table_id
       AND c.tournament_id = o.tournament_id
      JOIN public.tournament_manager_wakes w
        ON w.id = c.manager_wake_id
     WHERE o.table_id = '20000000-0000-4000-8000-000000000003'
       AND o.tournament_id = '10000000-0000-4000-8000-000000000003'
       AND o.origin_kind = 'capacity'
       AND c.manager_admitted_at IS NULL
       AND w.reason = 'late_registration'
       AND w.consumed_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Stage A did not give the old raw table canonical receipt/wake provenance';
  END IF;
END;
$assert_legacy_capacity_receipt$;

/* The marked protocol-2 route still creates and proves its own canonical
   receipt. The bridge cannot match this request shape. */
BEGIN;
SELECT set_config(
  'request.headers',
  '{"x-smarter-data-actor":"tournament-manager",'
    '"x-smarter-data-protocol":"2",'
    '"x-smarter-tournament-id":"10000000-0000-4000-8000-000000000001",'
    '"x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000001"}',
  true
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.method', 'POST', true);
SELECT set_config(
  'request.path',
  '/rpc/fn_ensure_late_registration_capacity',
  true
);
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.fn_ensure_late_registration_capacity(
  '10000000-0000-4000-8000-000000000001',
  1
);
COMMIT;

DO $assert_protocol_two_capacity_receipt$
BEGIN
  IF (
    SELECT count(*)
      FROM public.tournament_table_origins o
      JOIN public.tournament_capacity_table_receipts c
        ON c.table_id = o.table_id
       AND c.tournament_id = o.tournament_id
      JOIN public.tournament_manager_wakes w
        ON w.id = c.manager_wake_id
     WHERE o.tournament_id = '10000000-0000-4000-8000-000000000001'
       AND o.origin_kind = 'capacity'
       AND w.reason = 'late_registration'
  ) <> 1 THEN
    RAISE EXCEPTION
      'marked protocol-2 capacity did not prove its canonical receipt';
  END IF;
END;
$assert_protocol_two_capacity_receipt$;

SELECT 'Stage-A legacy and canonical capacity receipts passed' AS result;
