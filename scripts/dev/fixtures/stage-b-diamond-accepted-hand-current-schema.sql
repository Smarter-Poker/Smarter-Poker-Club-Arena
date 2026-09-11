\set ON_ERROR_STOP on
\set VERBOSITY verbose

-- Current-production-schema acceptance fixture for the Stage-B forward chain.
-- The caller owns the disposable database and must keep this psql session open
-- through the accepted-hand rollback, success and exact operation replay. This
-- file creates only pg_temp helpers and synthetic rows; it never replaces or
-- alters a production object.

DO $stage_b_diamond_current_preflight$
DECLARE
  v_missing text;
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17
     OR NOT (
       inet_server_addr() IS NULL
       OR inet_server_addr() <<= inet '127.0.0.0/8'
       OR inet_server_addr() = inet '::1'
     )
     OR current_database() = 'postgres' THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_FIXTURE_REQUIRES_DISPOSABLE_LOCAL_PG17_DATABASE';
  END IF;

  SELECT string_agg(required.identity, ', ' ORDER BY required.identity)
    INTO v_missing
    FROM (VALUES
      ('table public.profiles',
       to_regclass('public.profiles') IS NOT NULL),
      ('table public.clubs',
       to_regclass('public.clubs') IS NOT NULL),
      ('table public.ca_arena_settings',
       to_regclass('public.ca_arena_settings') IS NOT NULL),
      ('table public.tables',
       to_regclass('public.tables') IS NOT NULL),
      ('table public.table_seats',
       to_regclass('public.table_seats') IS NOT NULL),
      ('table public.engine_table_leases',
       to_regclass('public.engine_table_leases') IS NOT NULL),
      ('table public.diamond_purchase_lots',
       to_regclass('public.diamond_purchase_lots') IS NOT NULL),
      ('table public.poker_diamond_custody',
       to_regclass('public.poker_diamond_custody') IS NOT NULL),
      ('table public.poker_diamond_lot_reservations',
       to_regclass('public.poker_diamond_lot_reservations') IS NOT NULL),
      ('table public.poker_diamond_hand_receipts',
       to_regclass('public.poker_diamond_hand_receipts') IS NOT NULL),
      ('table public.hand_history',
       to_regclass('public.hand_history') IS NOT NULL),
      ('table public.hand_atomic_commits',
       to_regclass('public.hand_atomic_commits') IS NOT NULL),
      ('table public.hand_projection_outbox',
       to_regclass('public.hand_projection_outbox') IS NOT NULL),
      ('function public.fn_ca_commit_hand_settlement/12',
       to_regprocedure(
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
       ) IS NOT NULL),
      ('function public.fn_ca_commit_hand_settlement_exact_before_obligations/11',
       to_regprocedure(
         'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
       ) IS NOT NULL),
      ('function public.fn_ca_commit_hand_settlement_before_lease_generation/9',
       to_regprocedure(
         'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
       ) IS NOT NULL),
      ('function public.fn_ca_settle_hand_stacks_absolute/7',
       to_regprocedure(
         'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
       ) IS NOT NULL),
      ('function public.fn_poker_diamond_settle_cash_hand/7',
       to_regprocedure(
         'public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
       ) IS NOT NULL),
      ('function public.atomic_seat_cashout_locked/4',
       to_regprocedure(
         'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'
       ) IS NOT NULL),
      ('function public.atomic_seat_cashout_locked_pre_tournament_guard/4',
       to_regprocedure(
         'public.atomic_seat_cashout_locked_pre_tournament_guard(uuid,uuid,integer,text)'
       ) IS NOT NULL),
      ('function public.fn_cashout_seat_occupancy/5',
       to_regprocedure(
         'public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)'
       ) IS NOT NULL)
    ) required(identity, present)
   WHERE NOT required.present;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'STAGE_B_DIAMOND_CURRENT_SCHEMA_MISSING: %', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM public.clubs WHERE asset = 'diamonds' OR is_platform)
     OR EXISTS (SELECT 1 FROM public.ca_arena_settings)
     OR EXISTS (
       SELECT 1 FROM public.profiles
        WHERE id IN (
          '7b500000-0000-0000-0000-000000000101'::uuid,
          '7b500000-0000-0000-0000-000000000102'::uuid
        )
     ) THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_FIXTURE_REQUIRES_EMPTY_SYNTHETIC_ARENA_PREIMAGE';
  END IF;
END;
$stage_b_diamond_current_preflight$;

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

CREATE TEMP TABLE stage_b_diamond_accepted_hand_input (
  stacks jsonb NOT NULL,
  hand_row jsonb NOT NULL,
  obligations jsonb NOT NULL
) ON COMMIT PRESERVE ROWS;

CREATE FUNCTION pg_temp.stage_b_diamond_accept()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $stage_b_diamond_accept$
DECLARE
  v_input pg_temp.stage_b_diamond_accepted_hand_input%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_input
    FROM pg_temp.stage_b_diamond_accepted_hand_input;

  RETURN public.fn_ca_commit_hand_settlement(
    '7b500000-0000-0000-0000-000000000003'::uuid,
    1000002,
    v_input.stacks,
    0,
    0,
    'stage-b-diamond-current-schema',
    0,
    v_input.hand_row,
    '[]'::jsonb,
    'stage-b-diamond-current-schema-engine',
    '7b500000-0000-0000-0000-000000000501'::uuid,
    v_input.obligations
  );
END;
$stage_b_diamond_accept$;

CREATE FUNCTION pg_temp.stage_b_diamond_current_data_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $stage_b_diamond_current_data_fingerprint$
SELECT md5(jsonb_build_object(
  'auth_users', COALESCE((
    SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id)
      FROM auth.users u
     WHERE u.id IN (
       '7b500000-0000-0000-0000-000000000101'::uuid,
       '7b500000-0000-0000-0000-000000000102'::uuid
     )
  ), '[]'::jsonb),
  'profiles', COALESCE((
    SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
      FROM public.profiles p
     WHERE p.id IN (
       '7b500000-0000-0000-0000-000000000101'::uuid,
       '7b500000-0000-0000-0000-000000000102'::uuid
     )
  ), '[]'::jsonb),
  'clubs', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
      FROM public.clubs c
     WHERE c.id = '7b500000-0000-0000-0000-000000000001'::uuid
  ), '[]'::jsonb),
  'arena_settings', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
      FROM public.ca_arena_settings s
     WHERE s.club_id = '7b500000-0000-0000-0000-000000000001'::uuid
  ), '[]'::jsonb),
  'tables', COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)
      FROM public.tables t
     WHERE t.id = '7b500000-0000-0000-0000-000000000003'::uuid
  ), '[]'::jsonb),
  'seats', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
      FROM public.table_seats s
     WHERE s.id IN (
       '7b500000-0000-0000-0000-000000000301'::uuid,
       '7b500000-0000-0000-0000-000000000302'::uuid
     )
  ), '[]'::jsonb),
  'leases', COALESCE((
    SELECT jsonb_agg(to_jsonb(l) ORDER BY l.table_id)
      FROM public.engine_table_leases l
     WHERE l.table_id = '7b500000-0000-0000-0000-000000000003'::uuid
  ), '[]'::jsonb),
  'purchase_lots', COALESCE((
    SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
      FROM public.diamond_purchase_lots l
     WHERE l.id IN (
       '7b500000-0000-0000-0000-000000000211'::uuid,
       '7b500000-0000-0000-0000-000000000212'::uuid
     )
  ), '[]'::jsonb),
  'custody', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
      FROM public.poker_diamond_custody c
     WHERE c.id IN (
       '7b500000-0000-0000-0000-000000000401'::uuid,
       '7b500000-0000-0000-0000-000000000402'::uuid
     )
  ), '[]'::jsonb),
  'lot_reservations', COALESCE((
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.custody_id, r.lot_id)
      FROM public.poker_diamond_lot_reservations r
     WHERE r.custody_id IN (
       '7b500000-0000-0000-0000-000000000401'::uuid,
       '7b500000-0000-0000-0000-000000000402'::uuid
     )
  ), '[]'::jsonb),
  'diamond_hand_receipts', COALESCE((
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.table_id, r.hand_number)
      FROM public.poker_diamond_hand_receipts r
     WHERE r.table_id = '7b500000-0000-0000-0000-000000000003'::uuid
  ), '[]'::jsonb),
  'hand_history', COALESCE((
    SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id)
      FROM public.hand_history h
     WHERE h.table_id = '7b500000-0000-0000-0000-000000000003'::uuid
  ), '[]'::jsonb),
  'atomic_commits', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_id, c.hand_number)
      FROM public.hand_atomic_commits c
     WHERE c.table_id = '7b500000-0000-0000-0000-000000000003'::uuid
  ), '[]'::jsonb),
  'projection_outbox', COALESCE((
    SELECT jsonb_agg(to_jsonb(o) ORDER BY o.hand_id)
      FROM public.hand_projection_outbox o
     WHERE o.table_id = '7b500000-0000-0000-0000-000000000003'::uuid
  ), '[]'::jsonb)
)::text);
$stage_b_diamond_current_data_fingerprint$;

CREATE FUNCTION pg_temp.stage_b_diamond_current_catalog_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $stage_b_diamond_current_catalog_fingerprint$
WITH target_functions(identity) AS (
  VALUES
    ('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'),
    ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'),
    ('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'),
    ('public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'),
    ('public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'),
    ('public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'),
    ('public.atomic_seat_cashout_locked_pre_tournament_guard(uuid,uuid,integer,text)'),
    ('public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)')
), function_rows AS (
  SELECT target.identity,
         pg_get_functiondef(p.oid) AS definition,
         pg_get_userbyid(p.proowner) AS owner_name,
         l.lanname AS language_name,
         p.prosecdef,
         p.provolatile,
         p.proparallel,
         p.proisstrict,
         p.proleakproof,
         p.prokind,
         p.proretset,
         p.prorettype::regtype::text AS return_type,
         p.pronargs,
         p.pronargdefaults,
         p.proconfig,
         p.proacl,
         obj_description(p.oid, 'pg_proc') AS comment
    FROM target_functions target
    JOIN pg_proc p ON p.oid = to_regprocedure(target.identity)
    JOIN pg_language l ON l.oid = p.prolang
), target_relations(identity) AS (
  VALUES
    ('public.diamond_purchase_lots'),
    ('public.engine_table_leases'),
    ('public.hand_atomic_commits'),
    ('public.hand_history'),
    ('public.hand_projection_outbox'),
    ('public.poker_diamond_custody'),
    ('public.poker_diamond_hand_receipts'),
    ('public.poker_diamond_lot_reservations'),
    ('public.table_seats')
), relation_rows AS (
  SELECT target.identity,
         c.relkind,
         pg_get_userbyid(c.relowner) AS owner_name,
         c.relrowsecurity,
         c.relforcerowsecurity,
         c.relreplident,
         c.relacl
    FROM target_relations target
    JOIN pg_class c ON c.oid = to_regclass(target.identity)
), target_indexes(relation_name, index_name) AS (
  VALUES
    ('public.engine_table_leases',
     'engine_table_leases_owner_generation_key'),
    ('public.hand_atomic_commits', 'hand_atomic_commits_pkey'),
    ('public.hand_history', 'uq_hand_history_global_hand_number'),
    ('public.hand_projection_outbox', 'hand_projection_outbox_pkey'),
    ('public.poker_diamond_custody', 'poker_diamond_custody_occupancy'),
    ('public.poker_diamond_hand_receipts',
     'poker_diamond_hand_receipts_pkey'),
    ('public.poker_diamond_lot_reservations',
     'poker_diamond_lot_reservations_pkey')
), index_rows AS (
  SELECT target.relation_name,
         target.index_name,
         pg_get_indexdef(i.indexrelid) AS definition,
         i.indisunique,
         i.indisprimary,
         i.indisvalid,
         i.indisready,
         i.indislive,
         i.indisreplident,
         i.indnullsnotdistinct
    FROM target_indexes target
    JOIN pg_class relation
      ON relation.oid = to_regclass(target.relation_name)
    JOIN pg_class index_class
      ON index_class.relnamespace = relation.relnamespace
     AND index_class.relname = target.index_name
    JOIN pg_index i
      ON i.indexrelid = index_class.oid
     AND i.indrelid = relation.oid
), target_triggers(relation_name, trigger_name) AS (
  VALUES
    ('public.hand_projection_outbox',
     'a0_finish_hand_post_commit_obligations'),
    ('public.poker_diamond_hand_receipts',
     'poker_diamond_hand_receipts_append_only'),
    ('public.table_seats', 'zzz_diamond_seat_keeps_custody')
), trigger_rows AS (
  SELECT target.relation_name,
         target.trigger_name,
         pg_get_triggerdef(t.oid, true) AS definition,
         t.tgenabled,
         t.tgtype,
         t.tgisinternal,
         obj_description(t.oid, 'pg_trigger') AS comment
    FROM target_triggers target
    JOIN pg_trigger t
      ON t.tgrelid = to_regclass(target.relation_name)
     AND t.tgname = target.trigger_name
)
SELECT md5(jsonb_build_object(
  'functions', (
    SELECT jsonb_agg(to_jsonb(f) ORDER BY f.identity) FROM function_rows f
  ),
  'relations', (
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.identity) FROM relation_rows r
  ),
  'indexes', (
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.relation_name, i.index_name)
      FROM index_rows i
  ),
  'triggers', (
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.relation_name, t.trigger_name)
      FROM trigger_rows t
  )
)::text);
$stage_b_diamond_current_catalog_fingerprint$;

CREATE FUNCTION pg_temp.stage_b_diamond_current_schema_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $stage_b_diamond_current_schema_fingerprint$
SELECT md5(jsonb_build_object(
  'data', pg_temp.stage_b_diamond_current_data_fingerprint(),
  'catalog', pg_temp.stage_b_diamond_current_catalog_fingerprint()
)::text);
$stage_b_diamond_current_schema_fingerprint$;

-- Synthetic current-schema preimage.  Replica mode is used only for fixture
-- construction so no unrelated signup, social, audit or table-management
-- programme can manufacture rows outside this isolated scenario.  The real
-- accepted-hand call below runs with every production trigger enabled.
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users(id)
VALUES
  ('7b500000-0000-0000-0000-000000000101'::uuid),
  ('7b500000-0000-0000-0000-000000000102'::uuid);

INSERT INTO public.profiles(
  id, username, display_name, diamonds, diamond_balance,
  created_at, updated_at
)
VALUES
  ('7b500000-0000-0000-0000-000000000101'::uuid,
   'stage_b_diamond_loser', 'Stage B Diamond Loser', 700, 700,
   '2026-09-10 08:00:00+00'::timestamptz,
   '2026-09-10 08:00:00+00'::timestamptz),
  ('7b500000-0000-0000-0000-000000000102'::uuid,
   'stage_b_diamond_winner', 'Stage B Diamond Winner', 700, 700,
   '2026-09-10 08:00:00+00'::timestamptz,
   '2026-09-10 08:00:00+00'::timestamptz);

INSERT INTO public.clubs(
  id, name, club_id, is_union, union_id, chip_treasury, chip_pool,
  promo_balance, insurance_balance, asset, is_platform,
  created_at, updated_at
)
VALUES (
  '7b500000-0000-0000-0000-000000000001'::uuid,
  'Stage B Disposable Diamond Arena', 79500, false, NULL,
  0, 0, 0, 0, 'diamonds', true,
  '2026-09-10 08:00:00+00'::timestamptz,
  '2026-09-10 08:00:00+00'::timestamptz
);

INSERT INTO public.ca_arena_settings(
  id, club_id, settlement_window_days, note, updated_at, cash_games_enabled
)
VALUES (
  1,
  '7b500000-0000-0000-0000-000000000001'::uuid,
  14,
  'Stage B disposable current-schema Diamond acceptance fixture',
  '2026-09-10 08:00:00+00'::timestamptz,
  true
);

INSERT INTO public.tables(
  id, club_id, name, game_type, stakes, small_blind, big_blind,
  min_buy_in, max_buy_in, max_players, current_players, status,
  game_variant, tournament_id, union_id, cluster_id, lifecycle,
  seat_game_scope, seat_admission_key, created_at, updated_at
)
VALUES (
  '7b500000-0000-0000-0000-000000000003'::uuid,
  '7b500000-0000-0000-0000-000000000001'::uuid,
  'Stage B Diamond Accepted Hand', 'cash', '1/2', 1, 2,
  10, 1000, 2, 2, 'active', 'nlh', NULL, NULL,
  '7b500000-0000-0000-0000-000000000002'::uuid, 'live',
  'cluster:7b500000-0000-0000-0000-000000000002', 'cash',
  '2026-09-10 08:00:00+00'::timestamptz,
  '2026-09-10 08:00:00+00'::timestamptz
);

INSERT INTO public.table_seats(
  id, table_id, seat_number, user_id, stack, joined_at, left_at,
  status, time_bank_remaining, time_bank_uses_remaining, club_id,
  occupancy_id, active_game_scope, active_parent_key
)
VALUES
  ('7b500000-0000-0000-0000-000000000301'::uuid,
   '7b500000-0000-0000-0000-000000000003'::uuid, 1,
   '7b500000-0000-0000-0000-000000000101'::uuid, 300,
   '2026-09-10 08:01:00+00'::timestamptz, NULL, 'active', 30, 4,
   '7b500000-0000-0000-0000-000000000001'::uuid,
   '7b500000-0000-0000-0000-000000000311'::uuid,
   'cluster:7b500000-0000-0000-0000-000000000002', 'cash'),
  ('7b500000-0000-0000-0000-000000000302'::uuid,
   '7b500000-0000-0000-0000-000000000003'::uuid, 2,
   '7b500000-0000-0000-0000-000000000102'::uuid, 300,
   '2026-09-10 08:02:00+00'::timestamptz, NULL, 'active', 30, 4,
   '7b500000-0000-0000-0000-000000000001'::uuid,
   '7b500000-0000-0000-0000-000000000312'::uuid,
   'cluster:7b500000-0000-0000-0000-000000000002', 'cash');

INSERT INTO public.diamond_purchase_lots(
  id, user_id, purchase_id, issued, consumed, refunded,
  frozen_at, settled_at, created_at, arena_reserved
)
VALUES
  ('7b500000-0000-0000-0000-000000000211'::uuid,
   '7b500000-0000-0000-0000-000000000101'::uuid,
   '7b500000-0000-0000-0000-000000000201'::uuid,
   500, 0, 0, NULL, NULL,
   '2026-09-10 07:00:00+00'::timestamptz, 300),
  ('7b500000-0000-0000-0000-000000000212'::uuid,
   '7b500000-0000-0000-0000-000000000102'::uuid,
   '7b500000-0000-0000-0000-000000000202'::uuid,
   500, 0, 0, NULL, NULL,
   '2026-09-10 07:00:01+00'::timestamptz, 300);

INSERT INTO public.poker_diamond_custody(
  id, user_id, arena_id, purpose, target_id, entry_key, balance,
  state, created_at, released_at, seat_id, seat_joined_at, occupancy_id
)
VALUES
  ('7b500000-0000-0000-0000-000000000401'::uuid,
   '7b500000-0000-0000-0000-000000000101'::uuid,
   '7b500000-0000-0000-0000-000000000001'::uuid,
   'cash_seat', '7b500000-0000-0000-0000-000000000003'::uuid,
   'stage-b-diamond-current-loser', 300, 'active',
   '2026-09-10 08:01:00+00'::timestamptz, NULL,
   '7b500000-0000-0000-0000-000000000301'::uuid,
   '2026-09-10 08:01:00+00'::timestamptz,
   '7b500000-0000-0000-0000-000000000311'::uuid),
  ('7b500000-0000-0000-0000-000000000402'::uuid,
   '7b500000-0000-0000-0000-000000000102'::uuid,
   '7b500000-0000-0000-0000-000000000001'::uuid,
   'cash_seat', '7b500000-0000-0000-0000-000000000003'::uuid,
   'stage-b-diamond-current-winner', 300, 'active',
   '2026-09-10 08:02:00+00'::timestamptz, NULL,
   '7b500000-0000-0000-0000-000000000302'::uuid,
   '2026-09-10 08:02:00+00'::timestamptz,
   '7b500000-0000-0000-0000-000000000312'::uuid);

INSERT INTO public.poker_diamond_lot_reservations(
  custody_id, lot_id, amount, released_at, consumed
)
VALUES
  ('7b500000-0000-0000-0000-000000000401'::uuid,
   '7b500000-0000-0000-0000-000000000211'::uuid, 300, NULL, 0),
  ('7b500000-0000-0000-0000-000000000402'::uuid,
   '7b500000-0000-0000-0000-000000000212'::uuid, 300, NULL, 0);

INSERT INTO public.engine_table_leases(
  table_id, instance_id, engine_version, acquired_at, heartbeat_at,
  lease_generation, protocol_version
)
VALUES (
  '7b500000-0000-0000-0000-000000000003'::uuid,
  'stage-b-diamond-current-schema-engine', 'stage-b-current-schema',
  clock_timestamp(), clock_timestamp(),
  '7b500000-0000-0000-0000-000000000501'::uuid, 2
);

INSERT INTO pg_temp.stage_b_diamond_accepted_hand_input(
  stacks, hand_row, obligations
)
SELECT
  jsonb_agg(jsonb_build_object(
    'user_id', s.user_id,
    'seat_id', s.id,
    'seat_joined_at', s.joined_at,
    'stack_before', 300,
    'stack', CASE WHEN s.seat_number = 1 THEN 250 ELSE 350 END
  ) ORDER BY s.user_id),
  jsonb_build_object(
    'table_id', '7b500000-0000-0000-0000-000000000003',
    'hand_number', 1000002,
    'game_variant', 'nlh',
    'pot_size', 100,
    'small_blind', 1,
    'big_blind', 2,
    'rake_amount', 0,
    'bbj_amount', 0,
    'button_seat', 1,
    'source', 'engine',
    'players', jsonb_agg(jsonb_build_object(
      'userId', s.user_id,
      'seat', s.seat_number,
      'stack', CASE WHEN s.seat_number = 1 THEN 250 ELSE 350 END
    ) ORDER BY s.user_id),
    'winners', jsonb_build_array(jsonb_build_object(
      'userId', '7b500000-0000-0000-0000-000000000102',
      'amount', 100
    )),
    'actions', jsonb_build_array(
      jsonb_build_object(
        'userId', '7b500000-0000-0000-0000-000000000101',
        'stage', 'preflop', 'action', 'raise', 'amount', 50
      ),
      jsonb_build_object(
        'userId', '7b500000-0000-0000-0000-000000000102',
        'stage', 'preflop', 'action', 'call', 'amount', 48
      )
    ),
    '_accepted_post_commit_facts', jsonb_build_object(
      'contributions', jsonb_build_object(
        '7b500000-0000-0000-0000-000000000101', 50,
        '7b500000-0000-0000-0000-000000000102', 50
      ),
      'returned_uncalled', '{}'::jsonb,
      'insurance', '[]'::jsonb
    )
  ),
  jsonb_build_object(
    'version', 1,
    'time_banks', jsonb_agg(jsonb_build_object(
      'user_id', s.user_id,
      'seat_id', s.id,
      'seat_joined_at', s.joined_at,
      'uses_remaining', 2,
      'seconds_remaining', 20
    ) ORDER BY s.user_id),
    'rake', NULL,
    'bbj_contribution', NULL,
    'insurance', '[]'::jsonb,
    'promo_playthrough', '[]'::jsonb,
    'pending_addons', NULL
  )
FROM public.table_seats s
WHERE s.table_id = '7b500000-0000-0000-0000-000000000003'::uuid;

SET LOCAL session_replication_role = origin;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

DO $stage_b_diamond_stale_lease$
DECLARE
  v_before text := pg_temp.stage_b_diamond_current_schema_fingerprint();
  v_after text;
  v_result jsonb;
BEGIN
  BEGIN
    UPDATE public.engine_table_leases
       SET heartbeat_at = clock_timestamp() - interval '10 minutes'
     WHERE table_id = '7b500000-0000-0000-0000-000000000003'::uuid;

    v_result := pg_temp.stage_b_diamond_accept();
    IF v_result->>'reason' IS DISTINCT FROM 'hand_lease_stale' THEN
      RAISE EXCEPTION 'STAGE_B_DIAMOND_STALE_LEASE_ACCEPTED: %', v_result;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = 'ZB501',
      MESSAGE = 'stage_b_expected_stale_lease_rollback';
  EXCEPTION WHEN SQLSTATE 'ZB501' THEN
    NULL;
  END;

  v_after := pg_temp.stage_b_diamond_current_schema_fingerprint();
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_STALE_LEASE_CHANGED_POSTIMAGE: % -> %',
      v_before, v_after;
  END IF;
END;
$stage_b_diamond_stale_lease$;

-- A canonical conflicting history row is the fault injection.  The real
-- accepted-hand authority first settles custody and only then reaches the
-- immutable history boundary; its inner exception block must undo every
-- preceding write and return the atomic refusal without a partial receipt.
SET LOCAL session_replication_role = replica;
INSERT INTO public.hand_history(
  id, table_id, hand_number, game_variant, pot_size, small_blind,
  big_blind, rake_amount, bbj_amount, source, players, winners, actions,
  created_at, started_at
)
VALUES (
  '7b500000-0000-0000-0000-000000000601'::uuid,
  '7b500000-0000-0000-0000-000000000003'::uuid,
  1000002, 'nlh', 100, 1, 2, 0, 0, 'stage-b-fault-injection',
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
  '2026-09-10 08:03:00+00'::timestamptz,
  '2026-09-10 08:03:00+00'::timestamptz
);
SET LOCAL session_replication_role = origin;

DO $stage_b_diamond_history_rollback$
DECLARE
  v_before text := pg_temp.stage_b_diamond_current_schema_fingerprint();
  v_after text;
  v_result jsonb;
BEGIN
  v_result := pg_temp.stage_b_diamond_accept();
  IF v_result->>'reason' IS DISTINCT FROM 'atomic_hand_rolled_back'
     OR v_result->>'error' NOT LIKE
          '%already exists without an atomic commit receipt%' THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_HISTORY_FAULT_DID_NOT_REFUSE_ATOMICALLY: %',
      v_result;
  END IF;

  v_after := pg_temp.stage_b_diamond_current_schema_fingerprint();
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_HISTORY_FAULT_CHANGED_POSTIMAGE: % -> %',
      v_before, v_after;
  END IF;
END;
$stage_b_diamond_history_rollback$;

SET LOCAL session_replication_role = replica;
DELETE FROM public.hand_history
 WHERE id = '7b500000-0000-0000-0000-000000000601'::uuid;
SET LOCAL session_replication_role = origin;

DO $stage_b_diamond_real_acceptance$
DECLARE
  v_result jsonb := pg_temp.stage_b_diamond_accept();
BEGIN
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'replay')::boolean, false) IS TRUE
     OR v_result->>'asset' IS DISTINCT FROM 'diamonds'
     OR COALESCE((v_result->>'post_commit_obligations')::boolean, false)
          IS NOT TRUE THEN
    RAISE EXCEPTION 'STAGE_B_DIAMOND_REAL_HAND_NOT_ACCEPTED: %', v_result;
  END IF;

  IF (SELECT count(*)
        FROM public.poker_diamond_hand_receipts
       WHERE table_id = '7b500000-0000-0000-0000-000000000003'::uuid
         AND hand_number = 1000002) <> 1
     OR (SELECT count(*)
           FROM public.hand_history
          WHERE table_id = '7b500000-0000-0000-0000-000000000003'::uuid
            AND hand_number = 1000002
            AND game_variant = 'nlh'
            AND pot_size = 100
            AND rake_amount = 0
            AND bbj_amount = 0) <> 1
     OR (SELECT count(*)
           FROM public.hand_atomic_commits
          WHERE table_id = '7b500000-0000-0000-0000-000000000003'::uuid
            AND hand_number = 1000002
            AND post_commit_request_hash IS NOT NULL
            AND post_commit_payload_hash IS NOT NULL) <> 1
     OR (SELECT count(*)
           FROM public.hand_projection_outbox
          WHERE table_id = '7b500000-0000-0000-0000-000000000003'::uuid
            AND hand_number = 1000002) <> 1 THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_ACCEPTED_HAND_RECEIPT_HISTORY_OUTBOX_NOT_EXACT';
  END IF;

  IF (SELECT count(*)
        FROM public.table_seats s
       WHERE s.table_id = '7b500000-0000-0000-0000-000000000003'::uuid
         AND s.left_at IS NULL
         AND s.time_bank_uses_remaining = 2
         AND s.time_bank_remaining = 20
         AND (
           (s.user_id = '7b500000-0000-0000-0000-000000000101'::uuid
             AND s.stack = 250)
           OR
           (s.user_id = '7b500000-0000-0000-0000-000000000102'::uuid
             AND s.stack = 350)
         )) <> 2
     OR (SELECT count(*)
           FROM public.poker_diamond_custody c
          WHERE c.target_id = '7b500000-0000-0000-0000-000000000003'::uuid
            AND c.state = 'active'
            AND (
              (c.user_id = '7b500000-0000-0000-0000-000000000101'::uuid
                AND c.balance = 250)
              OR
              (c.user_id = '7b500000-0000-0000-0000-000000000102'::uuid
                AND c.balance = 350)
            )) <> 2
     OR (SELECT sum(c.balance)
           FROM public.poker_diamond_custody c
          WHERE c.target_id = '7b500000-0000-0000-0000-000000000003'::uuid
            AND c.state = 'active') IS DISTINCT FROM 600::numeric THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_ACCEPTED_HAND_DID_NOT_CONSERVE_EXACT_CUSTODY';
  END IF;

  IF (SELECT count(*)
        FROM public.diamond_purchase_lots l
       WHERE l.id = '7b500000-0000-0000-0000-000000000211'::uuid
         AND l.consumed = 50
         AND l.arena_reserved = 250
         AND l.issued = 500
         AND l.refunded = 0) <> 1
     OR (SELECT count(*)
           FROM public.poker_diamond_lot_reservations r
          WHERE r.custody_id = '7b500000-0000-0000-0000-000000000401'::uuid
            AND r.lot_id = '7b500000-0000-0000-0000-000000000211'::uuid
            AND r.amount = 300
            AND r.consumed = 50
            AND r.released_at IS NULL) <> 1
     OR (SELECT count(*)
           FROM public.diamond_purchase_lots l
          WHERE l.id = '7b500000-0000-0000-0000-000000000212'::uuid
            AND l.consumed = 0
            AND l.arena_reserved = 300
            AND l.issued = 500
            AND l.refunded = 0) <> 1 THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_ACCEPTED_HAND_DID_NOT_CONSUME_EXACT_PURCHASED_LOSS';
  END IF;
END;
$stage_b_diamond_real_acceptance$;

DO $stage_b_diamond_exact_replay$
DECLARE
  v_before text := pg_temp.stage_b_diamond_current_schema_fingerprint();
  v_after text;
  v_result jsonb;
BEGIN
  v_result := pg_temp.stage_b_diamond_accept();
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'replay')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'STAGE_B_DIAMOND_EXACT_REPLAY_REFUSED: %', v_result;
  END IF;

  v_after := pg_temp.stage_b_diamond_current_schema_fingerprint();
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_EXACT_REPLAY_CHANGED_POSTIMAGE: % -> %',
      v_before, v_after;
  END IF;
END;
$stage_b_diamond_exact_replay$;

DO $stage_b_diamond_release_fixture_lease$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.engine_table_leases
   WHERE table_id = '7b500000-0000-0000-0000-000000000003'::uuid
     AND instance_id = 'stage-b-diamond-current-schema-engine'
     AND lease_generation =
           '7b500000-0000-0000-0000-000000000501'::uuid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION
      'STAGE_B_DIAMOND_FIXTURE_LEASE_CLEANUP_INEXACT: %', v_deleted;
  END IF;
END;
$stage_b_diamond_release_fixture_lease$;

COMMIT;

SELECT 'STAGE_B_DIAMOND_ACCEPTED_HAND_SUCCESS_REPLAY_ROLLBACK_OK';
SELECT 'STAGE_B_DIAMOND_ACCEPTED_HAND_CURRENT_SCHEMA_OK';
