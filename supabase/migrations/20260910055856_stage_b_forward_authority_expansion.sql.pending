-- 20260910042007_stage_b_forward_authority_expansion
--
-- Thirteen historical Stage-B migrations are absent from production while
-- production has continued through the 20260910051447-promoted seat-move hotfix.
-- Replaying those files
-- would mix historical repair DML with runtime authority changes and overwrite
-- newer production definitions. This forward expansion creates only the
-- private receipt and capability schema required by the current postimage,
-- adopting the exact seat-move receipt/capability schema already installed by
-- that hotfix. Committed move receipts are durable history, not repair input.
--
-- It performs no repair, moves no chips, changes no tournament or seat row,
-- arms no authority trigger, and does not alter any object installed by
-- 20260910034411, 20260910034412, 20260910035435 or 20260910051447. The exact repair
-- migration owns every historical preimage row; the final contraction owns
-- the scheduler retirement receipt. Explicit version and byte-exact postimage
-- checks make an out-of-order or stale writer fail at the database edge.

BEGIN;

SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '30s';
SET LOCAL transaction_timeout = '45s';
SET LOCAL ca.break_window_migration_override =
  'Stage-B 20260910042007 runs only inside its enforced :55 stopped-engine freeze; outside that window its authority is absent';

-- The transport exception only admits Supabase's preceding no-op history
-- bootstrap. This transaction proves its own authority before its first
-- durable catalog change. Take the shared maintenance key first, then the
-- canonical realtime/break/engine relation order used by the rest of Stage B.
SELECT pg_advisory_xact_lock_shared(530090,1);

DO $authenticate_stage_b_stopped_engine_authority$
DECLARE
  v_break_relation oid := to_regclass('public.engine_maintenance_break');
  v_predicate oid := to_regprocedure('public.fn_platform_frozen()');
  v_entry_predicate oid :=
    to_regprocedure('public.fn_entry_purchases_frozen()');
  v_writer oid :=
    to_regprocedure('public.fn_serialize_engine_maintenance_break_write()');
  v_relation_owner oid;
BEGIN
  IF v_break_relation IS NULL OR v_predicate IS NULL
     OR v_entry_predicate IS NULL OR v_writer IS NULL THEN
    RAISE EXCEPTION 'Stage-B stopped-engine authority is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relowner INTO STRICT v_relation_owner
    FROM pg_class c WHERE c.oid = v_break_relation;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_predicate
       AND md5(p.prosrc) = '112b1265824ee082b8adc67ea367d826'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_entry_predicate
       AND md5(p.prosrc) = 'a29498531e4b7d3889532e80fafc8d57'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_writer
       AND md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'trigger'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'Stage-B durable platform freeze authority is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid = v_break_relation
       AND tg.tgname = 'aa_serialize_maintenance_break_write'
       AND tg.tgfoid = v_writer
       AND NOT tg.tgisinternal
       AND tg.tgenabled = 'O'
       AND tg.tgtype = 62
       AND tg.tgattr::text = ''
       AND tg.tgqual IS NULL
       AND tg.tgnargs = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'Stage-B maintenance serialization trigger is not canonical'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_stage_b_stopped_engine_authority$;

LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_maintenance_break IN SHARE MODE NOWAIT;
LOCK TABLE public.engine_leader IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_table_leases IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT;

DO $require_stage_b_stopped_engine_authority$
BEGIN
  IF public.fn_platform_frozen() IS NOT TRUE
     OR public.fn_entry_purchases_frozen() IS NOT TRUE
     OR (
       SELECT count(*)
         FROM public.engine_maintenance_break b
        WHERE b.id
          AND b.enforce_freeze
          AND b.phase = 'counting_down'
          AND b.break_started_at IS NOT NULL
          AND b.break_started_at >= b.announced_at
          AND b.break_ends_at > b.break_started_at
          AND b.break_ends_at < b.announced_at + interval '15 minutes'
          AND b.break_ends_at >= clock_timestamp() + interval '3 minutes'
     ) <> 1 THEN
    RAISE EXCEPTION
      'Stage-B expansion requires an authenticated counting-down freeze with three minutes of headroom'
      USING ERRCODE = '55006';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.engine_leader l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) OR EXISTS (
       SELECT 1 FROM public.engine_table_leases l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) OR EXISTS (
       SELECT 1 FROM public.engine_tournament_leases l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) THEN
    RAISE EXCEPTION 'Stage-B expansion requires every engine authority heartbeat to be stale'
      USING ERRCODE = '55006';
  END IF;
END;
$require_stage_b_stopped_engine_authority$;

DO $require_current_postimage_and_clean_expansion$
DECLARE
  v_relation text;
BEGIN
  IF to_regprocedure(
       'public.trg_lock_and_validate_tournament_live_seat()'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_active_maintenance_release_boundary()'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_lock_settlement_lane_global()'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_share_settlement_lane_for_table(uuid)'
     ) IS NULL
     OR to_regclass(
       'public.idx_cash_seat_moves_cancelled_player'
     ) IS NULL
     OR to_regclass('public.idx_tables_cluster_open') IS NULL
     OR to_regclass(
       'public.idx_tables_cluster_closed_status_drift'
     ) IS NULL
     OR to_regclass('public.idx_tournaments_updated_at') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = 'tournaments'
          AND p.policyname = 'poker_arena_tournament_access'
          AND p.roles = ARRAY['authenticated']::name[]
     ) THEN
    RAISE EXCEPTION
      'Stage-B expansion requires the through-20260910035435 production postimage'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid =
          'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure
          AND md5(p.prosrc) = '8b8cf19c75a21fb898f559ac5d73f422'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid =
          'public.fn_ca_lock_settlement_lane_global()'::regprocedure
          AND md5(p.prosrc) = '343015440ea5c84ee4ca7ae583c73d30'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid =
          'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure
          AND md5(p.prosrc) = '3acb4c1d763181905cf5b64287f8f28f'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid =
          'public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure
          AND md5(p.prosrc) = '006d78a441e65d000d1d78929649bb44'
     ) THEN
    RAISE EXCEPTION
      'Stage-B expansion found drift in the 034412 spin or 035435 settlement-lane postimage'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('fn_ca_lock_tournament_seat_acquisition', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_register_horse_for_tournament_before_terminal_gate', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_ca_register_for_tournament_with_ticket_for', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('process_tournament_rebuy', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_ca_unregister_tournament_player_exact', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_collect_bounty', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_mystery_bounty_reserve', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_sweep_pending_tournament_bounties', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('atomic_cancel_tournament', 'fn_ca_lock_settlement_lane_global'),
          ('fn_award_satellite_seat', 'fn_ca_lock_settlement_lane_global'),
          ('fn_backpay_unfinalised_bounty_pools', 'fn_ca_lock_settlement_lane_global'),
          ('fn_ca_return_satellite_entitlement_as_ticket', 'fn_ca_lock_settlement_lane_global'),
          ('fn_close_managed_game', 'fn_ca_lock_settlement_lane_global'),
          ('fn_complete_tournament_terminal', 'fn_ca_lock_settlement_lane_global'),
          ('fn_deliver_satellite_ticket_exact', 'fn_ca_lock_settlement_lane_global'),
          ('fn_execute_managed_game_command', 'fn_ca_lock_settlement_lane_global'),
          ('fn_finalize_bounty_pool', 'fn_ca_lock_settlement_lane_global'),
          ('fn_mystery_bounty_pay', 'fn_ca_lock_settlement_lane_for_tournament'),
          ('fn_mystery_bounty_settle', 'fn_ca_lock_settlement_lane_global'),
          ('fn_resolve_satellite_settlement_outcome', 'fn_ca_lock_settlement_lane_global'),
          ('fn_resolve_tournament_terminal_outcome', 'fn_ca_lock_settlement_lane_global'),
          ('fn_settle_final_table_deal_atomic', 'fn_ca_lock_settlement_lane_global'),
          ('fn_settle_satellite_finish_atomic', 'fn_ca_lock_settlement_lane_global'),
          ('fn_settle_satellite_tournament_pre_money_path_gate', 'fn_ca_lock_settlement_lane_global'),
          ('fn_settle_tournament_final_table_deal', 'fn_ca_lock_settlement_lane_global'),
          ('fn_settle_tournament_places', 'fn_ca_lock_settlement_lane_global'),
          ('fn_settle_tournament_rake', 'fn_ca_lock_settlement_lane_global'),
          ('fn_sweep_unsettled_tournament_rake', 'fn_ca_lock_settlement_lane_global'),
          ('fn_ca_commit_hand_settlement', 'fn_ca_share_settlement_lane_for_table'),
          ('fn_ca_commit_hand_settlement_before_lease_generation', 'fn_ca_share_settlement_lane_for_table')
      ) required(function_name, helper_name)
      LEFT JOIN pg_proc p
        ON p.proname = required.function_name
       AND p.pronamespace = 'public'::regnamespace
     GROUP BY required.function_name, required.helper_name
    HAVING count(p.oid) <> 1
       OR bool_or(p.prosrc NOT LIKE '%' || required.helper_name || '%')
  ) THEN
    RAISE EXCEPTION
      'Stage-B expansion found an incomplete or drifted 30-function settlement-lane postimage'
      USING ERRCODE = '55000';
  END IF;

  -- The incident hotfix is now a required predecessor. Stage B adopts its
  -- two private tables and immutable receipt history in place; it must never
  -- drop/recreate them or confuse committed receipts with stale repair data.
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL
     OR (SELECT count(*)
           FROM supabase_migrations.schema_migrations m
          WHERE m.version='20260910051447'
            AND m.name='the_seat_move_door_the_engine_calls_exists'
            AND cardinality(m.statements)=1
            AND encode(
                  extensions.digest(m.statements[1],'sha256'),'hex'
                )='b3f1bb62152627444b33c82b806c00ba3587aeebbe3d13800faf69fae7809ea2'
        )<>1
     OR to_regclass('public.tournament_seat_exit_authorizations') IS NULL
     OR to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure(
          'public.fn_tournament_seat_move_receipts_append_only()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_tournament_seat_move_receipt(uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B expansion requires the exact 20260910051447 seat-move hotfix ledger and catalog preimage'
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(
           required.identity||'='||catalog.fingerprint,', '
           ORDER BY required.identity)
    INTO v_relation
    FROM (VALUES
      ('public.tournament_seat_exit_authorizations',
       '556029bd3b99e8bb0ef36db2a28ed862'),
      ('public.tournament_seat_move_receipts',
       'd13f29c5d5a781fe2a7f834673ecc820')
    ) required(identity,expected_fingerprint)
    JOIN pg_class c ON c.oid=to_regclass(required.identity)
    CROSS JOIN LATERAL (
      SELECT md5(jsonb_build_object(
               'shape',(
                 SELECT jsonb_agg(
                          a.attname||':'||
                          format_type(a.atttypid,a.atttypmod)||':'||
                          CASE WHEN a.attnotnull
                            THEN 'not-null' ELSE 'nullable' END
                          ORDER BY a.attnum)
                   FROM pg_attribute a
                  WHERE a.attrelid=c.oid
                    AND a.attnum>0 AND NOT a.attisdropped),
               'constraints',(
                 SELECT jsonb_agg(
                          jsonb_build_object(
                            'type',k.contype::text,
                            'def',pg_get_constraintdef(k.oid,true),
                            'validated',k.convalidated,
                            'deferrable',k.condeferrable,
                            'deferred',k.condeferred,
                            'no_inherit',k.connoinherit,
                            'index_valid',i.indisvalid,
                            'index_ready',i.indisready)
                          ORDER BY k.contype::text||':'||
                                   pg_get_constraintdef(k.oid,true))
                   FROM pg_constraint k
                   LEFT JOIN pg_index i
                     ON i.indexrelid=NULLIF(k.conindid,0)
                  WHERE k.conrelid=c.oid),
               'rls',c.relrowsecurity,
               'force_rls',c.relforcerowsecurity,
               'owner',c.relowner::regrole::text,
               'acl',c.relacl::text,
               'policy_count',(
                 SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)
             )::text) AS fingerprint
    ) catalog
   WHERE catalog.fingerprint<>required.expected_fingerprint;

  IF v_relation IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage-B expansion found drift in a 20260910051447 seat-move table: %',
      v_relation
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.fn_tournament_seat_move_receipts_append_only()',
         '85534593874dc5d908193ccbfc309719','plpgsql','v','trigger',
         0,ARRAY['search_path=public']::text[],'{postgres=X/postgres}'),
        ('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
         '0f491a45693fcf3182719647c5ed7aee','plpgsql','v','uuid',
         1,ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres}'),
        ('public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)',
         '0811b7a7795234ed8bc84c606d9a5a62','plpgsql','v','integer',
         1,ARRAY['search_path=public']::text[],'{postgres=X/postgres}'),
        ('public.fn_ca_tournament_seat_move_receipt(uuid)',
         '68813ee03e355e2eec053e15bf40f98d','sql','s','jsonb',
         0,ARRAY['search_path=public']::text[],'{postgres=X/postgres}'),
        ('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
         '466c39065b59cf7922a5859df9f26bd3','plpgsql','v','jsonb',
         0,ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
         '{postgres=X/postgres,service_role=X/postgres}'),
        ('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
         'f00ad0e9a08496d96f6375cbf6f30678','plpgsql','v','jsonb',
         0,ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
         '{postgres=X/postgres,service_role=X/postgres}')
      ) required(identity,source_md5,language_name,volatility,return_type,
                 argument_defaults,configuration,acl)
      LEFT JOIN pg_proc p ON p.oid=to_regprocedure(required.identity)
      LEFT JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid IS NULL
        OR md5(p.prosrc)<>required.source_md5
        OR l.lanname<>required.language_name
        OR p.provolatile::text<>required.volatility
        OR p.prorettype::regtype::text<>required.return_type
        OR p.proowner<>'postgres'::regrole
        OR NOT p.prosecdef
        OR p.pronargdefaults<>required.argument_defaults
        OR p.proconfig IS DISTINCT FROM required.configuration
        OR p.proacl::text IS DISTINCT FROM required.acl
  ) THEN
    RAISE EXCEPTION
      'Stage-B expansion found drift in a 20260910051447 seat-move function'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*)
        FROM pg_trigger t
       WHERE t.tgrelid='public.tournament_seat_move_receipts'::regclass
         AND t.tgname='tournament_seat_move_receipts_append_only'
         AND t.tgfoid=
               'public.fn_tournament_seat_move_receipts_append_only()'::regprocedure
         AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27
         AND md5(pg_get_triggerdef(t.oid,true))=
               '775ad84910c01ea8632d7df1ab5cbb34')<>1
     OR EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgname='zy_tournament_live_seat_exit_requires_authority'
          AND NOT t.tgisinternal)
     OR to_regprocedure(
          'public.fn_tournament_live_seat_exit_requires_authority()'
        ) IS NOT NULL
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid=
                  'public.tournament_seat_exit_authorizations'::regclass
            AND NOT t.tgisinternal)<>0
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid='public.tournament_seat_move_receipts'::regclass
            AND NOT t.tgisinternal)<>1 THEN
    RAISE EXCEPTION
      'Stage-B expansion found an inexact or live 20260910051447 seat-move capability preimage'
      USING ERRCODE = '55000';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.tournament_seat_exit_authority_cutover',
    'public.tournament_pending_zero_seat_cutover_receipts',
    'public.tournament_paid_candidate_cutover_receipts',
    'public.tournament_positive_orphan_cutover_receipts',
    'public.tournament_mutator_scheduler_retirement_receipts',
    'public.tournament_terminal_break_normalization_receipts'
  ] LOOP
    IF to_regclass(v_relation) IS NOT NULL THEN
      RAISE EXCEPTION
        'Stage-B expansion relation % already exists', v_relation
        USING ERRCODE = '42P07';
    END IF;
  END LOOP;

  IF to_regprocedure(
       'public.fn_tournament_seat_exit_cutover_receipts_append_only()'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_tournament_terminal_break_normalization_receipt_immutable()'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage-B expansion append-only authority already exists'
      USING ERRCODE = '42710';
  END IF;
END;
$require_current_postimage_and_clean_expansion$;

LOCK TABLE public.tournament_seat_exit_authorizations,
           public.tournament_seat_move_receipts
  IN SHARE MODE NOWAIT;

DO $require_quiescent_hotfix_capability$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournament_seat_exit_authorizations) THEN
    RAISE EXCEPTION
      'Stage-B expansion found a live seat-exit authority after taking the hotfix table locks'
      USING ERRCODE='55000';
  END IF;
END;
$require_quiescent_hotfix_capability$;

-- A transaction-local fingerprint makes receipt preservation executable: the
-- expansion below may create only new Stage-B relations and cannot delete,
-- rewrite, or replace any incident-hotfix receipt.
CREATE TEMP TABLE stage_b_move_receipt_preimage
ON COMMIT DROP
AS
SELECT count(*)::bigint AS receipt_count,
       encode(extensions.digest(COALESCE(
         string_agg(
           encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex'),''
           ORDER BY r.request_id),''
       ),'sha256'),'hex') AS receipt_fingerprint
  FROM public.tournament_seat_move_receipts r;

CREATE TABLE public.tournament_seat_exit_authority_cutover (
  authority text PRIMARY KEY
    CHECK (authority='tournament_seat_exit_authority:v1'),
  migration_version text NOT NULL CHECK (migration_version='20260910042020_stage_b_exact_precondition_repairs'),
  installed_at timestamptz NOT NULL,
  repaired_seat_count integer NOT NULL CHECK (repaired_seat_count>=0),
  repaired_seat_ids uuid[] NOT NULL,
  repaired_table_count integer NOT NULL CHECK (repaired_table_count>=0),
  repaired_table_ids uuid[] NOT NULL,
  repaired_roster_count integer NOT NULL CHECK (repaired_roster_count>=0),
  repaired_roster_ids uuid[] NOT NULL,
  repaired_chip_count integer NOT NULL CHECK (repaired_chip_count>=0),
  repaired_chip_roster_ids uuid[] NOT NULL,
  repaired_stakes_count integer NOT NULL CHECK (repaired_stakes_count>=0),
  repaired_stakes_table_ids uuid[] NOT NULL,
  closed_duplicate_table_count integer NOT NULL
    CHECK (closed_duplicate_table_count>=0),
  closed_duplicate_table_ids uuid[] NOT NULL,
  repaired_player_count_count integer NOT NULL
    CHECK (repaired_player_count_count>=0),
  repaired_player_count_tournament_ids uuid[] NOT NULL,
  paid_candidate_count integer NOT NULL CHECK (paid_candidate_count>=0),
  paid_candidate_ids uuid[] NOT NULL,
  positive_orphan_count integer NOT NULL CHECK (positive_orphan_count>=0),
  positive_orphan_seat_ids uuid[] NOT NULL,
  pending_zero_candidate_count integer NOT NULL
    CHECK (pending_zero_candidate_count>=0),
  pending_zero_candidate_ids uuid[] NOT NULL,
  pending_zero_seat_ids uuid[] NOT NULL,
  CHECK (repaired_seat_count=cardinality(repaired_seat_ids)),
  CHECK (repaired_table_count=cardinality(repaired_table_ids)),
  CHECK (repaired_roster_count=cardinality(repaired_roster_ids)),
  CHECK (repaired_chip_count=cardinality(repaired_chip_roster_ids)),
  CHECK (repaired_stakes_count=cardinality(repaired_stakes_table_ids)),
  CHECK (closed_duplicate_table_count=
         cardinality(closed_duplicate_table_ids)),
  CHECK (repaired_player_count_count=
         cardinality(repaired_player_count_tournament_ids)),
  CHECK (paid_candidate_count=cardinality(paid_candidate_ids)),
  CHECK (positive_orphan_count=cardinality(positive_orphan_seat_ids)),
  CHECK (pending_zero_candidate_count=
         cardinality(pending_zero_candidate_ids)),
  CHECK (pending_zero_candidate_count=cardinality(pending_zero_seat_ids)),
  CHECK (array_position(repaired_seat_ids,NULL) IS NULL),
  CHECK (array_position(repaired_table_ids,NULL) IS NULL),
  CHECK (array_position(repaired_roster_ids,NULL) IS NULL),
  CHECK (array_position(repaired_chip_roster_ids,NULL) IS NULL),
  CHECK (array_position(repaired_stakes_table_ids,NULL) IS NULL),
  CHECK (array_position(closed_duplicate_table_ids,NULL) IS NULL),
  CHECK (array_position(repaired_player_count_tournament_ids,NULL) IS NULL),
  CHECK (array_position(paid_candidate_ids,NULL) IS NULL),
  CHECK (array_position(positive_orphan_seat_ids,NULL) IS NULL),
  CHECK (array_position(pending_zero_candidate_ids,NULL) IS NULL),
  CHECK (array_position(pending_zero_seat_ids,NULL) IS NULL)
);

ALTER TABLE public.tournament_seat_exit_authority_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_exit_authority_cutover
  FROM PUBLIC,anon,authenticated,service_role;

-- Exact pending zero generations survived the retired split hand writer with
-- later unpaid chair generations still live. They are neither paid rebuys nor
-- sources from which chips may be reconstructed. Preserve each accepted-hand
-- identity, later chair generation and table count around the one-time vacancy
-- so the correction remains auditable after the engine resolves the seatless
-- candidate.
CREATE TABLE public.tournament_pending_zero_seat_cutover_receipts (
  candidate_id uuid PRIMARY KEY
    REFERENCES public.tournament_knockout_candidates(id) ON DELETE RESTRICT,
  migration_version text NOT NULL CHECK (migration_version='20260910042020_stage_b_exact_precondition_repairs'),
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  roster_id uuid NOT NULL
    REFERENCES public.tournament_players(id) ON DELETE RESTRICT,
  zero_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  zero_seat_id uuid NOT NULL
    REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  zero_seat_joined_at timestamptz NOT NULL,
  zero_hand_number bigint NOT NULL CHECK (zero_hand_number>0),
  zero_hac_hand_id uuid NOT NULL,
  zero_settlement_hand_id uuid NOT NULL,
  zero_committed_at timestamptz NOT NULL,
  roster_chips_before integer NOT NULL CHECK (roster_chips_before=0),
  vacated_table_id uuid NOT NULL
    REFERENCES public.tables(id) ON DELETE RESTRICT,
  vacated_seat_id uuid NOT NULL
    REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  vacated_seat_number integer NOT NULL
    CHECK (vacated_seat_number BETWEEN 1 AND 10),
  vacated_joined_at timestamptz NOT NULL,
  seat_stack_before numeric NOT NULL,
  post_zero_entitlement_count integer NOT NULL
    CHECK (post_zero_entitlement_count=0),
  post_zero_chip_ledger_count integer NOT NULL
    CHECK (post_zero_chip_ledger_count=0),
  post_zero_wallet_transaction_count integer NOT NULL
    CHECK (post_zero_wallet_transaction_count=0),
  post_zero_wallet_idempotency_count integer NOT NULL
    CHECK (post_zero_wallet_idempotency_count=0),
  later_accepted_hand_count integer NOT NULL
    CHECK (later_accepted_hand_count=0),
  table_current_players_before integer,
  table_live_seats_before integer NOT NULL CHECK (table_live_seats_before>0),
  table_current_players_after integer NOT NULL
    CHECK (table_current_players_after>=0),
  table_live_seats_after integer NOT NULL CHECK (table_live_seats_after>=0),
  vacated_at timestamptz NOT NULL,
  CHECK (seat_stack_before::text NOT IN ('NaN','Infinity','-Infinity')),
  CHECK (seat_stack_before>=0 AND seat_stack_before=trunc(seat_stack_before)),
  CHECK (zero_committed_at<=vacated_joined_at),
  CHECK (vacated_joined_at<vacated_at),
  CHECK (table_live_seats_after=table_live_seats_before-1),
  CHECK (table_current_players_after=table_live_seats_after),
  UNIQUE (tournament_id,user_id),
  UNIQUE (vacated_seat_id)
);

-- Every historical inference below names the immutable rows that authorized
-- it. Parallel arrays preserve one-to-one payment order; the hand pair binds
-- the knockout candidate to both independent accepted-hand journals. A row is
-- the complete receipt for one candidate, including whether the repair merely
-- closed history, rotated a still-live chair generation, or restored and
-- seated chips whose paid grant had been erased by the retired reconciler.
-- A reused destination records its complete prior occupant snapshot and the
-- complete post-seat snapshot so no mutable chair field can hide a leak.
CREATE TABLE public.tournament_paid_candidate_cutover_receipts (
  candidate_id uuid PRIMARY KEY
    REFERENCES public.tournament_knockout_candidates(id) ON DELETE RESTRICT,
  migration_version text NOT NULL CHECK (migration_version='20260910042020_stage_b_exact_precondition_repairs'),
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  roster_id uuid NOT NULL
    REFERENCES public.tournament_players(id) ON DELETE RESTRICT,
  candidate_state_before text NOT NULL
    CHECK (candidate_state_before IN ('pending','rebought')),
  candidate_resolved_at_before timestamptz,
  zero_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  zero_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  zero_seat_joined_at timestamptz NOT NULL,
  zero_hand_number bigint NOT NULL CHECK (zero_hand_number>0),
  zero_hac_hand_id uuid NOT NULL,
  zero_settlement_hand_id uuid NOT NULL,
  entitlement_ids uuid[] NOT NULL,
  source_ledger_ids uuid[] NOT NULL,
  source_ledger_chain_seqs bigint[] NOT NULL,
  source_ledger_row_hashes text[] NOT NULL,
  wallet_transaction_ids uuid[] NOT NULL,
  purchase_idempotency_keys text[] NOT NULL,
  purchase_ordinals integer[] NOT NULL,
  purchase_types text[] NOT NULL,
  payment_count integer NOT NULL CHECK (payment_count>0),
  first_paid_at timestamptz NOT NULL,
  last_paid_at timestamptz NOT NULL,
  rebuy_chips integer NOT NULL CHECK (rebuy_chips>0),
  stack_before integer NOT NULL CHECK (stack_before>=0),
  stack_after integer NOT NULL CHECK (stack_after>=0),
  seat_id uuid REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  table_id uuid REFERENCES public.tables(id) ON DELETE RESTRICT,
  seat_number integer CHECK (seat_number BETWEEN 1 AND 10),
  seat_joined_at_before timestamptz,
  seat_joined_at_after timestamptz,
  seat_row_reused boolean,
  destination_seat_id_before uuid
    REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  destination_user_id_before uuid,
  destination_player_id_before integer,
  destination_member_id_before uuid,
  destination_stack_before numeric(15,2),
  destination_is_sitting_out_before boolean,
  destination_is_away_before boolean,
  destination_joined_at_before timestamptz,
  destination_horse_id_before uuid,
  destination_scheduled_leave_hands_before integer,
  destination_left_at_before timestamptz,
  destination_status_before text,
  destination_leave_pending_before boolean,
  destination_auto_rebuy_before boolean,
  destination_time_bank_remaining_before integer,
  destination_time_bank_uses_remaining_before integer,
  destination_club_id_before uuid,
  destination_sit_out_at_before timestamptz,
  destination_entry_hold_before text,
  destination_entry_post_agreed_before boolean,
  seat_player_id integer,
  seat_member_id uuid,
  seat_horse_id uuid,
  seat_club_id uuid,
  seat_is_sitting_out boolean,
  seat_is_away boolean,
  seat_sit_out_at timestamptz,
  seat_scheduled_leave_hands integer,
  seat_left_at timestamptz,
  seat_status text,
  seat_leave_pending boolean,
  seat_auto_rebuy boolean,
  seat_time_bank_remaining integer,
  seat_time_bank_uses_remaining integer,
  seat_entry_hold text,
  seat_entry_post_agreed boolean,
  repair_action text NOT NULL CHECK (repair_action IN (
    'candidate_closed','live_generation_rotated','stranded_stack_seated')),
  repaired_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (first_paid_at<=last_paid_at),
  CHECK (payment_count=cardinality(entitlement_ids)),
  CHECK (payment_count=cardinality(source_ledger_ids)),
  CHECK (payment_count=cardinality(source_ledger_chain_seqs)),
  CHECK (payment_count=cardinality(source_ledger_row_hashes)),
  CHECK (payment_count=cardinality(wallet_transaction_ids)),
  CHECK (payment_count=cardinality(purchase_idempotency_keys)),
  CHECK (payment_count=cardinality(purchase_ordinals)),
  CHECK (payment_count=cardinality(purchase_types)),
  CHECK (array_position(entitlement_ids,NULL) IS NULL),
  CHECK (array_position(source_ledger_ids,NULL) IS NULL),
  CHECK (array_position(source_ledger_chain_seqs,NULL) IS NULL),
  CHECK (array_position(source_ledger_row_hashes,NULL) IS NULL),
  CHECK (array_position(wallet_transaction_ids,NULL) IS NULL),
  CHECK (array_position(purchase_idempotency_keys,NULL) IS NULL),
  CHECK (array_position(purchase_ordinals,NULL) IS NULL),
  CHECK (array_position(purchase_types,NULL) IS NULL),
  CHECK ((candidate_state_before='pending'
           AND candidate_resolved_at_before IS NULL)
      OR (candidate_state_before='rebought'
           AND candidate_resolved_at_before IS NOT NULL)),
  CHECK (purchase_types<@ARRAY['rebuy','reentry']::text[]),
  CHECK ((seat_id IS NULL AND table_id IS NULL AND seat_number IS NULL
          AND seat_joined_at_after IS NULL)
      OR (seat_id IS NOT NULL AND table_id IS NOT NULL
          AND seat_number IS NOT NULL AND seat_joined_at_after IS NOT NULL)),
  CHECK ((repair_action='candidate_closed')
      OR (seat_id IS NOT NULL AND stack_after>0)),
  CHECK (seat_row_reused IS DISTINCT FROM true OR (
    destination_seat_id_before=seat_id
    AND destination_left_at_before IS NOT NULL)),
  CHECK (seat_row_reused IS DISTINCT FROM false OR (
    destination_seat_id_before IS NULL
    AND destination_user_id_before IS NULL
    AND destination_player_id_before IS NULL
    AND destination_member_id_before IS NULL
    AND destination_stack_before IS NULL
    AND destination_is_sitting_out_before IS NULL
    AND destination_is_away_before IS NULL
    AND destination_joined_at_before IS NULL
    AND destination_horse_id_before IS NULL
    AND destination_scheduled_leave_hands_before IS NULL
    AND destination_left_at_before IS NULL
    AND destination_status_before IS NULL
    AND destination_leave_pending_before IS NULL
    AND destination_auto_rebuy_before IS NULL
    AND destination_time_bank_remaining_before IS NULL
    AND destination_time_bank_uses_remaining_before IS NULL
    AND destination_club_id_before IS NULL
    AND destination_sit_out_at_before IS NULL
    AND destination_entry_hold_before IS NULL
    AND destination_entry_post_agreed_before IS NULL)),
  CHECK (repair_action<>'stranded_stack_seated' OR (
    seat_row_reused IS NOT NULL
    AND seat_player_id IS NULL AND seat_member_id IS NULL
    AND seat_club_id IS NOT NULL
    AND seat_is_sitting_out IS FALSE AND seat_is_away IS FALSE
    AND seat_sit_out_at IS NULL AND seat_scheduled_leave_hands IS NULL
    AND seat_left_at IS NULL AND seat_status='active'
    AND seat_leave_pending IS FALSE
    AND seat_auto_rebuy IS FALSE
    AND seat_time_bank_remaining=30 AND seat_time_bank_uses_remaining=4
    AND seat_entry_hold IS NULL AND seat_entry_post_agreed IS FALSE)),
  UNIQUE (tournament_id,user_id,candidate_id)
);

CREATE TABLE public.tournament_positive_orphan_cutover_receipts (
  source_seat_id uuid PRIMARY KEY
    REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  migration_version text NOT NULL CHECK (migration_version='20260910042020_stage_b_exact_precondition_repairs'),
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  roster_id uuid NOT NULL
    REFERENCES public.tournament_players(id) ON DELETE RESTRICT,
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  seat_number integer NOT NULL CHECK (seat_number BETWEEN 1 AND 10),
  stack integer NOT NULL CHECK (stack>0),
  source_joined_at timestamptz NOT NULL,
  source_left_at timestamptz NOT NULL,
  source_status text NOT NULL CHECK (source_status='active'),
  source_player_id integer,
  source_member_id uuid,
  source_horse_id uuid,
  source_club_id uuid,
  source_is_sitting_out boolean,
  source_is_away boolean,
  source_sit_out_at timestamptz,
  source_scheduled_leave_hands integer,
  source_auto_rebuy boolean,
  source_time_bank_remaining integer,
  source_time_bank_uses_remaining integer,
  source_entry_hold text,
  source_entry_post_agreed boolean NOT NULL,
  last_hand_number bigint NOT NULL CHECK (last_hand_number>0),
  last_hac_hand_id uuid NOT NULL,
  last_settlement_hand_id uuid NOT NULL,
  evidence_class text NOT NULL CHECK (evidence_class IN (
    'accepted_hand_no_ko','accepted_hand_after_paid_rebuy')),
  paid_candidate_id uuid
    REFERENCES public.tournament_paid_candidate_cutover_receipts(candidate_id)
    ON DELETE RESTRICT,
  revived_seat_id uuid NOT NULL
    REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  revived_table_id uuid NOT NULL
    REFERENCES public.tables(id) ON DELETE RESTRICT,
  revived_seat_number integer NOT NULL CHECK (revived_seat_number BETWEEN 1 AND 10),
  revived_joined_at timestamptz NOT NULL,
  seat_row_reused boolean NOT NULL,
  destination_seat_id_before uuid
    REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  destination_user_id_before uuid,
  destination_player_id_before integer,
  destination_member_id_before uuid,
  destination_stack_before numeric(15,2),
  destination_is_sitting_out_before boolean,
  destination_is_away_before boolean,
  destination_joined_at_before timestamptz,
  destination_horse_id_before uuid,
  destination_scheduled_leave_hands_before integer,
  destination_left_at_before timestamptz,
  destination_status_before text,
  destination_leave_pending_before boolean,
  destination_auto_rebuy_before boolean,
  destination_time_bank_remaining_before integer,
  destination_time_bank_uses_remaining_before integer,
  destination_club_id_before uuid,
  destination_sit_out_at_before timestamptz,
  destination_entry_hold_before text,
  destination_entry_post_agreed_before boolean,
  revived_player_id integer,
  revived_member_id uuid,
  revived_horse_id uuid,
  revived_club_id uuid,
  revived_is_sitting_out boolean NOT NULL,
  revived_is_away boolean NOT NULL,
  revived_sit_out_at timestamptz,
  revived_scheduled_leave_hands integer,
  revived_left_at timestamptz,
  revived_status text NOT NULL,
  revived_leave_pending boolean NOT NULL,
  revived_auto_rebuy boolean NOT NULL,
  revived_time_bank_remaining integer,
  revived_time_bank_uses_remaining integer,
  revived_entry_hold text,
  revived_entry_post_agreed boolean NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (source_joined_at<source_left_at),
  CHECK (source_left_at<revived_joined_at),
  CHECK ((evidence_class='accepted_hand_no_ko' AND paid_candidate_id IS NULL)
      OR (evidence_class='accepted_hand_after_paid_rebuy'
           AND paid_candidate_id IS NOT NULL)),
  CHECK (seat_row_reused IS DISTINCT FROM true OR (
    destination_seat_id_before=revived_seat_id
    AND destination_left_at_before IS NOT NULL)),
  CHECK (seat_row_reused IS DISTINCT FROM false OR (
    destination_seat_id_before IS NULL
    AND destination_user_id_before IS NULL
    AND destination_player_id_before IS NULL
    AND destination_member_id_before IS NULL
    AND destination_stack_before IS NULL
    AND destination_is_sitting_out_before IS NULL
    AND destination_is_away_before IS NULL
    AND destination_joined_at_before IS NULL
    AND destination_horse_id_before IS NULL
    AND destination_scheduled_leave_hands_before IS NULL
    AND destination_left_at_before IS NULL
    AND destination_status_before IS NULL
    AND destination_leave_pending_before IS NULL
    AND destination_auto_rebuy_before IS NULL
    AND destination_time_bank_remaining_before IS NULL
    AND destination_time_bank_uses_remaining_before IS NULL
    AND destination_club_id_before IS NULL
    AND destination_sit_out_at_before IS NULL
    AND destination_entry_hold_before IS NULL
    AND destination_entry_post_agreed_before IS NULL)),
  CHECK (revived_player_id IS NULL AND revived_member_id IS NULL),
  CHECK (revived_horse_id IS NOT DISTINCT FROM source_horse_id),
  CHECK (revived_club_id IS NOT NULL),
  CHECK (revived_is_sitting_out IS FALSE AND revived_is_away IS FALSE),
  CHECK (revived_sit_out_at IS NULL
         AND revived_scheduled_leave_hands IS NULL),
  CHECK (revived_left_at IS NULL AND revived_status='active'
         AND revived_leave_pending IS FALSE),
  CHECK (revived_auto_rebuy IS FALSE),
  CHECK (revived_time_bank_remaining
           IS NOT DISTINCT FROM source_time_bank_remaining),
  CHECK (revived_time_bank_uses_remaining
           IS NOT DISTINCT FROM source_time_bank_uses_remaining),
  CHECK (revived_entry_hold IS NULL
         AND revived_entry_post_agreed IS FALSE),
  UNIQUE (tournament_id,user_id),
  UNIQUE (revived_seat_id)
);

ALTER TABLE public.tournament_paid_candidate_cutover_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_positive_orphan_cutover_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_pending_zero_seat_cutover_receipts
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_pending_zero_seat_cutover_receipts,
                    public.tournament_paid_candidate_cutover_receipts,
                    public.tournament_positive_orphan_cutover_receipts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION
  public.fn_tournament_seat_exit_cutover_receipts_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $cutover_receipts_append_only$
BEGIN
  RAISE EXCEPTION 'tournament seat-exit cutover receipts are append-only'
    USING ERRCODE='55000';
END;
$cutover_receipts_append_only$;

REVOKE ALL ON FUNCTION
  public.fn_tournament_seat_exit_cutover_receipts_append_only()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER tournament_paid_candidate_cutover_receipts_append_only
  BEFORE UPDATE OR DELETE
  ON public.tournament_paid_candidate_cutover_receipts
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_seat_exit_cutover_receipts_append_only();

CREATE TRIGGER tournament_positive_orphan_cutover_receipts_append_only
  BEFORE UPDATE OR DELETE
  ON public.tournament_positive_orphan_cutover_receipts
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_seat_exit_cutover_receipts_append_only();

CREATE TRIGGER tournament_pending_zero_seat_cutover_receipts_append_only
  BEFORE UPDATE OR DELETE
  ON public.tournament_pending_zero_seat_cutover_receipts
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_seat_exit_cutover_receipts_append_only();

CREATE TABLE public.tournament_mutator_scheduler_retirement_receipts (
  migration_version text PRIMARY KEY
    CHECK (migration_version='20260910042112_stage_b_current_postimage_contraction'),
  captured_at timestamptz NOT NULL,
  job_ids bigint[] NOT NULL
    CHECK (cardinality(job_ids)=2 AND array_position(job_ids,NULL) IS NULL),
  jobs jsonb NOT NULL
    CHECK (jsonb_typeof(jobs)='array' AND jsonb_array_length(jobs)=2)
);

ALTER TABLE public.tournament_mutator_scheduler_retirement_receipts
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.tournament_mutator_scheduler_retirement_receipts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.tournament_terminal_break_normalization_receipts (
  tournament_id uuid PRIMARY KEY,
  terminal_status text NOT NULL CHECK (upper(terminal_status) IN ('COMPLETED','CANCELLED')),
  on_break_before boolean NOT NULL,
  break_started_at_before timestamptz,
  break_ends_at_before timestamptz,
  normalization_version text NOT NULL
    CHECK (normalization_version = '20260910042020_stage_b_exact_precondition_repairs'),
  normalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    on_break_before
    OR break_started_at_before IS NOT NULL
    OR break_ends_at_before IS NOT NULL
  )
);

ALTER TABLE public.tournament_terminal_break_normalization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_terminal_break_normalization_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_terminal_break_normalization_receipts
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tournament_terminal_break_normalization_receipts IS
  'Private immutable terminal-break preimages owned by the 20260910042020 exact repair boundary. No runtime writer exists.';

CREATE FUNCTION public.fn_tournament_terminal_break_normalization_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'terminal tournament break normalization receipts are immutable'
    USING ERRCODE='check_violation';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_terminal_break_normalization_receipt_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_terminal_break_normalization_receipt_immutable
BEFORE UPDATE OR DELETE ON public.tournament_terminal_break_normalization_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_terminal_break_normalization_receipt_immutable();


DO $verify_expansion$
DECLARE
  v_relation text;
  v_has_rows boolean;
  v_trigger_count integer;
  v_receipt_count bigint;
  v_receipt_fingerprint text;
  v_expected_receipt_count bigint;
  v_expected_receipt_fingerprint text;
BEGIN
  SELECT count(*)::integer
    INTO v_trigger_count
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND (
       (t.tgrelid =
          'public.tournament_paid_candidate_cutover_receipts'::regclass
        AND t.tgname =
          'tournament_paid_candidate_cutover_receipts_append_only')
       OR
       (t.tgrelid =
          'public.tournament_positive_orphan_cutover_receipts'::regclass
        AND t.tgname =
          'tournament_positive_orphan_cutover_receipts_append_only')
       OR
       (t.tgrelid =
          'public.tournament_pending_zero_seat_cutover_receipts'::regclass
        AND t.tgname =
          'tournament_pending_zero_seat_cutover_receipts_append_only')
       OR
       (t.tgrelid = 'public.tournament_seat_move_receipts'::regclass
        AND t.tgname = 'tournament_seat_move_receipts_append_only')
       OR
       (t.tgrelid =
          'public.tournament_terminal_break_normalization_receipts'::regclass
        AND t.tgname =
          'tournament_terminal_break_normalization_receipt_immutable')
     );

  IF v_trigger_count <> 5 THEN
    RAISE EXCEPTION
      'Stage-B expansion expected five immutable receipt triggers, found %',
      v_trigger_count
      USING ERRCODE = '55000';
  END IF;

  SELECT p.receipt_count,p.receipt_fingerprint
    INTO STRICT v_expected_receipt_count,v_expected_receipt_fingerprint
    FROM pg_temp.stage_b_move_receipt_preimage p;
  SELECT count(*)::bigint,
         encode(extensions.digest(COALESCE(
           string_agg(
             encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex'),''
             ORDER BY r.request_id),''
         ),'sha256'),'hex')
    INTO v_receipt_count,v_receipt_fingerprint
    FROM public.tournament_seat_move_receipts r;
  IF v_receipt_count IS DISTINCT FROM v_expected_receipt_count
     OR v_receipt_fingerprint IS DISTINCT FROM
          v_expected_receipt_fingerprint THEN
    RAISE EXCEPTION
      'Stage-B expansion changed an immutable seat-move receipt preimage'
      USING ERRCODE = '55000';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'tournament_seat_exit_authority_cutover',
    'tournament_pending_zero_seat_cutover_receipts',
    'tournament_paid_candidate_cutover_receipts',
    'tournament_positive_orphan_cutover_receipts',
    'tournament_seat_exit_authorizations',
    'tournament_mutator_scheduler_retirement_receipts',
    'tournament_terminal_break_normalization_receipts'
  ] LOOP
    IF has_table_privilege(
         'service_role', format('public.%I', v_relation), 'SELECT'
       )
       OR has_table_privilege(
         'service_role', format('public.%I', v_relation), 'INSERT'
       )
       OR has_table_privilege(
         'service_role', format('public.%I', v_relation), 'UPDATE'
       )
       OR has_table_privilege(
         'service_role', format('public.%I', v_relation), 'DELETE'
       ) THEN
      RAISE EXCEPTION
        'service_role retains access to private Stage-B relation %',
        v_relation
        USING ERRCODE = '55000';
    END IF;

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I)',
      v_relation
    ) INTO v_has_rows;
    IF v_has_rows THEN
      RAISE EXCEPTION
        'Stage-B schema expansion unexpectedly wrote relation %',
        v_relation
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$verify_expansion$;

COMMIT;
