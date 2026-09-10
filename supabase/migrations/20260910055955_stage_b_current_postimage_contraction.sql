-- 20260910042112_stage_b_current_postimage_contraction
--
-- Thirteen historical Stage-B files were developed against older production
-- postimages and never applied. Replaying them now would expose unsafe
-- intermediate authority, overwrite later live fixes, and split one scheduler
-- retirement across transactions. This forward-only boundary composes their
-- final contract over the measured catalog state through the byte-authenticated
-- 20260910063559 and 20260910064701 lease-heartbeat repairs. In particular,
-- this contraction may never reinstall a lease-row FOR SHARE fence that makes
-- a busy tournament manager starve its own heartbeat.
--
-- The engine must be stopped and the same durable maintenance freeze and host
-- deployment mutex remain held across all six Stage-B boundaries. This single
-- database transaction installs the final seat, tournament-manager, settlement,
-- exact-generation, and movement authorities; retires the legacy mutation
-- schedules while holding their own advisory locks; and fails closed on every
-- unknown source, ACL, dependency, row shape, or postimage hash.
--
-- The felt-aware absent-player implementation is intentionally retained
-- owner-only and unreachable: production's later 20260910002804 fix is a
-- correct forensic implementation, while its cron, detector, API grants, and
-- generic runtime authority are removed. No retry daemon, cron replacement,
-- reconciliation loop, or wallet mutation is introduced here.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '150s';
SET LOCAL ca.break_window_migration_override = 'Stage-B 20260910042112 runs only inside its enforced :55 stopped-engine freeze; outside that window its authority is absent';

-- A committed stopped-engine proof cannot authorize this transaction. Take the
-- terminal root and durable maintenance key again, authenticate the platform
-- freeze writer, then close the global realtime/maintenance/engine relation
-- order before inspecting a receipt or replacing any runtime authority.
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
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
DECLARE
  v_database_is_pristine boolean;
BEGIN
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) INTO v_database_is_pristine;

  IF NOT v_database_is_pristine
     AND (
       public.fn_platform_frozen() IS NOT TRUE
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
       ) <> 1
     ) THEN
    RAISE EXCEPTION
      'Stage-B boundary requires an authenticated counting-down freeze with three minutes of headroom'
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
    RAISE EXCEPTION 'Stage-B boundary requires every engine authority heartbeat to be stale'
      USING ERRCODE = '55006';
  END IF;
END;
$require_stage_b_stopped_engine_authority$;

-- #1's receipt proof ended with #1's transaction. Reacquire a writer-blocking
-- table lock at this final-authority boundary and snapshot the complete dynamic
-- preimage before replacing any seat-move function. No production count is
-- pinned: every receipt that exists when #5 begins must exist byte-for-byte
-- when #5 commits.
DO $require_move_receipt_preimage$
BEGIN
  IF to_regclass('public.tournament_seat_exit_authorizations') IS NULL
     OR to_regclass('public.tournament_seat_move_receipts') IS NULL THEN
    RAISE EXCEPTION
      'Stage-B contraction requires both adopted seat-move hotfix tables'
      USING ERRCODE='55000';
  END IF;
END;
$require_move_receipt_preimage$;

LOCK TABLE public.tournament_seat_exit_authorizations,
           public.tournament_seat_move_receipts
  IN SHARE MODE NOWAIT;

DO $require_quiescent_move_capability$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournament_seat_exit_authorizations) THEN
    RAISE EXCEPTION
      'Stage-B contraction found a live seat-exit authority after taking the hotfix table locks'
      USING ERRCODE='55000';
  END IF;
END;
$require_quiescent_move_capability$;

CREATE TEMP TABLE stage_b_contraction_move_receipt_preimage
ON COMMIT DROP
AS
SELECT count(*)::bigint AS receipt_count,
       encode(extensions.digest(COALESCE(
         string_agg(
           encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex'),''
           ORDER BY r.request_id),''
       ),'sha256'),'hex') AS receipt_fingerprint
  FROM public.tournament_seat_move_receipts r;

-- This migration is composed over the 20260910173147 per-tournament lane
-- refinement. Authenticate the scoped
-- settlement-lane primitives before replacing any runtime function: accepting
-- a missing, privileged, or drifted helper would silently restore the global
-- hand convoy that stopped lease renewal on the live fleet.
DO $require_scoped_settlement_lane_postimage$
DECLARE
  v_global oid := to_regprocedure(
    'public.fn_ca_lock_settlement_lane_global()');
  v_tournament oid := to_regprocedure(
    'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)');
  v_hand oid := to_regprocedure(
    'public.fn_ca_share_settlement_lane_for_table(uuid)');
  v_postgres oid := 'postgres'::regrole;
  v_service_role oid := 'service_role'::regrole;
BEGIN
  IF v_global IS NULL OR v_tournament IS NULL OR v_hand IS NULL THEN
    RAISE EXCEPTION
      'Stage-B contraction requires the 20260910035435 scoped settlement lane';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=v_global
          AND md5(p.prosrc)='343015440ea5c84ee4ca7ae583c73d30'
          AND NOT p.prosecdef AND NOT p.proretset
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
          AND p.proowner=v_postgres
          AND p.prorettype='void'::regtype
          AND p.pronargs=0 AND p.pronargdefaults=0
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
          AND l.lanname='plpgsql')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=v_tournament
          AND md5(p.prosrc)='3acb4c1d763181905cf5b64287f8f28f'
          AND NOT p.prosecdef AND NOT p.proretset
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
          AND p.proowner=v_postgres
          AND p.prorettype='void'::regtype
          AND p.pronargs=2 AND p.pronargdefaults=1
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
          AND l.lanname='plpgsql')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=v_hand
          AND md5(p.prosrc)='006d78a441e65d000d1d78929649bb44'
          AND NOT p.prosecdef AND NOT p.proretset
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
          AND p.proowner=v_postgres
          AND p.prorettype='void'::regtype
          AND p.pronargs=1 AND p.pronargdefaults=0
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
          AND l.lanname='plpgsql') THEN
    RAISE EXCEPTION 'scoped settlement-lane helper postimage drifted';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_proc p
         LEFT JOIN LATERAL aclexplode(p.proacl) acl ON true
        WHERE p.oid IN (v_global,v_tournament,v_hand)
        GROUP BY p.oid
       HAVING count(acl.grantee)<>2
          OR count(*) FILTER (
               WHERE acl.grantor=v_postgres
                 AND acl.grantee=v_postgres
                 AND acl.privilege_type='EXECUTE'
                 AND NOT acl.is_grantable)<>1
          OR count(*) FILTER (
               WHERE acl.grantor=v_postgres
                 AND acl.grantee=v_service_role
                 AND acl.privilege_type='EXECUTE'
                 AND NOT acl.is_grantable)<>1) THEN
    RAISE EXCEPTION 'scoped settlement-lane helper ACL widened';
  END IF;
END;
$require_scoped_settlement_lane_postimage$;

-- The live ledger advanced after this contraction was prepared. Authenticate
-- the exact inert Phase-Three expansion before replacing any of its callees,
-- and reuse the same proof at the final transaction boundary. Keeping this in
-- pg_temp avoids adding another durable runtime or reconciliation surface.
CREATE OR REPLACE FUNCTION pg_temp.assert_stage_b_phase_three_125453_postimage()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public','extensions','pg_temp'
AS $assert_phase_three_125453$
DECLARE
  v_count integer;
  v_bad integer;
BEGIN
  SELECT count(*)::integer INTO v_count
    FROM supabase_migrations.schema_migrations m
   WHERE m.version='20260910125453'
     AND m.name='phase_three_versioned_final_deal_expansion'
     AND cardinality(m.statements)=1
     AND octet_length(m.statements[1])=45658
     AND encode(
           extensions.digest(convert_to(m.statements[1],'UTF8'),'sha256'),
           'hex'
         )='6a122c52afea42df937c9f41e6845c49362d783beb1fdcd375a6b8aa402ab636';
  IF v_count<>1 THEN
    RAISE EXCEPTION
      'Stage-B requires the byte-exact 20260910125453 Phase-Three expansion'
      USING ERRCODE='55000';
  END IF;

  WITH expected(
    identity,definition_md5,source_md5,language_name,security_definer,
    volatility,return_type,nargs,argdefaults,configuration,granted_role,
    acl_entries
  ) AS (
    VALUES
      ('public.fn_begin_tournament_deal_review(uuid,uuid)',
       '38ef591da01466c0a69a2e43e41ef218','5f4e9ba1a3adcc84fcf62b3e22253b25',
       'plpgsql',true,'v','jsonb',2,0,
       ARRAY['search_path=public, pg_temp']::text[],'service_role',2),
      ('public.fn_ca_tournament_deal_hand_revision(uuid)',
       '0f3792bef9717828edffe96fb7ad1b74','1af5fcc1e105b514e6d9998fac7c46fc',
       'sql',true,'s','text',1,0,
       ARRAY['search_path=public, pg_temp']::text[],NULL::text,1),
      ('public.fn_ca_tournament_deal_proposals_active()',
       'abd816b6cb742e9706953052eed1dcc8','6fa3e31adb6fa1ff7c7564d70cb9f62a',
       'sql',false,'s','boolean',0,0,
       ARRAY['search_path=public, pg_temp']::text[],NULL::text,1),
      ('public.fn_ca_tournament_deal_review_result(uuid,uuid,uuid)',
       'cf149f21926c50a03f21c6a854f075d2','6f266e527ecd674ab4aeccfe72305a52',
       'plpgsql',true,'v','jsonb',3,1,
       ARRAY['search_path=public, pg_temp']::text[],NULL::text,1),
      ('public.fn_ca_tournament_deal_snapshot(uuid)',
       '42cc7f84771a104957d2429311e983cb','6eee1f2e33f6a62bbc0dd59086c98c1c',
       'plpgsql',true,'v','jsonb',1,0,
       ARRAY['search_path=public, extensions, pg_temp','TimeZone=UTC']::text[],
       NULL::text,1),
      ('public.fn_cancel_tournament_deal_review(uuid,uuid,uuid)',
       'b9f41b13612f793729a9409511fea48f','036efbd357a591f69e5727b790b87cd8',
       'plpgsql',true,'v','jsonb',3,0,
       ARRAY['search_path=public, pg_temp']::text[],'authenticated',2),
      ('public.fn_cast_tournament_deal_vote(uuid,uuid,uuid)',
       '69b11537b8bdb96dfb90cc783cffad3c','fdf96aac6d5d5e089b92638aa48fb49f',
       'plpgsql',true,'v','jsonb',3,0,
       ARRAY['search_path=public, pg_temp']::text[],'authenticated',2),
      ('public.fn_close_tournament_deal_review(uuid,uuid,text)',
       'caf796a4fd545a1c1e68a5c0c1de3af4','27471182d604538bb1a9562871b5870c',
       'plpgsql',true,'v','jsonb',3,0,
       ARRAY['search_path=public, pg_temp']::text[],'service_role',2),
      ('public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)',
       '20a359f0554e5eaaa58dd0ae4be14864','5d796d4b26601b4fe6e1d30b1531c6e2',
       'plpgsql',true,'v','jsonb',5,0,
       ARRAY['search_path=public, pg_temp']::text[],'service_role',2),
      ('public.fn_get_tournament_deal_consensus(uuid)',
       'f799fdcd4c862cbf288dcb03e12a5534','0d2c4b7ac54354ab0501337e0e2364fc',
       'plpgsql',true,'v','jsonb',1,0,
       ARRAY['search_path=public, pg_temp']::text[],'service_role',2),
      ('public.fn_get_tournament_deal_proposal(uuid)',
       'f80c399d809b61af09ea15afcc243059','b9176e96f19f8b76f91e797f21e23334',
       'plpgsql',true,'v','jsonb',1,0,
       ARRAY['search_path=public, pg_temp']::text[],'authenticated',2),
      ('public.fn_get_tournament_deal_review(uuid)',
       '1dcfeb7ee1c3187eb95b9f97a88348fd','9db8d596c585990444b2e15f42e0a4e2',
       'plpgsql',true,'v','jsonb',1,0,
       ARRAY['search_path=public, pg_temp']::text[],'authenticated',2),
      ('public.fn_request_tournament_deal_review(uuid,uuid)',
       '3613e972d0785e1ab253396b684c2c58','48ddc5818b9105059c37151cf78f52ce',
       'plpgsql',true,'v','jsonb',2,0,
       ARRAY['search_path=public, pg_temp']::text[],'authenticated',2),
      ('public.fn_require_exact_final_deal_proposal()',
       '5620064e558543f74406009edee27082','35f32e6768be09006753ba07f994a93b',
       'plpgsql',true,'v','trigger',0,0,
       ARRAY['search_path=public, pg_temp']::text[],NULL::text,1),
      ('public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text)',
       '3b9c4472cf38ac7e622b0fa7b3625c4f','8b9acfb4802f04723d87069607225588',
       'plpgsql',true,'v','jsonb',5,0,
       ARRAY['search_path=public, pg_temp']::text[],'service_role',2),
      ('public.fn_tournament_deal_proposal_is_immutable()',
       '829f49d66f1599f77eee9832d3ce2ec4','1dfcaac9540ad15c6de981c8c443d0bc',
       'plpgsql',false,'v','trigger',0,0,
       ARRAY['search_path=public, pg_temp']::text[],NULL::text,1)
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE p.oid IS NULL
              OR NOT (
                md5(pg_get_functiondef(p.oid))=expected.definition_md5
                AND md5(p.prosrc)=expected.source_md5
                AND p.proowner='postgres'::regrole
                AND l.lanname=expected.language_name
                AND p.prosecdef=expected.security_definer
                AND p.provolatile=expected.volatility::"char"
                AND p.proparallel='u'
                AND NOT p.proisstrict AND NOT p.proleakproof
                AND p.prokind='f' AND NOT p.proretset
                AND p.prorettype=to_regtype(expected.return_type)
                AND p.pronargs=expected.nargs
                AND p.pronargdefaults=expected.argdefaults
                AND p.proconfig=expected.configuration
                AND (
                  SELECT count(*)
                    FROM aclexplode(
                      COALESCE(p.proacl,acldefault('f',p.proowner))) acl
                )=expected.acl_entries
                AND (
                  SELECT count(*)
                    FROM aclexplode(
                      COALESCE(p.proacl,acldefault('f',p.proowner))) acl
                   WHERE acl.grantor=p.proowner
                     AND acl.grantee=p.proowner
                     AND acl.privilege_type='EXECUTE'
                     AND NOT acl.is_grantable
                )=1
                AND (
                  expected.granted_role IS NULL
                  OR (
                    SELECT count(*)
                      FROM aclexplode(
                        COALESCE(p.proacl,acldefault('f',p.proowner))) acl
                     WHERE acl.grantor=p.proowner
                       AND acl.grantee=to_regrole(expected.granted_role)
                       AND acl.privilege_type='EXECUTE'
                       AND NOT acl.is_grantable
                  )=1
                )
              )
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
    LEFT JOIN pg_language l ON l.oid=p.prolang;
  IF v_count<>16 OR v_bad<>0 THEN
    RAISE EXCEPTION
      'Stage-B found % missing or drifted Phase-Three function catalogs',v_bad
      USING ERRCODE='55000';
  END IF;

  WITH expected(identity) AS (
    VALUES
      ('public.tournament_deal_proposals'),
      ('public.tournament_deal_proposal_consents'),
      ('public.tournament_deal_proposal_executions'),
      ('public.tournament_deal_review_policy'),
      ('public.tournament_deal_reviews')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE c.oid IS NULL
              OR c.relkind<>'r'
              OR c.relowner<>'postgres'::regrole
              OR NOT c.relrowsecurity OR c.relforcerowsecurity
              OR c.relacl::text<>'{postgres=arwdDxtm/postgres}'
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_class c ON c.oid=to_regclass(expected.identity);
  IF v_count<>5 OR v_bad<>0 THEN
    RAISE EXCEPTION
      'Stage-B found % missing or drifted Phase-Three relation catalogs',v_bad
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_index i
    JOIN pg_class index_catalog ON index_catalog.oid=i.indexrelid
   WHERE i.indexrelid=to_regclass('public.tournament_deal_one_active_review')
     AND i.indrelid='public.tournament_deal_reviews'::regclass
     AND index_catalog.relowner='postgres'::regrole
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
     AND NOT i.indisprimary AND NOT i.indisexclusion
     AND i.indimmediate AND NOT i.indnullsnotdistinct
     AND i.indnkeyatts=1 AND i.indnatts=1
     AND i.indexprs IS NULL
     AND (
       SELECT array_agg(a.attname::text ORDER BY key_position.ordinality)
         FROM unnest(i.indkey::smallint[]) WITH ORDINALITY
              AS key_position(attnum,ordinality)
         JOIN pg_attribute a
           ON a.attrelid=i.indrelid AND a.attnum=key_position.attnum
     )=ARRAY['tournament_id']::text[]
     AND pg_get_expr(i.indpred,i.indrelid,true)=
         'state = ANY (ARRAY[''requested''::text, ''reviewing''::text])';
  IF v_count<>1 THEN
    RAISE EXCEPTION 'Stage-B Phase-Three active-review index drifted'
      USING ERRCODE='55000';
  END IF;

  WITH expected(trigger_name,relation_identity) AS (
    VALUES
      ('tournament_deal_proposal_is_immutable',
       'public.tournament_deal_proposals'),
      ('tournament_deal_consent_is_immutable',
       'public.tournament_deal_proposal_consents'),
      ('tournament_deal_execution_is_immutable',
       'public.tournament_deal_proposal_executions')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE tg.oid IS NULL
              OR tg.tgfoid<>
                   'public.fn_tournament_deal_proposal_is_immutable()'::regprocedure
              OR tg.tgenabled<>'O' OR tg.tgisinternal OR tg.tgtype<>27
              OR tg.tgattr::text<>'' OR tg.tgqual IS NOT NULL
              OR tg.tgnargs<>0
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_trigger tg
      ON tg.tgrelid=to_regclass(expected.relation_identity)
     AND tg.tgname=expected.trigger_name;
  IF v_count<>3 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_trigger tg
        WHERE tg.tgrelid=ANY(ARRAY[
          'public.tournament_deal_proposals'::regclass::oid,
          'public.tournament_deal_proposal_consents'::regclass::oid,
          'public.tournament_deal_proposal_executions'::regclass::oid,
          'public.tournament_deal_review_policy'::regclass::oid,
          'public.tournament_deal_reviews'::regclass::oid])
          AND NOT tg.tgisinternal
     )<>3 THEN
    RAISE EXCEPTION 'Stage-B Phase-Three immutability trigger catalog drifted'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_trigger tg
        WHERE tg.tgrelid='public.tournament_obligations'::regclass
          AND NOT tg.tgisinternal
          AND (
            tg.tgname='require_exact_final_deal_proposal'
            OR tg.tgfoid=
                 'public.fn_require_exact_final_deal_proposal()'::regprocedure
          )
     ) THEN
    RAISE EXCEPTION
      'Stage-B found the separately gated Phase-Three activation trigger'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM public.tournament_deal_review_policy p
   WHERE p.singleton
     AND p.request_seconds=120
     AND p.consent_seconds=120;
  IF v_count<>1
     OR (SELECT count(*) FROM public.tournament_deal_review_policy)<>1 THEN
    RAISE EXCEPTION 'Stage-B Phase-Three review policy drifted'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_deal_proposals)
     OR EXISTS (SELECT 1 FROM public.tournament_deal_proposal_consents)
     OR EXISTS (SELECT 1 FROM public.tournament_deal_proposal_executions)
     OR EXISTS (SELECT 1 FROM public.tournament_deal_reviews) THEN
    RAISE EXCEPTION 'Stage-B requires an inert zero-row Phase-Three expansion'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM public.ca_money_rpc_registry r
   WHERE r.proname='fn_complete_tournament_terminal_proposal'
     AND r.status='approved'
     AND r.notes=
         'Service-only exact review/proposal wrapper; preserves the native terminal money transaction and binds its durable receipt. Activation and compatible engine adoption are separate gates.'
     AND r.added_at=
         '2026-09-10T12:54:53.650568Z'::timestamptz;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'Stage-B Phase-Three money registry row drifted'
      USING ERRCODE='55000';
  END IF;
END;
$assert_phase_three_125453$;

SELECT pg_temp.assert_stage_b_phase_three_125453_postimage();

-- Production advanced through twenty-eight more byte-authenticated migrations after
-- the Phase-Three expansion. Prove their complete durable postimage before
-- touching any Stage-B authority and again at the transaction boundary. The
-- incident rows closed by three of these migrations are operational history;
-- their identities and timestamps deliberately are not frozen here.
CREATE OR REPLACE FUNCTION pg_temp.assert_stage_b_current_live_tail_174349_postimage()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public','extensions','pg_temp'
AS $assert_current_live_tail_174349$
DECLARE
  v_count integer;
  v_bad integer;
BEGIN
  WITH expected(version,name,statement_bytes,statement_sha256) AS (
    VALUES
      ('20260910130319','restore_rake_attribution_retries',8151,
       'f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c'),
      ('20260910130421','a_revealed_mystery_bounty_may_name_its_own_obligation',6558,
       '2236fdbd5ce9f765dba5e9e5dc2cdb5ae5590f6e3b1f5e5180145b9918b9d400'),
      ('20260910132341','two_nets_that_are_reporting_history_are_answered',6738,
       '94b9bb3b748e6fe65308a4d8e69418e6afc1b3cd4461684ec655e1595bbf45b7'),
      ('20260910132644','the_supply_meter_swing_did_not_repeat_and_the_ledger_balances',5495,
       '4824de6d021b3e3e692aa2c061b9e3cd92bd0fd4909bb443f229d6867ecae680'),
      ('20260910132747','the_break_scorecard_names_why_a_break_never_started',30503,
       '6e21f8eaa025be6a16c13c55e1c691fcd00e0235ec5e6c19fb3f55114d54b413'),
      ('20260910132833','a_maintenance_kind_registered_as_info_is_recorded_not_raised',5510,
       '93b2edc2cc08effd21f00e66d960046c11077fe0c65278f9ec86526fa502a961'),
      ('20260910134429','every_seat_means_every_seat',6589,
       '0a460a25ee1948abf643d3067866f5173cb495b80bd395d9c234422cd140ddea'),
      ('20260910140538','a_detector_does_not_report_what_it_already_answered_for',7356,
       '0fd60dfb93f570c2eb9a718a675fcbc3afdd03d6302688cc99c17eb495074204'),
      ('20260910141101','booked_spin_continuation_preserves_floating_point_rounding',12053,
       '5965e38e5bafa0568b263332ad448d84340ebc4d50317983474f684ef1529e6f'),
      ('20260910143032','a_declared_guard_change_is_recorded_not_raised',10216,
       'b8dcbf1388dda22db434f144da18ef3fcbb5a4842850172704fecd20a86db19f'),
      ('20260910143719','the_guard_declaration_is_not_reachable_from_a_browser',2650,
       '07a00604216e201f811309ab3a07dac65a3f732ef1694e7beeaee40bfd219617'),
      ('20260910145833','a_place_is_not_a_bounty',14907,
       '6a52ae50c80423153705406a0bf855fd8a04baacba0ef155273455c20078c9a4'),
      ('20260910151228','the_door_was_fixed_after_the_manager_stopped_asking',4857,
       '5246718dd1252f257a1fb88c3c8d06ce3812391bc4acb3b47be8db6e4217c1ee'),
      ('20260910154446','the_database_refuses_migrations_inside_the_break_window',20519,
       '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082'),
      ('20260910154537','the_busts_the_door_can_now_accept_are_recorded',7080,
       '2cf00803afc5bc6dc14cf7aa1c3a0b3284e1c34d1dd008a6945e4bacb4978f55'),
      ('20260910154858','every_player_who_busted_has_a_place',4795,
       'c6c6bf4bbad5212af762d5f5f3312e09688915ae4d1191199ac779ab967dd373'),
      ('20260910160413','a_finished_event_holds_no_pending_bust',6134,
       'cf7b45f9ef4f960a25ba03c9f0903366e1f5641adeb54ba55c3b162a03e218f3'),
      ('20260910160841','the_break_window_refusal_names_its_rule_and_explains_list_migrations',9261,
       '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d'),
      ('20260910161619','training_solver_bounded_canary_authority',54632,
       'f94a331102a359f2ffa8625f07aa2c0c6ba67191833c56aaeede7a0baab74653'),
      ('20260910164655','stage_b_break_window_bootstrap_compatibility',27550,
       '4d613b7193b1d1d42950040a336f985c7843db6b095cd02c4d751d27d30c5ec6'),
      ('20260910170356','a_handoff_that_names_its_successor_is_not_an_incident',7686,
       'bb1c283dc7951c74496e55121d3042d3282a885f96b0e16cbe980a3fc40217f0'),
      ('20260910170952','an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so',6485,
       'da17405bdf3ac7ca0c6d5516d0db829ad227f95495c3712864a8a2aad32c8f74'),
      ('20260910171843','started_tournaments_resume_or_settle_instead_of_cancelling',4722,
       '85e02d3f2350b4c1c7229ab2b58e789b3b8651869c0c3834a3318d7547b10bf6'),
      ('20260910171857','a_refused_finishing_place_creates_no_debt',24703,
       '69d77f9968d49008f7069fe63b618b802937338e439f631806f02dba0da1220d'),
      ('20260910171911','a_tournament_elimination_requires_a_finishing_rank',10914,
       'cba4981055d5dd9278d7a882e3b8f0d954cd8ffccb37b6426cf4964c32504b68'),
      ('20260910171924','satellite_seats_count_once_and_keep_the_funded_prize',31628,
       '9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3'),
      ('20260910173147','the_settlement_lane_is_per_tournament_for_rolling_authorities',49073,
       'a3030346736b62b13ab33b2e524052c54ffe95ed008859d655cf0641455133b0'),
      ('20260910174349','the_bounty_sweep_takes_one_tournament_lane_per_call',14494,
       '0e209beadad2f8b52e8c72c0bd3559b6fe64fab9917bfb8ac6516a6297f66a17')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE m.version IS NULL
              OR cardinality(m.statements) IS DISTINCT FROM 1
              OR octet_length(m.statements[1]) IS DISTINCT FROM
                   expected.statement_bytes
              OR encode(
                   extensions.digest(
                     convert_to(m.statements[1],'UTF8'),'sha256'),
                   'hex'
                 ) IS DISTINCT FROM expected.statement_sha256
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN supabase_migrations.schema_migrations m
      ON m.version=expected.version AND m.name=expected.name;
  IF v_count<>28 OR v_bad<>0 OR (
       SELECT max(m.version)
         FROM supabase_migrations.schema_migrations m
        WHERE m.version ~ '^[0-9]{14}$'
     ) IS DISTINCT FROM '20260910174349' THEN
    RAISE EXCEPTION
      'Stage-B requires all twenty-eight byte-exact 130319-174349 live-tail migrations and the exact 174349 ledger head; % rows drifted',
      v_bad USING ERRCODE='55000';
  END IF;

  WITH expected(
    identity,definition_md5,source_md5,language_name,security_definer,
    volatility,parallel_safety,is_strict,is_leakproof,kind,returns_set,
    return_type,nargs,argdefaults,configuration,acl_text
  ) AS (
    VALUES
      ('public.fn_settle_tournament_rake(uuid,text)',
       '657781a399203068a1a4888354757878',
       'be08a61e1a867519048c4692b41ab1fd','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',2,1,
       ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_attach_bounty_ledger_obligation()',
       '324f9f652d501cc93daacec52e1b3246',
       'e2028269240a041e38fdc1cb0853e64f','plpgsql',true,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres}'),
      ('public.fn_ca_journal_append_only()',
       'ac9d66e60d077d886981c428c71e5c3c',
       'c19c4314bcb44b29f5d15e32e4dacccd','plpgsql',true,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_record_break_scorecard(timestamp with time zone)',
       '0d9eb4d63244cfc69879f87596439c99',
       '00c4e6cb5cba2a4550e332c1f7d33746','plpgsql',true,'v','u',
       false,false,'f',false,'public.ca_break_scorecards',1,1,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_break_scorecard_push(public.ca_break_scorecards)',
       '0de54de4eee0f2cfee9a5fd9e1e368ff',
       'b76e912f943f096c2fd8ab2ab04e25e1','plpgsql',true,'v','u',
       false,false,'f',false,'void',1,0,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.ca_index_every_seat(integer)',
       '0cb93b8670db03efd2b582269fcd9e54',
       '9cf7d1857d41e1c95a8ed1151dff3c0a','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',1,1,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_hand_commit_refusals(integer)',
       '9ba446c4741c6a7d6cd18d717f4418bb',
       '39f7a321222bef7f0e26e2d224a59f46','sql',true,'s','u',
       false,false,'f',true,'record',1,1,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)',
       '8545c67dc20be918ada9027d88f46312',
       '4f83c09a69eecc766a1f3984feeb9823','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',5,1,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres}'),
      ('public.fn_ca_declare_guard_redefinition(text,text)',
       '3a3746dc6e0a5b7a1db97805588c0eb8',
       '9d10bbc7e34373e82ce9e92e563297bc','plpgsql',true,'v','u',
       false,false,'f',false,'text',2,0,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
       '5437a59dbe68a08e9df13baa422a903c',
       '590f0f782e127288f33763bbab8c89f0','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',12,2,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres}'),
      ('public.fn_ca_break_window_ddl_guard()',
       '6ea4dfd3876346b309a06db40ee8fadd',
       'b698de4b9ae596b1814928e78ee668c9','plpgsql',true,'v','u',
       false,false,'f',false,'event_trigger',0,0,
       ARRAY['search_path=pg_catalog, public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_break_window_governs(text,text)',
       '2b30cf850c450681f97b90e7598f0412',
       '9bc3e63d54109b30f4ad808e36843b82','sql',false,'s','u',
       false,false,'f',false,'boolean',2,0,
       ARRAY['search_path=pg_catalog, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_break_window_refuses_migrations(timestamp with time zone)',
       '0c5f501b57d8d704edbe24a036630e2d',
       '79b467b435ed6d368f9da32d5908cc79','plpgsql',false,'s','s',
       false,false,'f',false,'text',1,0,
       ARRAY['search_path=pg_catalog, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text)',
       '8cbd9ea1c1dbc24c24be02fb9d447b20',
       'ac9d5cdc943e88aa0c0bb6cd2410fbdc','plpgsql',true,'v','u',
      false,false,'f',false,'boolean',3,0,
      ARRAY['search_path=pg_catalog, public, pg_temp']::text[],
       '{postgres=X/postgres}'),
      ('public.fn_ca_financial_alert_to_incident()',
       '5f01207b21a3e2353f6c47291162f22a',
       '2479f66166ce003c48896d1aab55487b','plpgsql',true,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_close_incidents_the_check_no_longer_finds()',
       '0c1a9e2e63771d7dfbf2c305b057b0f2',
       '8e2005a0cfa79cf14e396ceb799df926','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',0,0,
       ARRAY['search_path=public, pg_temp','statement_timeout=120s']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_escrow_on_rake_record()',
       '0dc096bb5615758ed945365a45997c8c',
       '3e628d6a57a93eeb61d494ee33f989a3','plpgsql',true,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_tournament_escrow(uuid)',
       '68d99bdb6dc9a46906336b9ed6987e97',
       '56663389f8348d2ab35a54460c0b7632','sql',true,'s','u',
       false,false,'f',true,'record',1,0,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)',
       '9877846ffabee004690e6b24a3ddcee2',
       '3acb4c1d763181905cf5b64287f8f28f','plpgsql',false,'v','u',
       false,false,'f',false,'void',2,1,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
       '1b03285a00dc01df0f177e25ebe57147',
       '0f491a45693fcf3182719647c5ed7aee','plpgsql',true,'v','u',
       false,false,'f',false,'uuid',3,1,
       ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres}'),
      ('public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)',
       'cf10ddacc96d73a7e8adb6785ca1d331',
       '4170a9f0298fb2e1e97ab7be5e2ec048','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',4,1,
       ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_lock_daily_mission_user(uuid)',
       '0e9d2905374930bda4529a8febc6eff6',
       '66c5a8c8da7471773a58dd7c346c9df0','plpgsql',true,'v','u',
       false,false,'f',false,'void',1,0,
       ARRAY['search_path=pg_catalog, public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_mystery_bounty_pay(uuid)',
       'd666baf91b06f9305191fcbc0b9c7aee',
       '8f16f673aeaafac711da36b0df9466a2','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',1,0,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       '43c53a2b376cb28161584db487bfd17c',
       'f00ad0e9a08496d96f6375cbf6f30678','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',7,0,
       ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_satellite_target_player_provenance_is_immutable()',
       '68f98d4ec2cb186aae11787f1666cffc',
       '266a6b06f5cc44bc953ca4c31933d7db','plpgsql',true,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public']::text[],'{postgres=X/postgres}'),
      ('public.fn_tournament_live_seat_acquisition_requires_authority()',
       '82f74aa99f0bbdeace392401c25e0ba1',
       '5a60bdd761aaaaad4b3bf982a3c50f6e','plpgsql',true,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres}'),
      ('public.fn_tournament_payouts_are_append_only()',
       'f3fca4d1245a05dcc03d98a93d0a641a',
       '6cfe150a2a360d878c9c389499e7b196','plpgsql',false,'v','u',
       false,false,'f',false,'trigger',0,0,
       ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_sweep_pending_tournament_bounties(uuid,integer)',
       '30ca1181317d0f76d7a549ceab37b493',
       '9a16c59eb58695facd75a2d7406b7c28','plpgsql',true,'v','u',
       false,false,'f',false,'jsonb',2,2,
       ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE p.oid IS NULL
              OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM
                   expected.definition_md5
              OR md5(p.prosrc) IS DISTINCT FROM expected.source_md5
              OR p.proowner IS DISTINCT FROM 'postgres'::regrole
              OR l.lanname IS DISTINCT FROM expected.language_name
              OR p.prosecdef IS DISTINCT FROM expected.security_definer
              OR p.provolatile IS DISTINCT FROM expected.volatility::"char"
              OR p.proparallel IS DISTINCT FROM expected.parallel_safety::"char"
              OR p.proisstrict IS DISTINCT FROM expected.is_strict
              OR p.proleakproof IS DISTINCT FROM expected.is_leakproof
              OR p.prokind IS DISTINCT FROM expected.kind::"char"
              OR p.proretset IS DISTINCT FROM expected.returns_set
              OR p.prorettype IS DISTINCT FROM to_regtype(expected.return_type)
              OR p.pronargs IS DISTINCT FROM expected.nargs
              OR p.pronargdefaults IS DISTINCT FROM expected.argdefaults
              OR p.proconfig IS DISTINCT FROM expected.configuration
              OR p.proacl::text IS DISTINCT FROM expected.acl_text
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
    LEFT JOIN pg_language l ON l.oid=p.prolang;
  IF v_count<>28 OR v_bad<>0 THEN
    RAISE EXCEPTION
      'Stage-B found % missing or drifted 174349 live-tail function catalogs',
      v_bad USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public'
     AND c.relname='ca_break_window_migration_overrides'
     AND c.relkind='r'
     AND c.relpersistence='p'
     AND c.relowner='postgres'::regrole
     AND c.relrowsecurity AND NOT c.relforcerowsecurity
     AND c.relreplident='d'
     AND c.relacl::text=
         '{postgres=arwdDxtm/postgres,service_role=r/postgres}'
     AND obj_description(c.oid,'pg_class')=
         'One row per transaction that applied DDL inside the maintenance break window under ca.break_window_migration_override, with the reason it gave.';
  IF v_count<>1 OR EXISTS (
       SELECT 1
         FROM pg_policy policy
        WHERE policy.polrelid=to_regclass(
                'public.ca_break_window_migration_overrides')
     ) THEN
    RAISE EXCEPTION
      'Stage-B found a drifted break-window override relation catalog'
      USING ERRCODE='55000';
  END IF;

  WITH expected(
    attnum,attname,data_type,not_null,identity_kind,generation_kind,
    default_expression,collation_name
  ) AS (
    VALUES
      (1,'id','bigint',true,'a','',NULL::text,NULL::text),
      (2,'occurred_at','timestamp with time zone',true,'','',
       'clock_timestamp()',NULL::text),
      (3,'txid','bigint',true,'','',NULL::text,NULL::text),
      (4,'reason','text',true,'','',NULL::text,'"default"'),
      (5,'session_role','text',true,'','',NULL::text,'"default"'),
      (6,'application_name','text',false,'','',NULL::text,'"default"'),
      (7,'first_command','text',true,'','',NULL::text,'"default"'),
      (8,'query_snippet','text',false,'','',NULL::text,'"default"')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE a.attnum IS NULL
              OR a.attname IS DISTINCT FROM expected.attname
              OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM
                   expected.data_type
              OR a.attnotnull IS DISTINCT FROM expected.not_null
              OR a.attidentity::text IS DISTINCT FROM expected.identity_kind
              OR a.attgenerated::text IS DISTINCT FROM
                   expected.generation_kind
              OR pg_get_expr(d.adbin,d.adrelid,true) IS DISTINCT FROM
                   expected.default_expression
              OR CASE
                   WHEN a.attcollation=0 THEN NULL::text
                   ELSE a.attcollation::regcollation::text
                 END IS DISTINCT FROM expected.collation_name
              OR col_description(a.attrelid,a.attnum) IS NOT NULL
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_attribute a
      ON a.attrelid=to_regclass(
           'public.ca_break_window_migration_overrides')
     AND a.attnum=expected.attnum AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d
      ON d.adrelid=a.attrelid AND d.adnum=a.attnum;
  IF v_count<>8 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_attribute a
        WHERE a.attrelid=to_regclass(
                'public.ca_break_window_migration_overrides')
          AND a.attnum>0 AND NOT a.attisdropped
     )<>8 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted break-window override columns',
      v_bad USING ERRCODE='55000';
  END IF;

  WITH expected(
    constraint_name,constraint_type,no_inherit,definition
  ) AS (
    VALUES
      ('ca_break_window_migration_overrides_pkey','p',true,
       'PRIMARY KEY (id)'),
      ('ca_break_window_migration_overrides_reason_check','c',false,
       'CHECK (btrim(reason) <> ''''::text)')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE con.oid IS NULL
              OR con.contype::text IS DISTINCT FROM expected.constraint_type
              OR con.condeferrable
              OR con.condeferred
              OR NOT con.convalidated
              OR con.connoinherit IS DISTINCT FROM expected.no_inherit
              OR NOT con.conislocal
              OR con.coninhcount<>0
              OR pg_get_constraintdef(con.oid,true) IS DISTINCT FROM
                   expected.definition
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_constraint con
      ON con.conrelid=to_regclass(
           'public.ca_break_window_migration_overrides')
     AND con.conname=expected.constraint_name;
  IF v_count<>2 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_constraint con
        WHERE con.conrelid=to_regclass(
                'public.ca_break_window_migration_overrides')
     )<>2 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted break-window override constraints',
      v_bad USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_index i
    JOIN pg_class index_catalog ON index_catalog.oid=i.indexrelid
   WHERE i.indrelid=to_regclass(
           'public.ca_break_window_migration_overrides')
     AND index_catalog.relname='ca_break_window_migration_overrides_pkey'
     AND index_catalog.relkind='i'
     AND index_catalog.relowner='postgres'::regrole
     AND i.indisunique AND i.indisprimary AND NOT i.indisexclusion
     AND i.indimmediate AND i.indisvalid AND i.indisready AND i.indislive
     AND NOT i.indnullsnotdistinct
     AND i.indnkeyatts=1 AND i.indnatts=1
     AND pg_get_indexdef(i.indexrelid)=
         'CREATE UNIQUE INDEX ca_break_window_migration_overrides_pkey ON public.ca_break_window_migration_overrides USING btree (id)'
     AND pg_get_expr(i.indpred,i.indrelid,true) IS NULL;
  IF v_count<>1 OR (
       SELECT count(*)
         FROM pg_index i
        WHERE i.indrelid=to_regclass(
                'public.ca_break_window_migration_overrides')
     )<>1 THEN
    RAISE EXCEPTION
      'Stage-B found a missing, extra or drifted break-window override index'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_class c
    JOIN pg_sequence sequence_catalog ON sequence_catalog.seqrelid=c.oid
   WHERE c.oid=to_regclass(
           'public.ca_break_window_migration_overrides_id_seq')
     AND c.relkind='S'
     AND c.relpersistence='p'
     AND c.relowner='postgres'::regrole
     AND c.relacl::text=
         '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'
     AND sequence_catalog.seqtypid='bigint'::regtype
     AND sequence_catalog.seqstart=1
     AND sequence_catalog.seqincrement=1
     AND sequence_catalog.seqmax=9223372036854775807
     AND sequence_catalog.seqmin=1
     AND sequence_catalog.seqcache=1
     AND NOT sequence_catalog.seqcycle
     AND obj_description(c.oid,'pg_class') IS NULL
     AND pg_get_serial_sequence(
           'public.ca_break_window_migration_overrides','id')=
         'public.ca_break_window_migration_overrides_id_seq';
  IF v_count<>1 THEN
    RAISE EXCEPTION
      'Stage-B found a drifted break-window override identity sequence'
      USING ERRCODE='55000';
  END IF;

  WITH expected(event_name,event_kind) AS (
    VALUES
      ('ca_break_window_refuses_ddl','ddl_command_end'),
      ('ca_break_window_refuses_drops','sql_drop')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE event_trigger.oid IS NULL
              OR event_trigger.evtevent IS DISTINCT FROM expected.event_kind
              OR event_trigger.evtenabled IS DISTINCT FROM 'O'::"char"
              OR event_trigger.evttags IS NOT NULL
              OR event_trigger.evtfoid IS DISTINCT FROM
                   to_regprocedure('public.fn_ca_break_window_ddl_guard()')
              OR event_trigger.evtowner IS DISTINCT FROM 'postgres'::regrole
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_event_trigger event_trigger
      ON event_trigger.evtname=expected.event_name;
  IF v_count<>2 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_event_trigger event_trigger
        WHERE event_trigger.evtfoid=
              to_regprocedure('public.fn_ca_break_window_ddl_guard()')
     )<>2 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted break-window event triggers',
      v_bad USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public'
     AND c.relname='ca_guard_defs'
     AND c.relkind='r'
     AND c.relpersistence='p'
     AND c.relowner='postgres'::regrole
     AND c.relrowsecurity AND NOT c.relforcerowsecurity
     AND c.relreplident='d'
     AND c.relacl::text=
         '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'
     AND obj_description(c.oid,'pg_class')=
         'Hardening round 2: checksums of the alarm stack''s own function bodies. fn_ca_guard_defs_watch notices any change once, files a dashboard incident, and re-baselines.';
  IF v_count<>1 OR EXISTS (
       SELECT 1
         FROM pg_policy policy
        WHERE policy.polrelid=to_regclass('public.ca_guard_defs')
     ) THEN
    RAISE EXCEPTION
      'Stage-B found a drifted guard-definition relation catalog'
      USING ERRCODE='55000';
  END IF;

  WITH expected(
    attnum,attname,data_type,not_null,identity_kind,generation_kind,
    default_expression,collation_name,column_comment
  ) AS (
    VALUES
      (1,'proname','text',true,'','',NULL::text,'"default"',
       NULL::text),
      (2,'def_hash','text',true,'','',NULL::text,'"default"',
       NULL::text),
      (3,'updated_at','timestamp with time zone',true,'','',
       'now()',NULL::text,NULL::text),
      (4,'declared_ref','text',false,'','',NULL::text,'"default"',
       'The migration that deliberately redefined this guard and moved the baseline in its own transaction. NULL means the baseline was moved by fn_ca_guard_defs_watch after observing a change nobody declared - which is the case the watcher exists for.'),
      (5,'declared_at','timestamp with time zone',false,'','',
       NULL::text,NULL::text,NULL::text)
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE a.attnum IS NULL
              OR a.attname IS DISTINCT FROM expected.attname
              OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM
                   expected.data_type
              OR a.attnotnull IS DISTINCT FROM expected.not_null
              OR a.attidentity::text IS DISTINCT FROM expected.identity_kind
              OR a.attgenerated::text IS DISTINCT FROM
                   expected.generation_kind
              OR pg_get_expr(d.adbin,d.adrelid,true) IS DISTINCT FROM
                   expected.default_expression
              OR CASE
                   WHEN a.attcollation=0 THEN NULL::text
                   ELSE a.attcollation::regcollation::text
                 END IS DISTINCT FROM expected.collation_name
              OR col_description(a.attrelid,a.attnum) IS DISTINCT FROM
                   expected.column_comment
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_attribute a
      ON a.attrelid=to_regclass('public.ca_guard_defs')
     AND a.attnum=expected.attnum AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d
      ON d.adrelid=a.attrelid AND d.adnum=a.attnum;
  IF v_count<>5 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_attribute a
        WHERE a.attrelid=to_regclass('public.ca_guard_defs')
          AND a.attnum>0 AND NOT a.attisdropped
     )<>5 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted guard-definition columns',
      v_bad USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_constraint con
   WHERE con.conrelid=to_regclass('public.ca_guard_defs')
     AND con.conname='ca_guard_defs_pkey'
     AND con.contype='p'
     AND NOT con.condeferrable
     AND NOT con.condeferred
     AND con.convalidated
     AND con.connoinherit
     AND con.conislocal
     AND con.coninhcount=0
     AND pg_get_constraintdef(con.oid,true)='PRIMARY KEY (proname)';
  IF v_count<>1 OR (
       SELECT count(*)
         FROM pg_constraint con
        WHERE con.conrelid=to_regclass('public.ca_guard_defs')
     )<>1 THEN
    RAISE EXCEPTION
      'Stage-B found a missing, extra or drifted guard-definition constraint'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM public.ca_guard_defs guard_definition
   WHERE guard_definition.proname='fn_ca_financial_alert_to_incident'
     AND guard_definition.def_hash='5f01207b21a3e2353f6c47291162f22a'
     AND guard_definition.declared_ref=
         'migration a_handoff_that_names_its_successor_is_not_an_incident'
     AND guard_definition.declared_at IS NOT NULL;
  IF v_count<>1 THEN
    RAISE EXCEPTION
      'Stage-B found a drifted declared financial-alert guard baseline'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_index i
    JOIN pg_class index_catalog ON index_catalog.oid=i.indexrelid
   WHERE i.indrelid=to_regclass('public.ca_guard_defs')
     AND index_catalog.relname='ca_guard_defs_pkey'
     AND index_catalog.relkind='i'
     AND index_catalog.relowner='postgres'::regrole
     AND i.indisunique
     AND i.indisprimary
     AND NOT i.indisexclusion
     AND i.indimmediate
     AND i.indisvalid
     AND i.indisready
     AND i.indislive
     AND NOT i.indnullsnotdistinct
     AND i.indnkeyatts=1
     AND i.indnatts=1
     AND pg_get_indexdef(i.indexrelid)=
         'CREATE UNIQUE INDEX ca_guard_defs_pkey ON public.ca_guard_defs USING btree (proname)'
     AND pg_get_expr(i.indpred,i.indrelid,true) IS NULL;
  IF v_count<>1 OR (
       SELECT count(*)
         FROM pg_index i
        WHERE i.indrelid=to_regclass('public.ca_guard_defs')
     )<>1 THEN
    RAISE EXCEPTION
      'Stage-B found a missing, extra or drifted guard-definition index'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public'
     AND c.relname='engine_maintenance_break_faults'
     AND c.relkind='r'
     AND c.relpersistence='p'
     AND c.relowner='postgres'::regrole
     AND c.relrowsecurity AND NOT c.relforcerowsecurity
     AND c.relreplident='d'
     AND c.relacl::text=
         '{postgres=arwdDxtm/postgres,service_role=ar/postgres}'
     AND obj_description(c.oid,'pg_class')=
         'One row per maintenance-break fault, written by the engine through PostgREST as service_role at the moment a break could not proceed. announced_at is the :53 instant of that hour''s break; stage is where it failed (announcement, countdown, adoption, boot); outcome is what the engine did about it (cancelled the break, or held it without restarting); error is the engine''s own message. fn_ca_record_break_scorecard copies the newest fault for an hour whose break never started into the scorecard detail, and fn_ca_break_scorecard_push names it. Insert-only evidence: service_role may SELECT and INSERT; no browser role may do either.';
  IF v_count<>1 OR EXISTS (
       SELECT 1
         FROM pg_policy policy
        WHERE policy.polrelid=to_regclass(
                'public.engine_maintenance_break_faults')
     ) THEN
    RAISE EXCEPTION
      'Stage-B found a drifted maintenance-break fault relation catalog'
      USING ERRCODE='55000';
  END IF;

  WITH expected(
    attnum,attname,data_type,not_null,identity_kind,generation_kind,
    default_expression,collation_name
  ) AS (
    VALUES
      (1,'id','uuid',true,'','', 'gen_random_uuid()',NULL::text),
      (2,'announced_at','timestamp with time zone',true,'','',NULL::text,NULL::text),
      (3,'stage','text',true,'','',NULL::text,'"default"'),
      (4,'outcome','text',true,'','',NULL::text,'"default"'),
      (5,'error','text',false,'','',NULL::text,'"default"'),
      (6,'engine_version','text',false,'','',NULL::text,'"default"'),
      (7,'recorded_at','timestamp with time zone',true,'','', 'now()',NULL::text)
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE a.attnum IS NULL
              OR a.attname IS DISTINCT FROM expected.attname
              OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM
                   expected.data_type
              OR a.attnotnull IS DISTINCT FROM expected.not_null
              OR a.attidentity::text IS DISTINCT FROM expected.identity_kind
              OR a.attgenerated::text IS DISTINCT FROM
                   expected.generation_kind
              OR col_description(a.attrelid,a.attnum) IS NOT NULL
              OR pg_get_expr(d.adbin,d.adrelid,true) IS DISTINCT FROM
                   expected.default_expression
              OR CASE
                   WHEN a.attcollation=0 THEN NULL::text
                   ELSE a.attcollation::regcollation::text
                 END IS DISTINCT FROM expected.collation_name
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_attribute a
      ON a.attrelid=to_regclass('public.engine_maintenance_break_faults')
     AND a.attnum=expected.attnum AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d
      ON d.adrelid=a.attrelid AND d.adnum=a.attnum;
  IF v_count<>7 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_attribute a
        WHERE a.attrelid=to_regclass(
                'public.engine_maintenance_break_faults')
          AND a.attnum>0 AND NOT a.attisdropped
     )<>7 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted maintenance-break fault columns',
      v_bad USING ERRCODE='55000';
  END IF;

  WITH expected(
    constraint_name,constraint_type,is_deferrable,is_deferred,is_validated,no_inherit,
    is_local,inheritance_count,definition
  ) AS (
    VALUES
      ('engine_maintenance_break_faults_outcome_check','c',false,false,true,
       false,true,0,
       'CHECK (outcome = ANY (ARRAY[''cancelled''::text, ''held_without_restart''::text]))'),
      ('engine_maintenance_break_faults_pkey','p',false,false,true,
       true,true,0,'PRIMARY KEY (id)'),
      ('engine_maintenance_break_faults_stage_check','c',false,false,true,
       false,true,0,
       'CHECK (stage = ANY (ARRAY[''announcement''::text, ''countdown''::text, ''adoption''::text, ''boot''::text]))')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE con.oid IS NULL
              OR con.contype::text IS DISTINCT FROM expected.constraint_type
              OR con.condeferrable IS DISTINCT FROM expected.is_deferrable
              OR con.condeferred IS DISTINCT FROM expected.is_deferred
              OR con.convalidated IS DISTINCT FROM expected.is_validated
              OR con.connoinherit IS DISTINCT FROM expected.no_inherit
              OR con.conislocal IS DISTINCT FROM expected.is_local
              OR con.coninhcount IS DISTINCT FROM expected.inheritance_count
              OR pg_get_constraintdef(con.oid,true) IS DISTINCT FROM
                   expected.definition
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_constraint con
      ON con.conrelid=to_regclass('public.engine_maintenance_break_faults')
     AND con.conname=expected.constraint_name;
  IF v_count<>3 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_constraint con
        WHERE con.conrelid=to_regclass(
                'public.engine_maintenance_break_faults')
     )<>3 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted maintenance-break fault constraints',
      v_bad USING ERRCODE='55000';
  END IF;

  WITH expected(
    index_name,is_unique,is_primary,index_definition
  ) AS (
    VALUES
      ('engine_maintenance_break_faults_pkey',true,true,
       'CREATE UNIQUE INDEX engine_maintenance_break_faults_pkey ON public.engine_maintenance_break_faults USING btree (id)'),
      ('idx_engine_maintenance_break_faults_announced_at',false,false,
       'CREATE INDEX idx_engine_maintenance_break_faults_announced_at ON public.engine_maintenance_break_faults USING btree (announced_at)')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE i.indexrelid IS NULL
              OR index_catalog.relkind IS DISTINCT FROM 'i'::"char"
              OR index_catalog.relowner IS DISTINCT FROM 'postgres'::regrole
              OR i.indisunique IS DISTINCT FROM expected.is_unique
              OR i.indisprimary IS DISTINCT FROM expected.is_primary
              OR i.indisexclusion IS DISTINCT FROM false
              OR i.indimmediate IS DISTINCT FROM true
              OR i.indisvalid IS DISTINCT FROM true
              OR i.indisready IS DISTINCT FROM true
              OR i.indislive IS DISTINCT FROM true
              OR i.indnullsnotdistinct IS DISTINCT FROM false
              OR i.indnkeyatts IS DISTINCT FROM 1
              OR i.indnatts IS DISTINCT FROM 1
              OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM
                   expected.index_definition
              OR pg_get_expr(i.indpred,i.indrelid,true) IS NOT NULL
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_class index_catalog
      ON index_catalog.relname=expected.index_name
     AND index_catalog.relnamespace='public'::regnamespace
    LEFT JOIN pg_index i
      ON i.indexrelid=index_catalog.oid
     AND i.indrelid=to_regclass('public.engine_maintenance_break_faults');
  IF v_count<>2 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_index i
        WHERE i.indrelid=to_regclass(
                'public.engine_maintenance_break_faults')
     )<>2 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted maintenance-break fault indexes',
      v_bad USING ERRCODE='55000';
  END IF;

  WITH expected(
    function_identity,relation_identity,trigger_name,definition_md5,trigger_type,
    attribute_numbers,has_qualifier
  ) AS (
    VALUES
      ('public.fn_attach_bounty_ledger_obligation()',
       'public.tournament_bounties','trg_attach_bounty_ledger_obligation',
       'ff3e9305edae93d151545b1e39f519c3',7,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.agent_commissions','trg_ca_append_only',
       'b160761b00f1575419c4480048433924',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.chip_ledger','trg_ca_append_only',
       '15d2fb7366e29ca4dcc19a5afb55dfab',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.chip_transactions','trg_ca_append_only',
       '1dcaece880bcbb143e869a3456e53065',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.club_wallet_transactions','trg_ca_append_only',
       '5da93870ace9289608f1de7190d872c0',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.diamond_transactions','trg_ca_append_only',
       '416cec9117a036d12f0ddde4db64b6a5',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.diamond_wallet_transfers','wallet_transfers_append_only',
       'eb1d6ab69891abfa2a4fc11aaff723d8',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.rakeback_period_payouts','trg_ca_append_only',
       'd7d02bd075ff3fd1a917e50535e1bdd7',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.union_wallet_transactions','trg_ca_append_only',
       '06a711ff9e0e0d5f33cb5bb891d6257c',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.vip_points_ledger','trg_ca_append_only',
       'c1c67e4ef2138481fd9176346e53b332',27,'',false),
      ('public.fn_ca_journal_append_only()',
       'public.wallet_transactions','trg_ca_append_only',
       'b434a15ef432e8562fa6c6df4f0f3cec',27,'',false),
      ('public.fn_ca_financial_alert_to_incident()',
       'public.financial_alerts','trg_ca_financial_alert_incident',
       'c7350e02f70dcd0a95b3325bcbdab924',5,'',false),
      ('public.fn_ca_escrow_on_rake_record()',
       'public.rake_records','zz_ca_escrow_rake_record',
       'bf08da3e12849cf1cf33226441d9e116',5,'',true),
      ('public.fn_tournament_live_seat_acquisition_requires_authority()',
       'public.table_seats','a0_tournament_live_seat_root_guard',
       'd33542ca1293e3c444ae151d9659e28a',23,'2 4 3 13',false),
      ('public.fn_satellite_target_player_provenance_is_immutable()',
       'public.tournament_players','satellite_target_player_provenance_is_immutable',
       '9ec06cfc7cbf46abb8159a5ce13fb59e',31,'1 2 3 21 25',false),
      ('public.fn_tournament_payouts_are_append_only()',
       'public.tournament_payouts','trg_tournament_payouts_append_only',
       '12f229da39eeba946d4230155f854b0d',27,'',false)
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE tg.oid IS NULL
              OR tg.tgfoid IS DISTINCT FROM
                   to_regprocedure(expected.function_identity)
              OR md5(pg_get_triggerdef(tg.oid,true)) IS DISTINCT FROM
                   expected.definition_md5
              OR tg.tgenabled IS DISTINCT FROM 'O'::"char"
              OR tg.tgisinternal IS DISTINCT FROM false
              OR tg.tgdeferrable IS DISTINCT FROM false
              OR tg.tginitdeferred IS DISTINCT FROM false
              OR tg.tgtype IS DISTINCT FROM expected.trigger_type
              OR tg.tgattr::text IS DISTINCT FROM expected.attribute_numbers
              OR (tg.tgqual IS NOT NULL) IS DISTINCT FROM
                   expected.has_qualifier
              OR tg.tgnargs IS DISTINCT FROM 0
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_trigger tg
      ON tg.tgrelid=to_regclass(expected.relation_identity)
     AND tg.tgname=expected.trigger_name;
  IF v_count<>16 OR v_bad<>0 OR (
       SELECT count(*)
         FROM pg_trigger tg
        WHERE NOT tg.tgisinternal
          AND tg.tgfoid=ANY(ARRAY[
            to_regprocedure('public.fn_attach_bounty_ledger_obligation()')::oid,
            to_regprocedure('public.fn_ca_journal_append_only()')::oid,
            to_regprocedure('public.fn_ca_financial_alert_to_incident()')::oid,
            to_regprocedure('public.fn_ca_escrow_on_rake_record()')::oid,
            to_regprocedure('public.fn_tournament_live_seat_acquisition_requires_authority()')::oid,
            to_regprocedure('public.fn_satellite_target_player_provenance_is_immutable()')::oid,
            to_regprocedure('public.fn_tournament_payouts_are_append_only()')::oid
          ])
     )<>16 THEN
    RAISE EXCEPTION
      'Stage-B found % missing, extra or drifted 173147 live-tail trigger bindings',
      v_bad USING ERRCODE='55000';
  END IF;
END;
$assert_current_live_tail_174349$;

SELECT pg_temp.assert_stage_b_current_live_tail_174349_postimage();

-- Four live-tail functions below are deliberately wrapped or have their ACL
-- and trusted search path tightened later in this same transaction. Pin their
-- complete 171924 preimage here, then prove at the final boundary that the
-- audited implementation source was carried through unchanged.
DO $require_stage_b_171924_mutable_function_preimage$
DECLARE
  v_count integer;
  v_bad integer;
BEGIN
  WITH expected(
    identity,definition_md5,source_md5,definition_bytes,definition_sha256,
    source_bytes,source_sha256,nargs,argdefaults,configuration,acl_text
  ) AS (
    VALUES
      ('public.atomic_cancel_tournament(uuid,uuid)',
       'bdfeeafe38b7691305f02c741faa1d12','16ea7acbbf76613a0a1193dff18f1330',
       33038,'c2e469b5894407c7a806b30177bf0062654effcfddc378544e038426b6691dc6',
       32778,'30288544fd40e61f902fd6f363368e05e220cbef06ab10edba9ea1e387709f2c',
       2,0,ARRAY['search_path=public, extensions, pg_temp',
                 'statement_timeout=120s']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
       '5a3aa8bd1a48d18b793e39c09b645b41','ebabbaf0456d80335aaa2e04471d0ab6',
       21743,'531dbe7ba420ccfcff790ee90b0452e74f1a0232dbdd7535c9376d6696ee58cf',
       21367,'7f51ae874957250d6e2c5df40573170e6deaafe8f1d39b5417a41587c419a1ad',
       8,2,ARRAY['search_path=public']::text[],'{postgres=X/postgres}'),
      ('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'eefbf339094c8bc7420ef226132ae453','b4937067d9bf337e1466095b9e1d5424',
       8145,'51c2f60bf067ca670e00631089e0268ecf6cb6f7c64a0401b710c200b617293d',
       7848,'b4daec2a24918030b2bef95fab45d1518bfc57cfae8dfbe9a9d948dda369c321',
       5,1,ARRAY['search_path=public, pg_temp']::text[],
       '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
       '208fe48a2697811d14e55a64271083a6','2c21c56c6a9d4a2f8ee79082bd4fef57',
       13012,'3346c472a44a350bb0a8a88fc4b9e834be8b33bdf01ea57c7bc37576ae9b0bab',
       12717,'b10fdda12351a80c3775a28d5667a4eee9ac91b281ee3925793c44b4122d54dc',
       5,2,ARRAY['search_path=public']::text[],
       '{postgres=X/postgres,service_role=X/postgres}')
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE p.oid IS NULL
              OR md5(pg_get_functiondef(p.oid))<>expected.definition_md5
              OR md5(p.prosrc)<>expected.source_md5
              OR octet_length(pg_get_functiondef(p.oid))<>expected.definition_bytes
              OR encode(extensions.digest(
                   convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')<>
                   expected.definition_sha256
              OR octet_length(p.prosrc)<>expected.source_bytes
              OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>
                   expected.source_sha256
              OR p.proowner<>'postgres'::regrole OR l.lanname<>'plpgsql'
              OR NOT p.prosecdef OR p.provolatile<>'v' OR p.proparallel<>'u'
              OR p.proisstrict OR p.proleakproof OR p.prokind<>'f'
              OR p.proretset OR p.prorettype<>'jsonb'::regtype
              OR p.pronargs<>expected.nargs
              OR p.pronargdefaults<>expected.argdefaults
              OR p.proconfig IS DISTINCT FROM expected.configuration
              OR p.proacl::text IS DISTINCT FROM expected.acl_text
         )::integer
    INTO v_count,v_bad
    FROM expected
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
    LEFT JOIN pg_language l ON l.oid=p.prolang;
  IF v_count<>4 OR v_bad<>0 THEN
    RAISE EXCEPTION
      'Stage-B found % missing or drifted mutable 171924 function preimages',
      v_bad USING ERRCODE='55000';
  END IF;
END;
$require_stage_b_171924_mutable_function_preimage$;


-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: M6 SEAT-EXIT RUNTIME AUTHORITY
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(p_tournament_id uuid, p_operation text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_token uuid:=gen_random_uuid();
BEGIN
  IF p_tournament_id IS NULL
     OR p_operation NOT IN (
       'unregister','cancel','satellite_finish','terminal_finish','move',
       'elimination') THEN
    RAISE EXCEPTION 'invalid tournament seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  -- This tournament's lane (2026-09-10): G shared, T(id) exclusive. Every
  -- row below belongs to this one tournament. Re-entered free by a rolling
  -- caller; granted at once under a terminal caller (G and B exclusive).
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;

  -- Deterministic seat order matches hand settlement and terminal close.
  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id
   FOR UPDATE OF s;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,p_operation
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation',p_operation,true);
  RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Hand settlement already owns its exact lease, parent, table, roster and
-- seat lock order before the stack core writes anything. Its capability
-- opener must therefore neither reacquire the global terminal advisory lock
-- nor upgrade the parent row out of order. It authorizes only the exact
-- zero-candidate users at this table; any missing or duplicate live seat
-- refuses the hand before the core can mutate a stack.
CREATE OR REPLACE FUNCTION
  public.fn_ca_open_tournament_hand_seat_exit_authority(
    p_tournament_id uuid,
    p_table_id uuid,
    p_user_ids uuid[]
  )
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $open_hand_seat_exit_authority$
DECLARE
  v_token uuid:=gen_random_uuid();
  v_expected integer;
  v_inserted integer;
BEGIN
  v_expected:=COALESCE(cardinality(p_user_ids),0);
  IF p_tournament_id IS NULL OR p_table_id IS NULL OR v_expected=0
     OR array_position(p_user_ids,NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u) FROM unnest(p_user_ids) u)<>v_expected
     OR NOT EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'invalid accepted-hand seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,'hand_settlement'
    FROM public.table_seats s
   WHERE s.table_id=p_table_id
     AND s.left_at IS NULL
     AND s.user_id=ANY(p_user_ids)
   ORDER BY s.id;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted<>v_expected THEN
    RAISE EXCEPTION
      'accepted-hand seat-exit authority expected % live seat(s), found %',
      v_expected,v_inserted USING ERRCODE='P0404';
  END IF;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation','hand_settlement',true);
  RETURN v_token;
END;
$open_hand_seat_exit_authority$;

REVOKE ALL ON FUNCTION
  public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;

-- A zero-stack hand is durable work for the tournament manager. Extend the
-- existing level-triggered outbox before the accepted-hand wrapper can emit
-- the new reason. The wake row is written by the same database transaction as
-- the hand, stack mirror, and seat exit: a later failure rolls all of them
-- back, while a replay cannot advance the wake generation a second time.
ALTER TABLE public.tournament_manager_wakes
  DROP CONSTRAINT tournament_manager_wakes_reason_check;
ALTER TABLE public.tournament_manager_wakes
  ADD CONSTRAINT tournament_manager_wakes_reason_check
  CHECK (reason IN (
    'rebuy','reentry','addon','late_registration','deal_vote',
    'bounty_settled','accepted_hand_bust'));

CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(
  p_tournament_id uuid,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $manager_wake_with_accepted_hand_bust$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  IF p_reason NOT IN (
    'rebuy','reentry','addon','late_registration','deal_vote',
    'bounty_settled','accepted_hand_bust'
  ) THEN
    RAISE EXCEPTION 'invalid tournament manager wake reason';
  END IF;

  SELECT upper(COALESCE(t.status,''))
    INTO v_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.tournament_manager_wakes AS pending(
    tournament_id,reason,generation)
  VALUES (p_tournament_id,p_reason,1)
  ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation=pending.generation+1,
    created_at=clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$manager_wake_with_accepted_hand_bust$;

REVOKE ALL ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  p_token uuid,
  p_require_consumed boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $close_seat_exit_authority$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  PERFORM set_config('app.tournament_seat_exit_token','',true);
  PERFORM set_config('app.tournament_seat_exit_operation','',true);
  IF COALESCE(p_require_consumed,true) AND v_remaining<>0 THEN
    RAISE EXCEPTION
      'tournament seat-exit authority left % live seat(s) unconsumed',v_remaining
      USING ERRCODE='P0404';
  END IF;
  RETURN v_remaining;
END;
$close_seat_exit_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_exit_requires_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $seat_exit_guard$
DECLARE
  v_tournament_id uuid;
  v_token uuid;
  v_operation text:=COALESCE(
    current_setting('app.tournament_seat_exit_operation',true),'');
  v_authorized integer;
  v_exit boolean:=false;
BEGIN
  IF OLD.left_at IS NOT NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    v_exit:=true;
  ELSE
    v_exit:=NEW.left_at IS NOT NULL
      OR lower(COALESCE(NEW.status,''))='left'
      OR NEW.table_id IS DISTINCT FROM OLD.table_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.seat_number IS DISTINCT FROM OLD.seat_number;
  END IF;
  IF NOT v_exit THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id
    INTO v_tournament_id
    FROM public.tables tb
   WHERE tb.id=OLD.table_id;
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  BEGIN
    v_token:=NULLIF(
      current_setting('app.tournament_seat_exit_token',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_token:=NULL;
  END;
  IF v_token IS NULL OR v_operation='' THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;

  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=v_token
     AND a.seat_id=OLD.id
     AND a.tournament_id=v_tournament_id
     AND a.user_id=OLD.user_id
     AND a.operation=v_operation;
  GET DIAGNOSTICS v_authorized=ROW_COUNT;
  IF v_authorized<>1 THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$seat_exit_guard$;

REVOKE ALL ON FUNCTION public.fn_tournament_live_seat_exit_requires_authority()
  FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS zy_tournament_live_seat_exit_requires_authority
  ON public.table_seats;
CREATE TRIGGER zy_tournament_live_seat_exit_requires_authority
  BEFORE DELETE OR UPDATE OF table_id,user_id,seat_number,left_at,status
  ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_live_seat_exit_requires_authority();

-- Preserve the complete accepted-stack implementation behind an owner-only
-- name. The recreated canonical helper is also owner-only; it exists solely
-- so the already lease-fenced 12-argument hand transaction can mint and
-- consume an exact one-use seat capability around zero-stack vacates.
DO $rename_hand_stack_core$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
       IS NULL THEN
    IF to_regprocedure(
         'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
         IS NULL THEN
      RAISE EXCEPTION 'accepted-hand stack implementation is missing';
    END IF;
    ALTER FUNCTION public.fn_ca_settle_hand_stacks_absolute(
      uuid,bigint,jsonb,numeric,numeric,text,numeric)
      RENAME TO fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority;
  END IF;
END;
$rename_hand_stack_core$;

REVOKE ALL ON FUNCTION
  public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(
    uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb DEFAULT '[]'::jsonb,
  p_rake numeric DEFAULT NULL::numeric,
  p_bbj numeric DEFAULT NULL::numeric,
  p_ref text DEFAULT NULL::text,
  p_inflow numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $accepted_hand_stack_with_seat_authority$
DECLARE
  v_tournament_id uuid;
  v_zero_user_ids uuid[]:=ARRAY[]::uuid[];
  v_token uuid;
  v_opened integer:=0;
  v_remaining integer:=0;
  v_consumed integer:=0;
  v_result jsonb;
  v_expected_vacated integer;
  v_hand uuid;
  v_succeeded_receipt boolean:=false;
BEGIN
  -- Parse only an entirely well-shaped roster. Malformed input is passed to
  -- the preserved core unchanged so its canonical refusal remains the one
  -- semantic result and no capability is opened for a partial interpretation.
  IF jsonb_typeof(p_stacks)='array'
     AND jsonb_array_length(p_stacks)>0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) x
        WHERE jsonb_typeof(x)<>'object'
           OR jsonb_typeof(x->'user_id')<>'string'
           OR COALESCE(x->>'user_id','') !~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(x->'stack')<>'number')
     AND (SELECT count(DISTINCT x->>'user_id')
            FROM jsonb_array_elements(p_stacks) x)
           = jsonb_array_length(p_stacks) THEN
    SELECT tb.tournament_id INTO v_tournament_id
      FROM public.tables tb WHERE tb.id=p_table_id;
    IF v_tournament_id IS NOT NULL THEN
      SELECT COALESCE(
               array_agg(DISTINCT (x->>'user_id')::uuid
                         ORDER BY (x->>'user_id')::uuid),
               ARRAY[]::uuid[])
        INTO v_zero_user_ids
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x->>'stack')::numeric=0;
    END IF;
  END IF;

  IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    v_hand:=md5(
      'ca-hand:'||p_table_id::text||':'||p_hand_number::text||
      CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END
    )::uuid;
    SELECT EXISTS (
      SELECT 1 FROM public.settlement_idempotency_keys k
       WHERE k.table_id=p_table_id AND k.hand_id=v_hand
         AND k.status='succeeded')
      INTO v_succeeded_receipt;
  END IF;

  -- A successful replay has already consumed and closed every zero seat. Do
  -- not weaken the fresh path to accommodate it: skip opening, then let the
  -- preserved core validate the complete request identity and return replay.
  IF cardinality(v_zero_user_ids)>0 AND NOT v_succeeded_receipt THEN
    v_token:=public.fn_ca_open_tournament_hand_seat_exit_authority(
      v_tournament_id,p_table_id,v_zero_user_ids);
    SELECT count(*) INTO v_opened
      FROM public.tournament_seat_exit_authorizations a
     WHERE a.token=v_token AND a.operation='hand_settlement';
  END IF;

  BEGIN
    v_result:=public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(
      p_table_id,p_hand_number,p_stacks,p_rake,p_bbj,p_ref,p_inflow);

    IF v_token IS NOT NULL THEN
      v_remaining:=public.fn_ca_close_tournament_seat_exit_authority(
        v_token,false);
      v_consumed:=v_opened-v_remaining;
      IF COALESCE((v_result->>'success')::boolean,false)
         AND NOT COALESCE((v_result->>'replay')::boolean,false) THEN
        BEGIN
          v_expected_vacated:=
            (v_result->>'tournament_zero_stack_seat_count')::integer;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION
            'accepted-hand stack result omitted its seat-exit receipt'
            USING ERRCODE='P0404';
        END;
        IF v_expected_vacated IS NULL
           OR v_expected_vacated<>v_consumed THEN
          RAISE EXCEPTION
            'accepted-hand consumed % seat capability row(s), receipt named %',
            v_consumed,v_expected_vacated USING ERRCODE='P0404';
        END IF;
        IF v_expected_vacated>0 THEN
          PERFORM public.fn_emit_tournament_manager_wake(
            v_tournament_id,'accepted_hand_bust');
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF v_token IS NOT NULL THEN
      PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    END IF;
    RAISE;
  END;

  RETURN v_result;
END;
$accepted_hand_stack_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC,anon,authenticated,service_role;

-- The accepted-hand, rebuy, registration and move transactions now write both
-- seat and roster together. Retire the two-statement snapshot reconciler after
-- its exact one-time repair above; leaving either half callable would permit a
-- stale snapshot to overwrite a newer accepted-hand mirror.
DO $legacy_chip_sync_preflight$
DECLARE
  v_live oid:=to_regprocedure(
    'public.fn_sync_tournament_live_seat_chips(uuid)');
  v_lower oid:=to_regprocedure(
    'public.fn_sync_tournament_chips(uuid,jsonb)');
BEGIN
  IF v_live IS NULL OR v_lower IS NULL THEN
    RAISE EXCEPTION 'legacy tournament chip reconciler shape changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.oid<>v_live
       AND p.prosrc LIKE '%fn_sync_tournament_chips%') THEN
    RAISE EXCEPTION
      'an unexpected persistent function still calls the legacy chip writer';
  END IF;
END;
$legacy_chip_sync_preflight$;

DROP FUNCTION public.fn_sync_tournament_live_seat_chips(uuid) RESTRICT;
DROP FUNCTION public.fn_sync_tournament_chips(uuid,jsonb) RESTRICT;

-- Preserve the large, already-probed entitlement refund core byte-for-byte.
-- The new wrapper owns only the seat-exit capability around that transaction.
DO $rename_unregister_core$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)')
       IS NULL THEN
    IF to_regprocedure(
       'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)')
       IS NULL THEN
      RAISE EXCEPTION 'exact tournament unregistration authority is missing';
    END IF;
    ALTER FUNCTION public.fn_ca_unregister_tournament_player_exact(
      uuid,uuid,uuid,text,uuid)
      RENAME TO fn_ca_unregister_tournament_player_exact_pre_seat_guard;
  END IF;
END;
$rename_unregister_core$;

REVOKE ALL ON FUNCTION
  public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(
    uuid,uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $unregister_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament player % has % live seats; exact unregistration refuses ambiguous chips',
      p_user_id,v_live_seats USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'unregister',p_user_id);
  BEGIN
    v_result:=public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(
      p_tournament_id,p_user_id,p_expected_table_id,p_description,p_request_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$unregister_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(
  uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Terminal owners get the same capability wrapper. Money, ranking, tickets,
-- roster status, felt closure and the immutable receipt still live in each
-- existing core and therefore still commit or roll back together.
DO $rename_terminal_cores$
BEGIN
  IF to_regprocedure(
       'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.atomic_cancel_tournament(uuid,uuid)
      RENAME TO atomic_cancel_tournament_pre_seat_guard;
  END IF;
  IF to_regprocedure(
       'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
      RENAME TO fn_settle_satellite_tournament_pre_seat_guard;
  END IF;
  IF to_regprocedure(
       'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)') IS NULL THEN
    ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
      RENAME TO fn_complete_tournament_terminal_pre_seat_guard;
  END IF;
END;
$rename_terminal_cores$;

REVOKE ALL ON FUNCTION public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(
  p_tournament_id uuid,p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
SET statement_timeout TO '120s'
AS $cancel_with_seat_authority$
DECLARE
  v_uid uuid:=auth.uid();
  v_managed_close_owned boolean:=false;
  v_token uuid;
  v_result jsonb;
BEGIN
  -- The authenticated managed-game gateway inserts this exact processing
  -- receipt in the same transaction before its private close function reaches
  -- us. An uncommitted receipt from another backend is invisible, so this is
  -- a transaction-bound capability rather than a caller-controlled flag.
  v_managed_close_owned:=
    COALESCE(current_setting('app.managed_game_lifecycle',true),'')='on'
    AND v_uid IS NOT NULL
    AND p_admin_id IS NOT DISTINCT FROM v_uid
    AND EXISTS (
      SELECT 1 FROM public.managed_game_command_receipts r
       WHERE r.actor_id=v_uid
         AND r.game_kind='tournament'
         AND r.game_id=p_tournament_id
         AND r.command_action='close'
         AND r.status='processing');
  IF NOT public.fn_caller_is_engine()
     AND NOT v_managed_close_owned THEN
    RAISE EXCEPTION 'atomic_cancel_tournament requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'cancel',NULL);
  BEGIN
    v_result:=public.atomic_cancel_tournament_pre_seat_guard(
      p_tournament_id,p_admin_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'success')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$cancel_with_seat_authority$;

REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $satellite_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'satellite_finish',NULL);
  BEGIN
    v_result:=public.fn_settle_satellite_tournament_pre_seat_guard(
      p_tournament_id,p_observed_winner_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$satellite_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(
  p_tournament_id uuid,p_observed_winner_id uuid,p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '45s'
AS $terminal_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$terminal_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  TO service_role;

-- Elimination is a terminal transition for one seat, not a free-standing
-- cleanup. The rolling-window implementations first CAS the roster row to
-- eliminated and then release the exact zero-stack seat. That valid sequence
-- cannot use the RUNNING/playing state proof above after its roster CAS, so
-- preserve each audited implementation byte-for-byte behind an owner-only
-- name and put the same scoped capability around both public engine roots.
DO $rename_elimination_cores$
BEGIN
  IF to_regprocedure(
       'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)')
       IS NULL THEN
    ALTER FUNCTION public.fn_eliminate_tournament_player_atomic(
      uuid,uuid,integer,numeric,numeric)
      RENAME TO fn_eliminate_tournament_player_atomic_pre_seat_guard;
  END IF;
  IF to_regprocedure(
       'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)')
       IS NULL THEN
    ALTER FUNCTION public.fn_claim_tournament_bounty_elimination(
      uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
      RENAME TO fn_claim_tournament_bounty_elimination_pre_seat_guard;
  END IF;
END;
$rename_elimination_cores$;

REVOKE ALL ON FUNCTION
  public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
    uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
    uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_bubble_refund numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $elimination_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament elimination requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
      p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
      p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  END IF;
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament elimination refuses % live seats for one player',v_live_seats
      USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'elimination',p_user_id);
  BEGIN
    v_result:=public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
      p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$elimination_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint,
  p_seat_joined_at timestamptz,
  p_knocker_user_id uuid,
  p_claimants jsonb,
  p_bubble_refund numeric DEFAULT 0,
  p_allow_existing_eliminated boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $bounty_elimination_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament bounty elimination requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament bounty elimination refuses % live seats for one player',
      v_live_seats USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'elimination',p_eliminated_user_id);
  BEGIN
    v_result:=public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$bounty_elimination_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  TO service_role;

-- A table-stack cashout can never be a tournament seat-exit API. Preserve the
-- latest Diamond-aware, occupancy-bound cash implementation behind an
-- owner-only wrapper and refuse tournament parents before any credit,
-- idempotency row, session close or seat mutation. The sole service door is
-- fn_cashout_seat_occupancy; Stage-B must not reopen the retired unbound RPC.
DO $install_cashout_tournament_guard_once$
DECLARE
  v_atomic oid:=to_regprocedure(
    'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)');
  v_core oid:=to_regprocedure(
    'public.atomic_seat_cashout_locked_pre_tournament_guard(uuid,uuid,integer,text)');
  v_occupancy oid:=to_regprocedure(
    'public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)');
  v_postgres oid:='postgres'::regrole;
  v_apply boolean;
  v_verify boolean;
BEGIN
  /* PG17-derived definition hashes bind names, defaults, argument names,
     language, security mode and configuration. prosrc, owner and the exact
     direct ACL are pinned separately. There are exactly two accepted catalog
     states: the measured Diamond preimage, or this migration's full guarded
     postimage. Every mixed state refuses before the first DDL statement. */
  SELECT v_core IS NULL
         AND count(*)=2
         AND bool_and(
           md5(pg_get_functiondef(p.oid))=expected.definition_md5
           AND md5(p.prosrc)=expected.source_md5
           AND p.proowner=v_postgres
           AND p.prosecdef AND NOT p.proretset
           AND NOT p.proisstrict AND NOT p.proleakproof
           AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=expected.argument_count
           AND p.pronargdefaults=expected.default_count
           AND p.proargnames=expected.argument_names
           AND p.proconfig=ARRAY[
             'search_path=public, pg_temp','statement_timeout=30s']::text[]
           AND l.lanname='plpgsql'
           AND (
             SELECT array_agg(
                      (CASE WHEN a.grantee=0 THEN 'PUBLIC'
                            ELSE pg_get_userbyid(a.grantee) END)::name
                      ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC'
                                    ELSE pg_get_userbyid(a.grantee) END)
               FROM aclexplode(
                 COALESCE(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.privilege_type='EXECUTE'
                AND a.grantor=p.proowner AND NOT a.is_grantable
           ) IS NOT DISTINCT FROM expected.execute_grantees
           AND NOT EXISTS (
             SELECT 1
               FROM aclexplode(
                 COALESCE(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.privilege_type<>'EXECUTE'
                 OR a.grantor<>p.proowner OR a.is_grantable
           )
         )
    INTO v_apply
    FROM (
      VALUES
        (v_atomic,'e1b0b9702e75378ecac634c3a879502e'::text,
         'f0e1b852a56808d39a48e3a27603333d'::text,4,2,
         ARRAY['p_user_id','p_table_id','p_seat_number','p_leave_mode']::text[],
         ARRAY['postgres']::name[]),
        (v_occupancy,'2e60c4b66468b51061018a9058e9a395'::text,
         '1f7683406ca4d3d0ddce0e92ee8ef5e6'::text,5,1,
         ARRAY['p_user_id','p_table_id','p_seat_number','p_occupancy_id',
               'p_leave_mode']::text[],
         ARRAY['postgres','service_role']::name[])
    ) expected(function_oid,definition_md5,source_md5,argument_count,
               default_count,argument_names,execute_grantees)
    JOIN pg_proc p ON p.oid=expected.function_oid
    JOIN pg_language l ON l.oid=p.prolang;

  SELECT count(*)=3
         AND bool_and(
           md5(pg_get_functiondef(p.oid))=expected.definition_md5
           AND md5(p.prosrc)=expected.source_md5
           AND p.proowner=v_postgres
           AND p.prosecdef AND NOT p.proretset
           AND NOT p.proisstrict AND NOT p.proleakproof
           AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=expected.argument_count
           AND p.pronargdefaults=expected.default_count
           AND p.proargnames=expected.argument_names
           AND p.proconfig=ARRAY[
             'search_path=public, pg_temp','statement_timeout=30s']::text[]
           AND l.lanname='plpgsql'
           AND (
             SELECT array_agg(
                      (CASE WHEN a.grantee=0 THEN 'PUBLIC'
                            ELSE pg_get_userbyid(a.grantee) END)::name
                      ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC'
                                    ELSE pg_get_userbyid(a.grantee) END)
               FROM aclexplode(
                 COALESCE(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.privilege_type='EXECUTE'
                AND a.grantor=p.proowner AND NOT a.is_grantable
           ) IS NOT DISTINCT FROM expected.execute_grantees
           AND NOT EXISTS (
             SELECT 1
               FROM aclexplode(
                 COALESCE(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.privilege_type<>'EXECUTE'
                 OR a.grantor<>p.proowner OR a.is_grantable
           )
         )
    INTO v_verify
    FROM (
      VALUES
        (v_core,'46ccf386d5d737b8ecee34c421331681'::text,
         'f0e1b852a56808d39a48e3a27603333d'::text,4,2,
         ARRAY['p_user_id','p_table_id','p_seat_number','p_leave_mode']::text[],
         ARRAY['postgres']::name[]),
        (v_atomic,'ff53d11cf9d102ea48666c1714d699e6'::text,
         '08924758c5e10e72c38dba11d7d4c758'::text,4,2,
         ARRAY['p_user_id','p_table_id','p_seat_number','p_leave_mode']::text[],
         ARRAY['postgres']::name[]),
        (v_occupancy,'2e60c4b66468b51061018a9058e9a395'::text,
         '1f7683406ca4d3d0ddce0e92ee8ef5e6'::text,5,1,
         ARRAY['p_user_id','p_table_id','p_seat_number','p_occupancy_id',
               'p_leave_mode']::text[],
         ARRAY['postgres','service_role']::name[])
    ) expected(function_oid,definition_md5,source_md5,argument_count,
               default_count,argument_names,execute_grantees)
    JOIN pg_proc p ON p.oid=expected.function_oid
    JOIN pg_language l ON l.oid=p.prolang;

  IF v_apply THEN
    ALTER FUNCTION public.atomic_seat_cashout_locked(
      uuid,uuid,integer,text)
      RENAME TO atomic_seat_cashout_locked_pre_tournament_guard;

    REVOKE ALL ON FUNCTION
      public.atomic_seat_cashout_locked_pre_tournament_guard(
        uuid,uuid,integer,text)
      FROM PUBLIC,anon,authenticated,service_role;

    EXECUTE $cashout_wrapper_ddl$
CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(
  p_user_id uuid,p_table_id uuid,p_seat_number integer DEFAULT NULL,
  p_leave_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $cashout_not_tournament$
DECLARE
  v_tournament_id uuid;
BEGIN
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE='22023';
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  RETURN public.atomic_seat_cashout_locked_pre_tournament_guard(
    p_user_id,p_table_id,p_seat_number,p_leave_mode);
END;
$cashout_not_tournament$;
$cashout_wrapper_ddl$;

    REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(
      uuid,uuid,integer,text)
      FROM PUBLIC,anon,authenticated,service_role;
  ELSIF v_verify THEN
    NULL;
  ELSE
    RAISE EXCEPTION
      'STAGE_B_CASHOUT_UNKNOWN_PREIMAGE: exact Diamond preimage or exact guarded postimage required';
  END IF;
END;
$install_cashout_tournament_guard_once$;

CREATE OR REPLACE FUNCTION public.fn_admin_kick_player(
  p_table_id uuid,p_user_id uuid,p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $cash_admin_kick$
DECLARE
  v_uid uuid:=auth.uid();
  v_club uuid;
  v_tournament_id uuid;
  v_seat_number integer;
  v_seat_id uuid;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_kick_player requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.club_id,tb.tournament_id INTO v_club,v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_found');
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  SELECT s.id,s.seat_number INTO v_seat_id,v_seat_number
    FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_seated');
  END IF;
  PERFORM set_config('app.cash_exit_authority','club_admin',true);
  PERFORM public.fn_ca_declare_ledger('table_cashout','table_stack',p_table_id);
  BEGIN
    v_result:=public.atomic_seat_cashout_locked(
      p_user_id,p_table_id,v_seat_number,'forced');
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_exit_authority','',true);
    RAISE;
  END;
  PERFORM set_config('app.cash_exit_authority','',true);
  IF COALESCE(v_result->>'reason','')='no_active_seat' THEN
    RETURN jsonb_build_object('ok',false,'reason','not_seated');
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'refunded',COALESCE((v_result->>'stack')::numeric,0),
    'seat_id',v_seat_id,'reason_text',p_reason);
END;
$cash_admin_kick$;

REVOKE ALL ON FUNCTION public.fn_admin_kick_player(uuid,uuid,text)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_kick_player(uuid,uuid,text)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(
  p_table_id uuid,p_reopen boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cash_clear_seats$
DECLARE
  v_tournament_id uuid;
  v_cleared integer:=0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_clear_table_seats requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  PERFORM public.fn_cashout_seats_for_closing_table(p_table_id,'seats cleared');
  UPDATE public.table_seats
     SET left_at=now(),is_sitting_out=false
   WHERE table_id=p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared=ROW_COUNT;
  UPDATE public.tables
     SET current_players=0,
         status=CASE WHEN p_reopen AND status<>'closed' THEN 'waiting' ELSE status END
   WHERE id=p_table_id;
  RETURN v_cleared;
END;
$cash_clear_seats$;

REVOKE ALL ON FUNCTION public.fn_clear_table_seats(uuid,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clear_table_seats(uuid,boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.force_close_table_and_refund(
  p_table_id uuid,p_actor_id uuid DEFAULT NULL,p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cash_force_close$
DECLARE
  v_result jsonb;
  v_total numeric:=0;
  v_count integer:=0;
  v_actor uuid;
  v_tournament_id uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'force_close_table_and_refund requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','p_table_id required');
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','table_not_found');
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  v_actor:=COALESCE(
    p_actor_id,auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_result:=public.fn_cashout_seats_for_closing_table(
    p_table_id,'force-closed by admin'||COALESCE(' - '||p_reason,''));
  IF COALESCE(v_result->>'ok','false')<>'true' THEN
    RETURN jsonb_build_object('success',false,'error',v_result->>'reason');
  END IF;
  v_count:=COALESCE((v_result->>'players_paid')::integer,0);
  v_total:=COALESCE((v_result->>'chips_returned')::numeric,0);
  UPDATE public.table_seats SET left_at=now()
   WHERE table_id=p_table_id AND left_at IS NULL;
  UPDATE public.tables SET status='closed',current_players=0
   WHERE id=p_table_id;
  INSERT INTO public.audit_trail(
    actor_id,actor_role,action,target_type,target_id,amount,reason)
  VALUES(v_actor,'platform_admin','force_close_table','table',
    p_table_id,v_total,p_reason);
  RETURN jsonb_build_object(
    'success',true,'players_refunded',v_count,'total_refunded',v_total);
END;
$cash_force_close$;

REVOKE ALL ON FUNCTION public.force_close_table_and_refund(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid,uuid,text)
  TO service_role;

DO $rename_player_leave_core$
BEGIN
  IF to_regprocedure(
       'public.player_leave_table_pre_tournament_guard(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.player_leave_table(uuid,uuid)
      RENAME TO player_leave_table_pre_tournament_guard;
  END IF;
END;
$rename_player_leave_core$;

REVOKE ALL ON FUNCTION public.player_leave_table_pre_tournament_guard(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.player_leave_table(
  p_table_id uuid,p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $cash_player_leave$
DECLARE
  v_tournament_id uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'player_leave_table requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  PERFORM public.player_leave_table_pre_tournament_guard(p_table_id,p_user_id);
END;
$cash_player_leave$;

REVOKE ALL ON FUNCTION public.player_leave_table(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.player_leave_table(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_seat_move_receipt(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $move_receipt$
  SELECT jsonb_build_object(
    'ok',true,
    'request_id',r.request_id,
    'tournament_id',r.tournament_id,
    'user_id',r.user_id,
    'source_table_id',r.source_table_id,
    'destination_table_id',r.destination_table_id,
    'source_seat_id',r.source_seat_id,
    'destination_seat_id',r.destination_seat_id,
    'source_seat_number',r.source_seat_number,
    'destination_seat_number',r.destination_seat_number,
    'source_mode',r.source_mode,
    'stack',r.stack,
    'moved_at',r.moved_at)
  FROM public.tournament_seat_move_receipts r
  WHERE r.request_id=p_request_id;
$move_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_move_receipt(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- The balancer now submits one operation identity to one transaction. Source
-- release, destination occupancy, roster coordinates, table counts and the
-- replay receipt are inseparable.
DROP FUNCTION IF EXISTS public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid);
CREATE OR REPLACE FUNCTION public.fn_move_tournament_player(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_request_id uuid,
  p_source_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_move$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_source public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_destination_id uuid;
  v_token uuid;
  v_moved_at timestamptz;
  v_rows integer;
  v_live_count integer;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_move_tournament_player requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_request_id IS NULL OR p_source_table_id=p_destination_table_id
     OR p_source_mode NOT IN ('live_source','closed_orphan')
     OR p_destination_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid tournament move identity' USING ERRCODE='22023';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('table_cap:'||p_user_id::text,0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NOT NULL THEN
    IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
       OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
       OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
       OR (v_result->>'destination_table_id')::uuid
            IS DISTINCT FROM p_destination_table_id
       OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode
       OR (v_result->>'destination_seat_number')::integer
            IS DISTINCT FROM p_destination_seat_number THEN
      RAISE EXCEPTION 'tournament move request id belongs to another operation'
        USING ERRCODE='23505';
    END IF;
    RETURN v_result||jsonb_build_object('replayed',true);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF upper(COALESCE(v_t.status,''))<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament % is not RUNNING',p_tournament_id
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_tp.status<>'playing'
     OR v_tp.table_id IS DISTINCT FROM p_source_table_id THEN
    RAISE EXCEPTION 'tournament move source roster is not exact'
      USING ERRCODE='P0404';
  END IF;

  PERFORM tb.id FROM public.tables tb
   WHERE tb.id IN (p_source_table_id,p_destination_table_id)
   ORDER BY tb.id FOR UPDATE;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.id IN (p_source_table_id,p_destination_table_id)
         AND tb.tournament_id=p_tournament_id)<>2 THEN
    RAISE EXCEPTION 'tournament move tables do not share the event'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_destination_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed'
         OR p_destination_seat_number>COALESCE(tb.max_players,9))) THEN
    RAISE EXCEPTION 'tournament move destination is not open'
      USING ERRCODE='55000';
  END IF;
  IF p_source_mode='closed_orphan' AND NOT EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_source_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed')) THEN
    RAISE EXCEPTION 'closed-orphan move source is not closed'
      USING ERRCODE='55000';
  END IF;
  IF p_source_mode='live_source' AND EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_source_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed')) THEN
    RAISE EXCEPTION 'live-source move source is closed'
      USING ERRCODE='55000';
  END IF;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL;
  IF v_live_count<>1 THEN
    RAISE EXCEPTION 'tournament move requires exactly one live source seat'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_source FROM public.table_seats s
   WHERE s.table_id=p_source_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_source.seat_number IS DISTINCT FROM v_tp.seat_number
     OR v_source.stack IS NULL
     OR v_source.stack::text IN ('NaN','Infinity','-Infinity')
     OR v_source.stack<=0
     OR abs(v_source.stack-v_tp.chips::numeric)>0.5 THEN
    RAISE EXCEPTION 'tournament move source chips or coordinates are not exact'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_destination_table_id
     AND s.seat_number=p_destination_seat_number FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RAISE EXCEPTION 'tournament move destination seat is occupied'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id<>p_user_id
       AND tp.status IN ('registered','playing')
       AND tp.table_id=p_destination_table_id
       AND tp.seat_number=p_destination_seat_number) THEN
    RAISE EXCEPTION 'tournament move destination roster is occupied'
      USING ERRCODE='23505';
  END IF;

  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'move',p_user_id);
  v_moved_at:=clock_timestamp();
  BEGIN
    UPDATE public.table_seats s
       SET stack=0,left_at=v_moved_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
     WHERE s.id=v_source.id AND s.left_at IS NULL
       AND s.stack=v_source.stack;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked source seat'
        USING ERRCODE='40001';
    END IF;

    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,seat_number,user_id,player_id,member_id,stack,
        is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,
        left_at,status,leave_pending,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,sit_out_at,entry_hold,entry_post_agreed)
      VALUES(
        p_destination_table_id,p_destination_seat_number,p_user_id,
        v_source.player_id,v_source.member_id,v_source.stack,
        false,false,v_moved_at,v_source.horse_id,NULL,NULL,'active',false,
        v_source.auto_rebuy,v_source.time_bank_remaining,
        v_source.time_bank_uses_remaining,NULL,NULL,
        v_source.entry_post_agreed)
      RETURNING id INTO v_destination_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=v_source.player_id,
             member_id=v_source.member_id,stack=v_source.stack,
             is_sitting_out=false,is_away=false,joined_at=v_moved_at,
             horse_id=v_source.horse_id,scheduled_leave_hands=NULL,
             left_at=NULL,status='active',leave_pending=false,
             auto_rebuy=v_source.auto_rebuy,
             time_bank_remaining=v_source.time_bank_remaining,
             time_bank_uses_remaining=v_source.time_bank_uses_remaining,
             sit_out_at=NULL,entry_hold=NULL,
             entry_post_agreed=v_source.entry_post_agreed
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_destination_id;
      IF v_destination_id IS NULL THEN
        RAISE EXCEPTION 'tournament move could not reuse destination seat'
          USING ERRCODE='40001';
      END IF;
    END IF;

    UPDATE public.tournament_players tp
       SET table_id=p_destination_table_id,
           seat_number=p_destination_seat_number
     WHERE tp.id=v_tp.id AND tp.status='playing'
       AND tp.table_id=p_source_table_id
       AND tp.seat_number=v_source.seat_number;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked roster row'
        USING ERRCODE='40001';
    END IF;

    UPDATE public.tables tb
       SET current_players=(
         SELECT count(*) FROM public.table_seats s
          WHERE s.table_id=tb.id AND s.left_at IS NULL),
           updated_at=now()
     WHERE tb.id IN (p_source_table_id,p_destination_table_id);

    IF (SELECT count(*) FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=p_tournament_id
         AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_destination_id
            AND s.table_id=p_destination_table_id
            AND s.seat_number=p_destination_seat_number
            AND s.user_id=p_user_id AND s.left_at IS NULL
            AND s.stack=v_source.stack)
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_source.id AND s.left_at=v_moved_at AND s.stack=0)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.id=v_tp.id AND tp.status='playing'
            AND tp.table_id=p_destination_table_id
            AND tp.seat_number=p_destination_seat_number) THEN
      RAISE EXCEPTION 'tournament move final proof is not exact'
        USING ERRCODE='P0404';
    END IF;

    INSERT INTO public.tournament_seat_move_receipts(
      request_id,tournament_id,user_id,source_table_id,destination_table_id,
      source_seat_id,destination_seat_id,source_seat_number,
      destination_seat_number,source_mode,stack,moved_at)
    VALUES(
      p_request_id,p_tournament_id,p_user_id,p_source_table_id,
      p_destination_table_id,v_source.id,v_destination_id,
      v_source.seat_number,p_destination_seat_number,p_source_mode,
      v_source.stack,v_moved_at);

    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'tournament move receipt did not persist'
      USING ERRCODE='P0404';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',false);
END;
$atomic_tournament_move$;

REVOKE ALL ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid,text) TO service_role;

-- Unfilled Spins still expire, but the candidate scan is never cancellation
-- authority. Re-read the board only after the canonical terminal root and
-- parent lock are held; a funded, filled or newly launched Spin is skipped.
-- Cancellation itself owns every refund and count. There is no post-cancel
-- counter reconciler and no estimate presented as money returned.
CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $expire_unfilled_without_reconciler$
DECLARE
  v_minutes integer;
  g record;
  v_current record;
  v_skipped integer:=0;
  v_result jsonb;
  v_expired integer:=0;
  v_failed integer:=0;
  v_refunded numeric:=0;
  v_ids jsonb:='[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_spin_expire_unfilled requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT unfilled_timeout_minutes INTO v_minutes
    FROM public.spin_fill_policy LIMIT 1;
  v_minutes:=COALESCE(v_minutes,30);
  IF v_minutes<=0 THEN
    RETURN jsonb_build_object('ok',true,'disabled',true,'expired',0);
  END IF;

  -- Every terminal owner takes this root before its first tournament row.
  -- The first atomic cancellation would hold it for the transaction anyway;
  -- taking it explicitly here keeps the fresh parent re-read in that order.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  FOR g IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.variant='spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND t.started_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
         JOIN public.tables tb ON tb.id=s.table_id
          WHERE tb.tournament_id=t.id AND s.left_at IS NULL
            AND s.joined_at<now()-make_interval(mins=>v_minutes))
       AND (SELECT count(*) FROM public.table_seats s
             JOIN public.tables tb ON tb.id=s.table_id
            WHERE tb.tournament_id=t.id AND s.left_at IS NULL)
           <COALESCE(t.max_players,3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit,50),1)
  LOOP
    -- The scan above is only a candidate list. A final join or launch may
    -- commit before this row is reached. Lock first, then read a fresh board
    -- snapshot in a separate statement.
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=g.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_skipped:=v_skipped+1;
      CONTINUE;
    END IF;

    SELECT t.status,t.variant,t.started_at,t.spin_multiplier,t.buy_in_amount,
           COALESCE(t.max_players,3) AS max_players,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL) AS live_seats,
           EXISTS(SELECT 1 FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL
               AND s.joined_at<now()-make_interval(mins=>v_minutes))
             AS has_expired_waiter,
           EXISTS(SELECT 1 FROM public.spin_reserve_ledger l
             WHERE l.tournament_id=t.id AND l.kind='jackpot_draw')
             OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r
               WHERE r.tournament_id=t.id) AS has_booked_draw
      INTO v_current FROM public.tournaments t WHERE t.id=g.id;

    IF v_current.variant IS DISTINCT FROM 'spin'
       OR v_current.status NOT IN ('REGISTERING','ANNOUNCED')
       OR v_current.status IS NULL
       OR v_current.started_at IS NOT NULL
       OR v_current.live_seats>=v_current.max_players
       OR NOT v_current.has_expired_waiter
       OR v_current.spin_multiplier IS NOT NULL
       OR v_current.has_booked_draw THEN
      v_skipped:=v_skipped+1;
      CONTINUE;
    END IF;

    BEGIN
      v_result:=public.atomic_cancel_tournament(g.id,NULL);
      IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'atomic cancellation returned no success receipt';
      END IF;
      v_expired:=v_expired+1;
      v_refunded:=v_refunded+
        COALESCE((v_result->>'total_refunded')::numeric,0);
      v_ids:=v_ids||to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %',g.id,SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object(
    'ok',v_failed=0,'expired',v_expired,'failed',v_failed,
    'skipped_raced',v_skipped,
    'chips_refunded',round(v_refunded,2),'timeout_minutes',v_minutes,
    'tournament_ids',v_ids);
END;
$expire_unfilled_without_reconciler$;

REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer)
  TO service_role;

-- The minute denormal reconciler used to repair a newly opened late-
-- registration table's missing stakes. Write the display contract in the
-- same INSERT that creates the table instead. This is the complete installed
-- implementation, not a dynamic source rewrite; all existing behavior and
-- the private nested-call ACL remain explicit.
CREATE OR REPLACE FUNCTION
  public.fn_seat_late_registrant_before_maintenance_gate(
    p_tournament_id uuid,p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $late_seat_without_reconciler$
DECLARE
  v_status text;
  v_start_chips integer;
  v_club uuid;
  v_bonus integer;
  v_chips integer;
  v_table uuid;
  v_cap integer;
  v_seat integer;
  v_taken integer;
  v_opened boolean:=false;
  v_sb numeric;
  v_bb numeric;
  v_bs varchar;
  v_tclub uuid;
  v_tno integer;
BEGIN
  PERFORM set_config('app.money_path','fn_seat_late_registrant',true);
  SELECT status,COALESCE(starting_chips,0),club_id
    INTO v_status,v_start_chips,v_club
    FROM public.tournaments WHERE id=p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','not_running');
  END IF;

  SELECT COALESCE(chips,0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id
     AND user_id=p_user_id
     AND table_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.user_id=p_user_id AND s.left_at IS NULL)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','already_seated_or_missing');
  END IF;

  v_chips:=v_start_chips+GREATEST(v_bonus,0);

  SELECT tb.id,COALESCE(tb.max_players,9)
    INTO v_table,v_cap
    FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id
     AND lower(COALESCE(tb.status,'')) IN ('waiting','running','active')
     AND (SELECT count(*) FROM public.table_seats s
           WHERE s.table_id=tb.id AND s.left_at IS NULL)
         <COALESCE(tb.max_players,9)
   ORDER BY (SELECT count(*) FROM public.table_seats s
              WHERE s.table_id=tb.id AND s.left_at IS NULL) DESC,
            tb.created_at ASC
   LIMIT 1
   FOR UPDATE OF tb;

  IF v_table IS NULL THEN
    SELECT COALESCE(tb.max_players,9),tb.small_blind,tb.big_blind,
           tb.blind_structure,COALESCE(tb.club_id,v_club)
      INTO v_cap,v_sb,v_bb,v_bs,v_tclub
      FROM public.tables tb
     WHERE tb.tournament_id=p_tournament_id
     ORDER BY tb.created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
      SELECT COALESCE(t.table_size,9) INTO v_cap
        FROM public.tournaments t WHERE t.id=p_tournament_id;
      v_sb:=1;
      v_bb:=2;
      v_bs:='standard';
      v_tclub:=v_club;
    END IF;

    IF v_sb IS NULL OR v_bb IS NULL OR v_sb<=0 OR v_bb<v_sb THEN
      RAISE EXCEPTION 'late-registration table has invalid blind authority'
        USING ERRCODE='P0404';
    END IF;

    SELECT count(*)+1 INTO v_tno
      FROM public.tables WHERE tournament_id=p_tournament_id;

    INSERT INTO public.tables(
      name,tournament_id,club_id,max_players,small_blind,big_blind,
      stakes,blind_structure,status,current_players)
    VALUES(
      'Table '||v_tno,p_tournament_id,v_tclub,v_cap,v_sb,v_bb,
      trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text,
      COALESCE(v_bs,'standard'),'waiting',0)
    RETURNING id INTO v_table;
    v_opened:=true;
  END IF;

  SELECT g.n INTO v_seat
    FROM generate_series(1,v_cap) AS g(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats s
      WHERE s.table_id=v_table AND s.seat_number=g.n
        AND s.left_at IS NULL)
   ORDER BY g.n LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','no_open_seat');
  END IF;

  UPDATE public.table_seats
     SET user_id=p_user_id,stack=v_chips,left_at=NULL,joined_at=now(),
         is_sitting_out=false,is_away=false,
         club_id=COALESCE(club_id,v_club)
   WHERE table_id=v_table AND seat_number=v_seat AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats(
        table_id,user_id,seat_number,stack,club_id)
      VALUES(v_table,p_user_id,v_seat,v_chips,v_club);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok',false,'reason','seat_race');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status='playing',chips=v_chips,table_id=v_table,
         seat_number=v_seat
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id;

  SELECT count(*) INTO v_taken
    FROM public.table_seats
   WHERE table_id=v_table AND left_at IS NULL;
  UPDATE public.tables SET current_players=v_taken WHERE id=v_table;

  RETURN jsonb_build_object(
    'ok',true,'table_id',v_table,'seat_number',v_seat,'chips',v_chips,
    'opened_table',v_opened);
END;
$late_seat_without_reconciler$;

REVOKE ALL ON FUNCTION
  public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Table Management can also change blinds. Keep its complete current
-- implementation, but write stakes beside those blinds in the same UPDATE
-- and restore the intended private gateway ACL explicitly.
CREATE OR REPLACE FUNCTION public.fn_update_managed_game(
  p_kind text,p_game_id uuid,p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $managed_update_without_reconciler$
DECLARE
  v_uid uuid:=auth.uid();
  v_club uuid;
  v_players integer;
  v_status text;
  v_name text;
  v_sb numeric;
  v_bb numeric;
  v_min numeric;
  v_max numeric;
  v_seats integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;

  IF p_kind='table' THEN
    SELECT club_id,current_players,status
      INTO v_club,v_players,v_status
      FROM public.tables WHERE id=p_game_id FOR UPDATE;
  ELSIF p_kind='tournament' THEN
    SELECT club_id,current_players,status
      INTO v_club,v_players,v_status
      FROM public.tournaments WHERE id=p_game_id FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok',false,'reason','invalid_game_kind');
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;

  v_name:=left(regexp_replace(COALESCE(p_patch->>'name',''),'\s+',' ','g'),80);
  IF length(trim(v_name))=0 THEN
    RETURN jsonb_build_object('ok',false,'reason','name_required');
  END IF;

  IF p_kind='table' THEN
    IF v_players>0 OR lower(v_status) IN ('running','active') THEN
      UPDATE public.tables SET name=v_name,updated_at=now()
       WHERE id=p_game_id;
    ELSE
      SELECT COALESCE((p_patch->>'small_blind')::numeric,t.small_blind),
             COALESCE((p_patch->>'big_blind')::numeric,t.big_blind),
             COALESCE((p_patch->>'min_buy_in')::numeric,t.min_buy_in),
             COALESCE((p_patch->>'max_buy_in')::numeric,t.max_buy_in),
             COALESCE((p_patch->>'max_players')::integer,t.max_players)
        INTO v_sb,v_bb,v_min,v_max,v_seats
        FROM public.tables t WHERE t.id=p_game_id;

      IF v_sb IS NULL OR v_bb IS NULL OR v_min IS NULL OR v_max IS NULL
         OR v_seats IS NULL OR v_sb<=0 OR v_bb<v_sb OR v_min<=0
         OR v_max<v_min THEN
        RETURN jsonb_build_object('ok',false,'reason','invalid_table_limits');
      END IF;

      UPDATE public.tables
         SET name=v_name,small_blind=v_sb,big_blind=v_bb,
             stakes=trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text,
             min_buy_in=v_min,max_buy_in=v_max,
             max_players=LEAST(10,GREATEST(2,v_seats)),updated_at=now()
       WHERE id=p_game_id;
    END IF;
  ELSE
    PERFORM 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_game_id FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','players_registered');
    END IF;
    IF upper(v_status) NOT IN ('ANNOUNCED','REGISTERING','SCHEDULED') THEN
      RETURN jsonb_build_object('ok',false,'reason','already_started');
    END IF;

    UPDATE public.tournaments
       SET name=v_name,
           max_players=GREATEST(
             2,COALESCE((p_patch->>'max_players')::integer,max_players)),
           start_time=COALESCE(
             (p_patch->>'start_time')::timestamptz,start_time),
           updated_at=now()
     WHERE id=p_game_id;
  END IF;

  RETURN jsonb_build_object('ok',true);
END;
$managed_update_without_reconciler$;

REVOKE ALL ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb)
  TO service_role;

-- Fail closed unless the catalog still has exactly the audited watcher shape
-- and no executable dependency. The minute job is then unscheduled while its
-- catalog and advisory lock remain held, and both legacy mutators are dropped
-- with RESTRICT rather than hidden behind a revoke.
--
-- The transaction-start gate already owns terminal settlement and the durable
-- maintenance barrier. Acquire only the reconciler's own session-lock key here.
-- A running invocation must finish before this transaction can continue, while
-- every later pg_try_advisory_lock invocation skips until the cron row and
-- callable authority are retired in this same transaction.
SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'));

DO $legacy_reconciler_preflight$
DECLARE
  v_reconciler oid:=to_regprocedure(
    'public.fn_reconcile_tournament_denormals()');
  v_release oid:=to_regprocedure(
    'public.fn_release_seats_on_tournament_finish()');
  v_release_trigger oid;
  j record;
BEGIN
  SELECT tg.oid INTO v_release_trigger
    FROM pg_trigger tg
   WHERE tg.tgrelid='public.tournaments'::regclass
     AND tg.tgname='trg_release_seats_on_tournament_finish'
     AND NOT tg.tgisinternal
     AND tg.tgfoid=v_release
     AND tg.tgtype=17
     AND tg.tgenabled='O';
  IF v_reconciler IS NULL OR v_release IS NULL
     OR v_release_trigger IS NULL THEN
    RAISE EXCEPTION 'legacy tournament reconciler/watch trigger shape changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_depend d
     WHERE d.refclassid='pg_proc'::regclass
       AND d.refobjid=v_reconciler)
     OR EXISTS (
    SELECT 1 FROM pg_depend d
     WHERE d.refclassid='pg_proc'::regclass
       AND d.refobjid=v_release
       AND NOT (d.classid='pg_trigger'::regclass
            AND d.objid=v_release_trigger AND d.deptype='n')) THEN
    RAISE EXCEPTION 'unexpected catalog dependency on a retired reconciler';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.oid NOT IN (v_reconciler,v_release)
       AND (p.prosrc LIKE '%fn_reconcile_tournament_denormals(%'
         OR p.prosrc LIKE '%fn_release_seats_on_tournament_finish(%')) THEN
    RAISE EXCEPTION 'an executable function still calls a retired reconciler';
  END IF;

  FOR j IN
    SELECT jobid FROM cron.job
     WHERE jobname='reconcile-tournament-denormals'
        OR command LIKE '%fn_reconcile_tournament_denormals(%'
     ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname='reconcile-tournament-denormals'
        OR command LIKE '%fn_reconcile_tournament_denormals(%') THEN
    RAISE EXCEPTION 'tournament denormal reconciler cron survived unschedule';
  END IF;

  IF EXISTS (
    WITH live_seat AS (
      SELECT s.user_id,tb.tournament_id,s.table_id,s.seat_number,
             row_number() OVER (
               PARTITION BY tb.tournament_id,s.user_id
               ORDER BY s.joined_at DESC NULLS LAST,s.id) AS rn
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL)
    SELECT 1 FROM public.tournament_players tp
    JOIN live_seat ls ON ls.rn=1
      AND tp.tournament_id=ls.tournament_id AND tp.user_id=ls.user_id
     WHERE tp.status IN ('registered','playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number))
     OR EXISTS (
    SELECT 1 FROM public.tables tb
    JOIN public.tournaments t ON t.id=tb.tournament_id
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
       AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
       AND tb.stakes IS DISTINCT FROM
           trim_scale(tb.small_blind)::text||'/'||
           trim_scale(tb.big_blind)::text) THEN
    RAISE EXCEPTION 'tournament denormal cutover left roster or stakes drift';
  END IF;

  IF EXISTS (
    WITH seat_first AS (
      SELECT t.id
        FROM public.tournaments t
       WHERE upper(COALESCE(t.status::text,'')) IN
               ('RUNNING','REGISTERING','ANNOUNCED')
         AND (lower(COALESCE(t.variant,'')) IN ('spin','sng')
           OR COALESCE(t.max_players,0)<=2)), ranked AS (
      SELECT tb.id,
             (SELECT count(*) FROM public.table_seats s
               WHERE s.table_id=tb.id AND s.left_at IS NULL) AS seats,
             public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
        FROM public.tables tb
        JOIN seat_first sf ON sf.id=tb.tournament_id
       WHERE lower(COALESCE(tb.status,''))<>'closed')
    SELECT 1 FROM ranked
     WHERE seats=0 AND keep_id IS NOT NULL AND keep_id<>id)
     OR EXISTS (
    WITH truth AS (
      SELECT t.id,
             (lower(COALESCE(t.variant,'')) IN ('spin','sng')
               OR COALESCE(t.max_players,0)<=2) AS is_seat_first,
             public.fn_tournament_primary_table(t.id) AS primary_table,
             CASE
               WHEN lower(COALESCE(t.variant,'')) IN ('spin','sng')
                    OR COALESCE(t.max_players,0)<=2 THEN (
                 SELECT count(*) FROM public.table_seats s
                  WHERE s.table_id=public.fn_tournament_primary_table(t.id)
                    AND s.left_at IS NULL)
               ELSE (
                 SELECT count(*) FROM public.tournament_players tp
                  WHERE tp.tournament_id=t.id
                    AND tp.status IN ('registered','playing'))
             END AS real_count
        FROM public.tournaments t
       WHERE upper(COALESCE(t.status::text,'')) IN
               ('RUNNING','REGISTERING','ANNOUNCED'))
    SELECT 1 FROM public.tournaments t
    JOIN truth ON truth.id=t.id
     WHERE NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players,-1)
           IS DISTINCT FROM truth.real_count) THEN
    RAISE EXCEPTION
      'tournament denormal cutover left duplicate or player-count drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid=
       'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
       AND p.prosrc LIKE '%stakes%trim_scale(v_sb)%trim_scale(v_bb)%'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public'])
     OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure
       AND p.prosrc LIKE '%stakes=trim_scale(v_sb)%trim_scale(v_bb)%'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public'])
     OR has_function_privilege(
       'authenticated','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'a hard-coded reconciler replacement is incomplete';
  END IF;
END;
$legacy_reconciler_preflight$;

DROP TRIGGER trg_release_seats_on_tournament_finish ON public.tournaments;
DROP FUNCTION public.fn_release_seats_on_tournament_finish() RESTRICT;
DROP FUNCTION public.fn_reconcile_tournament_denormals() RESTRICT;

-- The remaining delayed cleanup owners are likewise obsolete. Terminal and
-- cancellation receipts close their own felt, and production dependency/
-- cron/call probes are empty.
DROP TRIGGER IF EXISTS trg_clear_seats_on_game_end ON public.tournaments;
DROP FUNCTION IF EXISTS public.fn_clear_seats_on_game_end();
DROP FUNCTION IF EXISTS public.fn_spin_reap_stale_boards(
  integer,boolean,boolean,integer);

-- The amount-trusting unregister RPC and its counter wrapper predate immutable
-- entry entitlements. Neither can identify the wallet rail that paid for an
-- entry, and the amount-taking RPC can therefore manufacture the wrong refund.
-- The exact entitlement authority above is the only supported unregister
-- owner. Prove the two obsolete signatures have no executable caller before
-- dropping them without CASCADE; keep historical audit/registry rows intact.
DO $legacy_unregister_preflight$
DECLARE
  v_atomic oid:=to_regprocedure(
    'public.atomic_tournament_unregister(uuid,uuid,numeric)');
  v_counter oid:=to_regprocedure(
    'public.fn_tournament_unregister_counter(uuid,numeric)');
  v_carriers text[];
BEGIN
  IF v_atomic IS NULL OR v_counter IS NULL THEN
    RAISE EXCEPTION
      'legacy tournament unregister signatures changed before exact retirement';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_depend d
     WHERE d.refclassid='pg_proc'::regclass
       AND d.refobjid IN (v_atomic,v_counter)
  ) THEN
    RAISE EXCEPTION
      'a catalog object still depends on a legacy tournament unregister signature';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.oid NOT IN (v_atomic,v_counter)
       AND (
         p.prosrc ~ 'atomic_tournament_unregister[[:space:]]*\('
         OR p.prosrc ~ 'fn_tournament_unregister_counter[[:space:]]*\('
       )
  ) THEN
    RAISE EXCEPTION
      'an executable function body still calls a legacy tournament unregister signature';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname=ANY(ARRAY[
         'atomic_seat_horse',
         'atomic_table_withdraw',
         'distribute_tournament_prizes'
       ])
  ) THEN
    RAISE EXCEPTION 'a retired wallet writer has been recreated';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.oid<>'public.guard_wallet_balance_write()'::regprocedure
       AND (
         p.prosrc LIKE '%atomic_seat_horse%'
         OR p.prosrc LIKE '%atomic_table_withdraw%'
         OR p.prosrc LIKE '%distribute_tournament_prizes%'
       )
  ) THEN
    RAISE EXCEPTION 'a function body still names a retired wallet writer';
  END IF;

  SELECT COALESCE(array_agg(p.proname::text ORDER BY p.proname),ARRAY[]::text[])
    INTO v_carriers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.oid<>v_atomic
     AND p.prosrc LIKE '%atomic_tournament_unregister%';
  IF v_carriers IS DISTINCT FROM ARRAY[
       'fn_club_arena_global_wallet_check',
       'fn_union_money_path_check',
       'fn_union_overload_check',
       'guard_wallet_balance_write'
     ]::text[] THEN
    RAISE EXCEPTION
      'unexpected legacy unregister source carriers: %',v_carriers;
  END IF;
END;
$legacy_unregister_preflight$;

DROP FUNCTION public.atomic_tournament_unregister(uuid,uuid,numeric);
DROP FUNCTION public.fn_tournament_unregister_counter(uuid,numeric);

-- The browser has moved to request-keyed exits, which are the only public
-- shapes capable of proving whether a lost response is a replay. The one-arg
-- unregister and seat-leave wrappers manufacture a new request identity on
-- every retry, while the admin-removal wrapper has no runtime caller at all.
-- Refuse the cutover if any stored database object still calls or depends on
-- one of those signatures, then remove them with RESTRICT. The two request-id
-- overloads remain the complete supported browser contract.
DO $legacy_public_exit_preflight$
DECLARE
  v_signature text;
  v_name text;
  v_oid oid;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid)',
    'public.fn_leave_seat_and_refund(uuid)',
    'public.fn_admin_remove_tournament_player(uuid,uuid)'
  ] LOOP
    v_oid:=to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION
        'obsolete public tournament exit changed before retirement: %',
        v_signature;
    END IF;
    SELECT p.proname::text INTO STRICT v_name FROM pg_proc p WHERE p.oid=v_oid;
    IF EXISTS (
      SELECT 1 FROM pg_depend d
       WHERE d.refclassid='pg_proc'::regclass AND d.refobjid=v_oid
    ) THEN
      RAISE EXCEPTION
        'a catalog object still depends on obsolete tournament exit: %',
        v_signature;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.oid<>v_oid
         AND p.prosrc ~ (v_name||'[[:space:]]*\(')
    ) THEN
      RAISE EXCEPTION
        'a stored function still calls obsolete tournament exit: %',
        v_signature;
    END IF;
  END LOOP;
END;
$legacy_public_exit_preflight$;

DROP FUNCTION public.fn_unregister_from_tournament(uuid) RESTRICT;
DROP FUNCTION public.fn_leave_seat_and_refund(uuid) RESTRICT;
DROP FUNCTION public.fn_admin_remove_tournament_player(uuid,uuid) RESTRICT;

-- Re-emit every current diagnostic/guard body in full. This is deliberately
-- static SQL: no pg_get_functiondef rewrite can silently splice a future body.
CREATE OR REPLACE FUNCTION public.fn_club_arena_global_wallet_check()
RETURNS TABLE(fn text,detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $global_wallet_check_without_legacy_unregister$
  SELECT p.proname::text,
         'Club Arena money path references the global wallets table - every club '
         || 'must be its own standalone wallet, never joined or pooled'
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','process_tournament_rebuy',
       'atomic_cancel_tournament','fn_pay_player_chips',
       'atomic_pay_player_rakeback','credit_player_rakeback')
       -- atomic_pay_agent_settlement was here until phase 7 dropped it.
     AND p.prosrc ~* '(update|insert into|from)\s+(public\.)?wallets\M';
$global_wallet_check_without_legacy_unregister$;

CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
RETURNS TABLE(fn text,detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $union_money_path_without_legacy_unregister$
  SELECT x.fn,
         'money path no longer reaches club scope (directly or through any '
         || 'function it calls, to 4 levels) - club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('atomic_tournament_register'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback')
            -- transfer_chips_agent_to_player was here. It is dropped: it
            -- debited the agent's PLAYER wallet, its only caller was an unused
            -- World Hub route, and fn_agent_wallet_send is the path.
            --
            -- atomic_pay_agent_settlement was here until phase 7, and is
            -- dropped for the same shape of reason: staff paying an agent out
            -- of a column nothing maintained, against Dan's ruling that agents
            -- claim their own. What replaces it, fn_agent_claim_commission, is
            -- club-scoped by construction - it takes p_club_id, locks that
            -- club's row and debits that club's treasury - so there is nothing
            -- here for this check to discover about it.
         ) AS x(fn)
   -- A function that has been deleted outright is still a breach; one that
   -- exists but cannot reach club scope is the breach this was written for.
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname=x.fn)
      OR NOT public.fn_money_path_reaches_club_scope(x.fn,4);
$union_money_path_without_legacy_unregister$;

CREATE OR REPLACE FUNCTION public.fn_union_overload_check()
RETURNS TABLE(fn text,signatures bigint,detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $union_overload_without_legacy_unregister$
  SELECT p.proname::text,count(*),
         'money-path function has multiple signatures - callers may silently hit '
         || 'the stale one (this has already happened three times: buy-in, '
         || 'cascading commission, tournament register)'
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','process_tournament_rebuy',
       'calculate_cascading_commission','credit_agent_commission_from_rake',
       'atomic_distribute_rake','record_tournament_buyin_rake',
       'fn_pay_player_chips'
       -- atomic_pay_agent_settlement was here until phase 7 dropped it.
     )
   GROUP BY p.proname
  HAVING count(*)>1;
$union_overload_without_legacy_unregister$;

CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $wallet_guard_without_legacy_unregister$
DECLARE
  v_stack text;
  v_bypass text;
  v_allowed text[]:=ARRAY[
    'atomic_credit_wallet_and_log','atomic_deduct_wallet_and_log','atomic_wallet_transfer',
    'atomic_chip_transfer','fn_idempotent_credit_wallet','fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer','atomic_table_buyin','atomic_table_cashout',
    'atomic_table_rebuy','atomic_table_addon','player_leave_table','atomic_tournament_register',
    'atomic_cancel_tournament',
    'process_tournament_rebuy',
    'atomic_pay_player_rakeback','credit_agent_commission',
    'credit_player_rakeback','fn_cancel_cashout','fn_reject_cashout',
    'fn_clawback_chips_atomic','distribute_chips','mint_club_chips','add_chips','add_to_promo_wallet',
    'credit_player_wallet','deduct_player_wallet','wallet_internal_transfer','wallet_user_transfer',
    'create_user_wallets','reconcile_ledger_nightly',
    -- added 2026-08-15 with the chip-removal authority policy
    'fn_admin_remove_player_chips','fn_approve_cashout_atomic','fn_cancel_cashout_atomic',
    -- added 2026-08-21 with the diamond-backed Chip Mint (Dan's directive)
    'fn_mint_chips_from_diamonds',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    'fn_club_bank_send',
    'fn_club_bank_claim_back','fn_promo_wallet_send',
    'fn_club_bank_reverse'
    -- removed 2026-08-31 (phase 6): execute_commission_payout, which credited a
    -- wallet, debited nothing and never marked the commission settled.
    -- removed 2026-09-01 (phase 7): atomic_pay_agent_settlement, a staff payout
    -- that decremented a column nothing incremented.
  ];
  v_fn text;
BEGIN
  v_bypass:=current_setting('app.bypass_wallet_guard',true);
  IF v_bypass='on' THEN RETURN NEW; END IF;
  GET DIAGNOSTICS v_stack=PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?'||v_fn||'\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION
    'Direct balance mutation on %.% is forbidden by Phase 4.1.6a guard. '
    'All balance changes must flow through the whitelisted SECURITY DEFINER '
    'RPCs (atomic_*, fn_idempotent_*, distribute_chips, mint_club_chips, etc.) '
    'that log to chip_ledger. Admin override: '
    'SELECT set_config(''app.bypass_wallet_guard'', ''on'', true);',
    TG_TABLE_SCHEMA,TG_TABLE_NAME
    USING ERRCODE='insufficient_privilege';
END;
$wallet_guard_without_legacy_unregister$;

REVOKE ALL ON FUNCTION public.guard_wallet_balance_write()
  FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the service-only diagnostic contract explicitly after replacement.
REVOKE ALL ON FUNCTION public.fn_club_arena_global_wallet_check()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_arena_global_wallet_check()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_money_path_check()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_money_path_check()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_overload_check()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overload_check()
  TO service_role;

-- Every supported roster exit now enters through an owner-executed authority.
-- service_role must not retain a raw DELETE fallback around those receipts.
REVOKE DELETE ON TABLE public.tournament_players FROM service_role;

DO $legacy_unregister_cutover_proof$
DECLARE
  v_signature text;
  v_source text;
  v_delete_owners integer;
BEGIN
  IF to_regprocedure(
       'public.atomic_tournament_unregister(uuid,uuid,numeric)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_tournament_unregister_counter(uuid,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy tournament unregister signatures still exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname=ANY(ARRAY[
         'atomic_seat_horse',
         'atomic_table_withdraw',
         'distribute_tournament_prizes'
       ])
  ) THEN
    RAISE EXCEPTION 'a retired wallet writer still exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND (p.prosrc LIKE '%atomic_tournament_unregister%'
         OR p.prosrc LIKE '%fn_tournament_unregister_counter%'
         OR p.prosrc LIKE '%atomic_seat_horse%'
         OR p.prosrc LIKE '%atomic_table_withdraw%'
         OR p.prosrc LIKE '%distribute_tournament_prizes%')
  ) THEN
    RAISE EXCEPTION 'a persistent function body still names a retired wallet writer';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_club_arena_global_wallet_check()',
    'public.fn_union_money_path_check()',
    'public.fn_union_overload_check()'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature)
            AND p.prosecdef
            AND p.proconfig @> ARRAY['search_path=public']
       ) THEN
      RAISE EXCEPTION 'diagnostic ACL or definer contract changed: %',v_signature;
    END IF;
  END LOOP;

  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid='public.guard_wallet_balance_write()'::regprocedure
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public']
     AND NOT has_function_privilege(
       'anon','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'authenticated','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'service_role','public.guard_wallet_balance_write()','EXECUTE');
  IF v_source IS NULL
     OR v_source LIKE '%atomic_tournament_unregister%' THEN
    RAISE EXCEPTION 'wallet write guard did not retain its invoker contract';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid,uuid)',
    'public.fn_leave_seat_and_refund(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef
       ) THEN
      RAISE EXCEPTION 'supported tournament exit RPC changed: %',v_signature;
    END IF;
    SELECT p.prosrc INTO v_source
      FROM pg_proc p WHERE p.oid=to_regprocedure(v_signature);
    IF v_source IS NULL
       OR v_source NOT LIKE '%public.fn_caller_session_is_live()%' THEN
      RAISE EXCEPTION
        'tournament exit RPC no longer refuses a revoked session: %',
        v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid)',
    'public.fn_leave_seat_and_refund(uuid)',
    'public.fn_admin_remove_tournament_player(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NOT NULL THEN
      RAISE EXCEPTION 'obsolete public tournament exit still exists: %',
        v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_players','DELETE') THEN
    RAISE EXCEPTION 'tournament roster exit ACL has a bypass';
  END IF;

  SELECT count(*)
    INTO v_delete_owners
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players';
  IF v_delete_owners<>1 OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid=
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)'::regprocedure
       AND p.prosrc ~*
         'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players'
  ) THEN
    RAISE EXCEPTION
      'unexpected direct tournament roster delete owner count: %',v_delete_owners;
  END IF;

  -- The payer's source wallet and the fee recipient are independent clubs.
  -- Pin the exact-source contract before this migration hides the unregister
  -- core behind its seat capability wrapper: positive rake is discovered by
  -- immutable journal identity, grouped by rake_records.club_id, and every
  -- negative row names the original positive rows it reverses. The old
  -- refund_wallet_club_id grouping is explicitly forbidden.
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%v_fee_source_rake_record_ids%'
     OR v_source NOT LIKE '%GROUP BY r.club_id%'
     OR v_source NOT LIKE '%fee_recipient_club_id%'
     OR v_source NOT LIKE '%original_rake_record_ids%'
     OR v_source NOT LIKE '%fee_reversal_ids%'
     OR v_source NOT LIKE '%fees_reversed%'
     OR v_source LIKE '%SELECT e.refund_wallet_club_id AS club_id%'
     OR v_source LIKE '%GROUP BY e.refund_wallet_club_id%' THEN
    RAISE EXCEPTION
      'tournament unregistration no longer reverses the exact fee recipient';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%v_r.fees_reversed IS DISTINCT FROM v_entitlement_fee%'
     OR v_source NOT LIKE '%v_fee_source_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids%'
     OR v_source NOT LIKE '%original.club_id=reversal.club_id%'
     OR v_source NOT LIKE '%original_rake_record_ids%'
     OR v_source NOT LIKE '%other.fee_reversal_ids && v_r.fee_reversal_ids%'
     OR v_source NOT LIKE '%other.fee_source_rake_record_ids%'
     OR v_source NOT LIKE '%&& v_r.fee_source_rake_record_ids%' THEN
    RAISE EXCEPTION
      'tournament unregistration receipt lost exact cross-club fee evidence';
  END IF;
  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgrelid='public.rake_records'::regclass
         AND g.tgname='tournament_unregistration_rake_evidence_is_immutable'
         AND g.tgfoid=
           'public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure
         AND NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=27)<>1 THEN
    RAISE EXCEPTION
      'tournament unregistration fee source or reversal is mutable';
  END IF;
END;
$legacy_unregister_cutover_proof$;

DO $seat_exit_cutover_proof$
DECLARE
  v_source text;
BEGIN
  IF (SELECT count(*)
        FROM public.tournament_seat_exit_authority_cutover c
       WHERE c.authority='tournament_seat_exit_authority:v1'
         AND c.migration_version='20260910042020_stage_b_exact_precondition_repairs'
         AND c.installed_at IS NOT NULL
         AND c.installed_at<=clock_timestamp()
         AND c.repaired_seat_count=cardinality(c.repaired_seat_ids)
         AND c.repaired_table_count=cardinality(c.repaired_table_ids)
         AND c.repaired_roster_count=cardinality(c.repaired_roster_ids)
         AND c.repaired_chip_count=
             cardinality(c.repaired_chip_roster_ids)
         AND c.repaired_stakes_count=
             cardinality(c.repaired_stakes_table_ids)
         AND c.closed_duplicate_table_count=
             cardinality(c.closed_duplicate_table_ids)
         AND c.repaired_player_count_count=
             cardinality(c.repaired_player_count_tournament_ids)
         AND c.pending_zero_candidate_count=
             cardinality(c.pending_zero_candidate_ids)
         AND c.pending_zero_candidate_count=
             cardinality(c.pending_zero_seat_ids)
         AND array_position(c.repaired_seat_ids,NULL) IS NULL
         AND array_position(c.repaired_table_ids,NULL) IS NULL
         AND array_position(c.repaired_roster_ids,NULL) IS NULL
         AND array_position(c.repaired_chip_roster_ids,NULL) IS NULL
         AND array_position(c.repaired_stakes_table_ids,NULL) IS NULL
         AND array_position(c.closed_duplicate_table_ids,NULL) IS NULL
         AND array_position(
               c.repaired_player_count_tournament_ids,NULL) IS NULL
         AND array_position(c.pending_zero_candidate_ids,NULL) IS NULL
         AND array_position(c.pending_zero_seat_ids,NULL) IS NULL
         AND c.pending_zero_candidate_ids IS NOT DISTINCT FROM (
           SELECT COALESCE(array_agg(r.candidate_id ORDER BY r.candidate_id),
                           ARRAY[]::uuid[])
             FROM public.tournament_pending_zero_seat_cutover_receipts r)
         AND c.pending_zero_seat_ids IS NOT DISTINCT FROM (
           SELECT COALESCE(array_agg(r.vacated_seat_id ORDER BY r.candidate_id),
                           ARRAY[]::uuid[])
             FROM public.tournament_pending_zero_seat_cutover_receipts r))<>1 THEN
    RAISE EXCEPTION 'tournament seat-exit cutover marker is missing or invalid';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_seat_ids) repaired(id)
      LEFT JOIN public.table_seats s ON s.id=repaired.id
     WHERE s.id IS NULL OR s.left_at IS NULL)
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_table_ids) repaired(id)
      LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0)
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.closed_duplicate_table_ids) repaired(id)
      LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'terminal seat-exit cutover receipt lost its exact repair state';
  END IF;
  IF has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','DELETE') THEN
    RAISE EXCEPTION 'seat-exit cutover marker is reachable by service role';
  END IF;
  IF has_table_privilege(
       'service_role',
       'public.tournament_pending_zero_seat_cutover_receipts','SELECT')
     OR has_table_privilege(
       'service_role',
       'public.tournament_pending_zero_seat_cutover_receipts','INSERT')
     OR has_table_privilege(
       'service_role',
       'public.tournament_pending_zero_seat_cutover_receipts','UPDATE')
     OR has_table_privilege(
       'service_role',
       'public.tournament_pending_zero_seat_cutover_receipts','DELETE')
     OR (SELECT count(*) FROM pg_trigger tg
          WHERE tg.tgrelid=
                  'public.tournament_pending_zero_seat_cutover_receipts'::regclass
            AND tg.tgname=
                  'tournament_pending_zero_seat_cutover_receipts_append_only'
            AND tg.tgfoid=
                  'public.fn_tournament_seat_exit_cutover_receipts_append_only()'::regprocedure
            AND NOT tg.tgisinternal AND tg.tgenabled='O'
            AND tg.tgtype=27)<>1 THEN
    RAISE EXCEPTION 'pending-zero cutover receipt is not owner-only append-only';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid='public.table_seats'::regclass
         AND tgname='zy_tournament_live_seat_exit_requires_authority'
         AND NOT tgisinternal)<>1 THEN
    RAISE EXCEPTION 'tournament seat-exit guard is not armed exactly once';
  END IF;
  IF to_regprocedure('public.fn_clear_seats_on_game_end()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_spin_reap_stale_boards(integer,boolean,boolean,integer)')
       IS NOT NULL
     OR to_regprocedure(
       'public.fn_reconcile_tournament_denormals()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_live_seat_chips(uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_chips(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_release_seats_on_tournament_finish()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid='public.tournaments'::regclass
          AND tg.tgname='trg_release_seats_on_tournament_finish'
          AND NOT tg.tgisinternal)
     OR EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname='reconcile-tournament-denormals'
           OR command LIKE '%fn_reconcile_tournament_denormals(%') THEN
    RAISE EXCEPTION 'retired tournament seat reconcilers still exist';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
          AND p.prosrc LIKE '%stakes%trim_scale(v_sb)%trim_scale(v_bb)%'
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public'])
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure
          AND p.prosrc LIKE '%stakes=trim_scale(v_sb)%trim_scale(v_bb)%'
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public'])
     OR has_function_privilege(
       'authenticated','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'denormal write ownership is not hard-coded at source';
  END IF;
  IF to_regprocedure(
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)') IS NOT NULL
     OR has_function_privilege(
       'anon','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'tournament move authority ACL is not service-only';
  END IF;
  IF has_table_privilege(
       'service_role','public.tournament_seat_exit_authorizations','SELECT')
     OR has_table_privilege(
       'authenticated','public.tournament_seat_exit_authorizations','INSERT')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'seat-exit capability table is externally reachable';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
    'public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure;
  IF v_source IS NULL
     OR v_source LIKE '%tournament_players%'
     OR replace(v_source,' ','') LIKE '%OLD.stack=0%RETURNNEW%' THEN
    RAISE EXCEPTION 'seat-exit trigger retained a tokenless state bypass';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%fn_ca_open_tournament_hand_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
     OR v_source NOT LIKE
          '%fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_emit_tournament_manager_wake%'
     OR v_source NOT LIKE '%accepted_hand_bust%'
     OR replace(v_source,' ','') NOT LIKE '%v_expected_vacated<>v_consumed%' THEN
    RAISE EXCEPTION 'accepted-hand seat capability wrapper changed';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_emit_tournament_manager_wake(uuid,text)'::regprocedure;
  IF v_source IS NULL OR v_source NOT LIKE '%accepted_hand_bust%'
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_manager_wakes'::regclass
          AND c.conname='tournament_manager_wakes_reason_check'
          AND pg_get_constraintdef(c.oid) LIKE '%accepted_hand_bust%') THEN
    RAISE EXCEPTION 'accepted-hand bust wake authority changed';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'tournament elimination seat authority ACL changed';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_open_tournament_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
     OR v_source NOT LIKE
          '%fn_eliminate_tournament_player_atomic_pre_seat_guard%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'ordinary elimination bypasses its private seat owner';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_open_tournament_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
     OR v_source NOT LIKE
          '%fn_claim_tournament_bounty_elimination_pre_seat_guard%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'bounty elimination bypasses its private seat owner';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)'::regprocedure
          AND p.prosrc LIKE '%fn_eliminate_player_legacy_candidate_20260907%'
          AND p.prosrc NOT LIKE '%UPDATE public.table_seats%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure
          AND p.prosrc LIKE '%fn_claim_bounty_legacy_candidate_20260907%'
          AND p.prosrc NOT LIKE '%UPDATE public.table_seats%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure
          AND p.prosrc LIKE '%UPDATE public.table_seats%'
          AND p.prosrc LIKE '%left_at%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure
          AND p.prosrc LIKE '%UPDATE public.table_seats%'
          AND p.prosrc LIKE '%left_at%') THEN
    RAISE EXCEPTION 'private elimination seat owners changed shape';
  END IF;
  SELECT pg_get_functiondef(
    'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure)
    INTO v_source;
  IF position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0
     OR position('atomic_seat_cashout_locked_pre_tournament_guard' IN v_source)=0 THEN
    RAISE EXCEPTION 'cashout wrapper is not hard-refusing tournaments';
  END IF;
  SELECT pg_get_functiondef(
    'public.fn_admin_kick_player(uuid,uuid,text)'::regprocedure) INTO v_source;
  IF position('fn_can_create_games' IN v_source)=0
     OR position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0 THEN
    RAISE EXCEPTION 'admin kick is not a cash-only game-authority path';
  END IF;
END;
$seat_exit_cutover_proof$;

-- The maintenance root prevents a freeze-row transition, but the maintenance
-- interval can expire by wall clock during this broad historical cutover.
DO $verify_live_seat_exit_cutover_freeze_still_held$
BEGIN
  IF (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'tournament seat-exit live cutover freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$verify_live_seat_exit_cutover_freeze_still_held$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: LEGACY HOLD-REFUND DOOR RETIREMENT
-- ===========================================================================
-- Tournament refunds have one entitlement-backed transaction. This 2026-04
-- hold releaser predates that authority, credits the retired global wallet
-- directly, has no caller, and remained executable by service_role. Production
-- has no tournament_register holds to preserve. Freeze the table while proving
-- that precondition, then remove the alternate money door.



-- The transaction-start gate already owns and authenticates terminal,
-- maintenance, entry-freeze, realtime, and stopped-engine authority for this
-- one-shot hold-door retirement.

LOCK TABLE public.chip_escrow_holds IN SHARE ROW EXCLUSIVE MODE;

DO $legacy_hold_guard$
BEGIN
  IF to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'fn_release_tournament_holds(uuid) is already absent; deployment ancestry is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.chip_escrow_holds h
     WHERE h.hold_type = 'tournament_register'
  ) THEN
    RAISE EXCEPTION
      'legacy tournament_register holds still exist; classify them before retiring their unsafe refund door'
      USING ERRCODE = '55000';
  END IF;

  -- DROP ... RESTRICT sees catalog dependencies, but PostgreSQL does not record
  -- PL/pgSQL calls as pg_depend edges. Refuse the cutover if a stored function
  -- in any application schema acquired a textual call after this door was
  -- audited. System, temporary, and extension-internal schemas are excluded.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname <> 'information_schema'
       AND n.nspname !~ '^pg_'
       AND p.oid <> 'public.fn_release_tournament_holds(uuid)'::regprocedure
       AND p.prosrc ~* 'fn_release_tournament_holds[[:space:]]*\('
  ) THEN
    RAISE EXCEPTION
      'a stored function still calls fn_release_tournament_holds(uuid); repoint it before retiring the legacy refund door'
      USING ERRCODE = '2BP01';
  END IF;
END;
$legacy_hold_guard$;

REVOKE ALL ON FUNCTION public.fn_release_tournament_holds(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.fn_release_tournament_holds(uuid) RESTRICT;

DO $legacy_hold_absence$
BEGIN
  IF to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy tournament hold refund door survived retirement';
  END IF;
END;
$legacy_hold_absence$;

DO $verify_live_legacy_hold_retirement_freeze_still_held$
BEGIN
  IF (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'legacy tournament hold retirement live cutover freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$verify_live_legacy_hold_retirement_freeze_still_held$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: DB-FIRST TERMINAL ROOTS
-- ===========================================================================
-- DB-FIRST TERMINAL AUTHORITY HARDENING
--
-- The replacement engine uses fn_complete_tournament_terminal and
-- fn_settle_satellite_tournament, but the currently deployed engine can still
-- call the older service roots while that binary drains.  This migration is
-- therefore deliberately non-destructive: it closes every browser/default
-- grant, makes every wrapper-only implementation owner-only, and keeps only
-- the exact service roots needed by either engine generation.  The obsolete
-- service roots are dropped only in the post-engine cutover migration.



-- The same transaction-start authority remains held while terminal service
-- roots are replaced as one ACL boundary.

DO $terminal_acl_prerequisites$
DECLARE
  v_signature text;
  v_required text[] := ARRAY[
    'public.fn_apply_prize_guarantee(uuid,text)',
    'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
    'public.fn_ca_epoch3_preflight()',
    'public.fn_ca_execute_epoch3_reset(text,boolean)',
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
    'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)',
    'public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)',
    'public.fn_complete_tournament_terminal(uuid,uuid,text)',
    'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
    'public.fn_final_table_deal(uuid)',
    'public.fn_final_table_deal_unguarded_20260907(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)',
    'public.fn_mystery_bounty_pay(uuid)',
    'public.fn_mystery_bounty_pay_unguarded_20260907(uuid)',
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)',
    'public.fn_prepare_tournament_place_obligations(uuid,text)',
    'public.fn_register_for_tournament_with_ticket(uuid,uuid)',
    'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
    'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
    'public.fn_settle_final_table_deal_atomic(uuid)',
    'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)',
    'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
    'public.fn_settle_satellite_tournament(uuid,uuid)',
    'public.fn_settle_tournament_bubble_protection(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places(uuid,uuid)',
    'public.fn_settle_tournament_places_atomic(uuid,text)',
    'public.fn_settle_tournament_rake(uuid,text)'
  ];
BEGIN
  IF to_regprocedure('public.fn_caller_session_is_live()') IS NULL THEN
    RAISE EXCEPTION
      'ticket-spend hardening requires fn_caller_session_is_live()';
  END IF;

  FOREACH v_signature IN ARRAY v_required LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'terminal ACL prerequisite % is missing', v_signature;
    END IF;
  END LOOP;
END;
$terminal_acl_prerequisites$;

-- The authenticated ticket door spends a noncash entry instrument.  A JWT
-- whose server-side session was revoked must fail before the global entry lock
-- and before its owner-only ticket core can lock or mutate any durable row.
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_with_ticket(
  p_tournament_id uuid,
  p_ticket_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $ticket_registration_terminal_gate$
DECLARE
  v_uid uuid := auth.uid();
  v_gate jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF public.fn_caller_session_is_live() IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires a live authenticated session'
      USING ERRCODE = '28000';
  END IF;

  v_gate := public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id, NULL, v_uid);
  IF COALESCE((v_gate->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_for_tournament_with_ticket_before_terminal_gate(
    p_tournament_id, p_ticket_id);
END;
$ticket_registration_terminal_gate$;

-- Exact externally callable roots during the DB-first rolling window.  PUBLIC
-- is revoked explicitly because PostgreSQL's default function ACL otherwise
-- grants EXECUTE to every present and future login role.
REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places_atomic(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places_atomic(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_epoch3_preflight()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_epoch3_preflight()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_execute_epoch3_reset(text,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_execute_epoch3_reset(text,boolean)
  TO service_role;

-- A caller must have both the authenticated role and a live server-side
-- session. service_role remains listed only for a delegated user JWT during
-- the rolling window; a bare service JWT has auth.uid() NULL and is refused.
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
  TO authenticated,service_role;

-- These implementations are callable only from SECURITY DEFINER parents.
-- Reacquiring them as the owner does not require a service_role grant.
REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,
  uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_final_table_deal_unguarded_20260907(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay_unguarded_20260907(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve_unguarded_20260907(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  uuid,text,integer,uuid,numeric,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Pin every SECURITY DEFINER function above to the trusted schema, with the
-- session-local temporary schema explicitly last rather than implicitly first.
ALTER FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_ca_epoch3_preflight()
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_ca_execute_epoch3_reset(text,boolean)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,
  uuid,jsonb,numeric,boolean)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_final_table_deal(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_final_table_deal_unguarded_20260907(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_pay(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_pay_unguarded_20260907(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_reserve_unguarded_20260907(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  uuid,text,integer,uuid,numeric,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_places_atomic(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_rake(uuid,text)
  SET search_path TO public,pg_temp;

-- Exact ACL and search-path proof.  The ACL checks inspect aclexplode rather
-- than only the three known Supabase roles, so a forgotten custom grantee also
-- aborts the migration.
DO $terminal_acl_proof$
DECLARE
  v_signature text;
  v_proc regprocedure;
  v_owner oid;
  v_authority_owner oid;
  v_source text;
  v_service_only text[] := ARRAY[
    'public.fn_apply_prize_guarantee(uuid,text)',
    'public.fn_ca_epoch3_preflight()',
    'public.fn_ca_execute_epoch3_reset(text,boolean)',
    'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)',
    'public.fn_complete_tournament_terminal(uuid,uuid,text)',
    'public.fn_final_table_deal(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_pay(uuid)',
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_prepare_tournament_place_obligations(uuid,text)',
    'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
    'public.fn_settle_final_table_deal_atomic(uuid)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)',
    'public.fn_settle_satellite_tournament(uuid,uuid)',
    'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places_atomic(uuid,text)',
    'public.fn_settle_tournament_rake(uuid,text)'
  ];
  v_owner_only text[] := ARRAY[
    'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
    'public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)',
    'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
    'public.fn_final_table_deal_unguarded_20260907(uuid)',
    'public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)',
    'public.fn_mystery_bounty_pay_unguarded_20260907(uuid)',
    'public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)',
    'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
    'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
    'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
    'public.fn_settle_tournament_bubble_protection(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places(uuid,uuid)'
  ];
BEGIN
  SELECT p.proowner INTO v_authority_owner
    FROM pg_proc p
   WHERE p.oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;

  FOREACH v_signature IN ARRAY v_service_only LOOP
    v_proc := to_regprocedure(v_signature);
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = v_proc;
    IF NOT has_function_privilege('service_role',v_proc,'EXECUTE')
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(
             COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid=v_proc
            AND upper(a.privilege_type)='EXECUTE'
            AND a.grantee<>ALL(ARRAY[v_owner,'service_role'::regrole::oid])
       ) THEN
      RAISE EXCEPTION '% is not exact owner + service_role EXECUTE',v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY v_owner_only LOOP
    v_proc := to_regprocedure(v_signature);
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = v_proc;
    IF has_function_privilege('service_role',v_proc,'EXECUTE')
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(
             COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid=v_proc
            AND upper(a.privilege_type)='EXECUTE'
            AND a.grantee<>v_owner
       ) THEN
      RAISE EXCEPTION '% is not exact owner-only EXECUTE',v_signature;
    END IF;
  END LOOP;

  v_proc := 'public.fn_register_for_tournament_with_ticket(uuid,uuid)'::regprocedure;
  SELECT p.proowner,p.prosrc INTO v_owner,v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF NOT has_function_privilege('authenticated',v_proc,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_proc,'EXECUTE')
     OR has_function_privilege('anon',v_proc,'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_proc
          AND upper(a.privilege_type)='EXECUTE'
          AND a.grantee<>ALL(ARRAY[
            v_owner,'authenticated'::regrole::oid,'service_role'::regrole::oid])
     )
     OR position('public.fn_caller_session_is_live()' IN v_source)=0
     OR position('public.fn_caller_session_is_live()' IN v_source) >
        position('public.fn_ca_lock_tournament_seat_acquisition(' IN v_source) THEN
    RAISE EXCEPTION
      'ticket registration lost its exact ACL or pre-lock live-session gate';
  END IF;

  FOREACH v_signature IN ARRAY v_service_only||v_owner_only||ARRAY[
    'public.fn_register_for_tournament_with_ticket(uuid,uuid)'
  ] LOOP
    v_proc := to_regprocedure(v_signature);
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid=v_proc AND p.prosecdef
         AND p.proowner=v_authority_owner
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION
        '% lost the common authority owner, SECURITY DEFINER or its fixed search_path',
        v_signature;
    END IF;
  END LOOP;
END;
$terminal_acl_proof$;

COMMENT ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid) IS
  'Authenticated ticket-spend root. Requires auth.uid plus a live server-side session before the shared seat-acquisition lock; the exact ticket core remains owner-only.';

DO $verify_live_terminal_acl_cutover_freeze_still_held$
BEGIN
  IF (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'terminal ACL hardening live cutover freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$verify_live_terminal_acl_cutover_freeze_still_held$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: COMMITTED MOVE RESPONSE RECOVERY
-- ===========================================================================
-- 20260909182952_a_committed_tournament_move_receipt_survives_lease_loss
--
-- A tournament table move already had one atomic writer and an immutable
-- request receipt. The writer looked for that receipt only after PostgREST had
-- admitted the caller's current tournament-manager lease. If the write
-- committed but its HTTP response was lost, then the lease expired before the
-- retry, PostgREST refused the retry before the function ran and the old
-- engine generation could never certify the committed result.
--
-- This adds one service-only, receipt-only resolver. It accepts the complete
-- expected move identity, serializes behind the same global settlement lock as
-- the writer, and returns an existing immutable receipt only when every field
-- matches. It cannot create, update, delete, retry or compensate a move. A
-- missing receipt remains an unknown outcome because an already admitted
-- request could still be waiting for the same lock. The engine therefore
-- releases its move fence only after receiving exact committed evidence.


SET LOCAL idle_in_transaction_session_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
        ) IS NULL THEN
    RAISE EXCEPTION 'atomic tournament move receipt authority is missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_resolve_committed_tournament_seat_move(p_request_id uuid, p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_destination_table_id uuid, p_destination_seat_number integer, p_source_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_actor text:=NULLIF(current_setting('app.smarter_data_actor',true),'');
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'committed tournament move receipt requires ordinary service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL OR p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_source_table_id=p_destination_table_id
     OR p_destination_seat_number NOT BETWEEN 1 AND 10
     OR p_source_mode NOT IN ('live_source','closed_orphan') THEN
    RAISE EXCEPTION 'invalid committed tournament move receipt identity'
      USING ERRCODE='22023';
  END IF;

  -- The writer (fn_move_tournament_player) holds this tournament's lane -
  -- G shared, T(id) exclusive - from before its first receipt read through
  -- commit. G shared then T(id) SHARED waits for exactly that writer and for
  -- terminal authorities (2026-09-10; this was G exclusive, which made every
  -- authority and hand on the platform queue behind a read-only lookup).
  -- An absent receipt is deliberately not converted into proof that no write
  -- can still begin later.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1:'||p_tournament_id::text,0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;
  IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
     OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
     OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
     OR (v_result->>'destination_table_id')::uuid
          IS DISTINCT FROM p_destination_table_id
     OR (v_result->>'destination_seat_number')::integer
          IS DISTINCT FROM p_destination_seat_number
     OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode THEN
    RAISE EXCEPTION 'tournament move request id belongs to another operation'
      USING ERRCODE='23505';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) TO service_role;

COMMENT ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) IS 'Service-only exact lookup for a committed immutable tournament seat-move receipt after a manager response becomes ambiguous. It performs no tournament mutation.';

DO $verify$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid='public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure;
  IF md5(v_source)<>'f00ad0e9a08496d96f6375cbf6f30678'
     OR octet_length(v_source)<>2279
     OR v_source NOT LIKE '%app.smarter_data_actor%'
     OR v_source NOT LIKE '%auth.role() IS DISTINCT FROM ''service_role''%'
     OR v_source LIKE
          '%fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)%'
     OR v_source NOT LIKE '%pg_advisory_xact_lock_shared(%'
     OR v_source NOT LIKE '%ca:tournament-terminal-settlement:v1:%'
     OR v_source NOT LIKE '%fn_ca_tournament_seat_move_receipt(p_request_id)%'
     OR v_source NOT LIKE '%RETURN NULL%'
     OR v_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     OR has_function_privilege('anon',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE')
     OR NOT has_function_privilege('service_role',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'committed tournament move receipt resolver verification failed';
  END IF;
END;
$verify$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: DATABASE-CHOSEN RESEAT
-- ===========================================================================
-- 20260909222020_tournament_reseating_uses_one_database_chosen_legal_chair.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A manager snapshot used to choose a table and chair before the database
-- acquired the tournament seat locks. Deleted tables, format-specific seat
-- caps, capacity expansion and a concurrent seat claim could make that hint
-- stale. The RPC then returned a refusal forever while the positive roster
-- remained seatless. Make the existing locked database chooser authoritative;
-- the caller's coordinates are only preferences.
--
-- A second permanent refusal affected played Spins and heads-up seat-first
-- games. Initial admission must equal starting_chips, but a RUNNING player who
-- has played must be reseated with the exact latest accepted-hand stack. The
-- old birth guard applied the initial-admission rule to that lifecycle move.
-- It now accepts a different stack only when the locked playing roster and
-- both accepted-hand journals independently prove that exact value.



CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $seat_guard$
DECLARE
  v_path text:=current_setting('app.money_path',true);
  v_creating boolean;
  v_tournament_id uuid;
  v_tournament_status text;
  v_variant text;
  v_tournament_type text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP='INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP='UPDATE' AND OLD.left_at IS NOT NULL
                                      AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,'')),
         t.variant,t.tournament_type,t.max_players,t.starting_chips
    INTO v_tournament_id,v_tournament_status,v_variant,v_tournament_type,
         v_max_players,v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack<=0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id,NEW.table_id,NEW.seat_number,NEW.stack
        USING ERRCODE='check_violation',
              HINT='Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF lower(COALESCE(v_variant,''))='spin'
       OR upper(COALESCE(v_tournament_type,''))='SPIN'
       OR COALESCE(v_max_players,0)<=2 THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips<=0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id,v_starting_chips
          USING ERRCODE='check_violation';
      END IF;

      IF NEW.stack IS DISTINCT FROM v_starting_chips
         AND NOT (
           v_path='fn_assign_tournament_player_seat_atomic'
           AND v_tournament_status='RUNNING'
           AND EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id=v_tournament_id
                AND tp.user_id=NEW.user_id
                AND tp.status::text='playing'
                AND tp.chips::numeric IS NOT DISTINCT FROM NEW.stack)
           AND EXISTS (
             SELECT 1
               FROM (
                 SELECT h.table_id,h.hand_id,h.hand_number,h.stack_result
                   FROM public.hand_atomic_commits h
                   JOIN public.tables hand_table ON hand_table.id=h.table_id
                  WHERE hand_table.tournament_id=v_tournament_id
                    AND h.stack_result->'written' ? NEW.user_id::text
                    AND h.stack_result->>'success'='true'
                    AND h.post_commit_completed_at IS NOT NULL
                    AND h.post_commit_result->>'ok'='true'
                  ORDER BY h.hand_number DESC,h.table_id,h.hand_id
                  LIMIT 1
               ) latest
               JOIN public.settlement_idempotency_keys settled
                 ON settled.table_id=latest.table_id
                AND settled.hand_id=latest.hand_id
                AND settled.status='succeeded'
                AND settled.completed_at IS NOT NULL
                AND settled.result IS NOT DISTINCT FROM latest.stack_result
              WHERE latest.stack_result->>'hand_id'=latest.hand_id::text
                AND COALESCE(
                      latest.stack_result->'written'->>NEW.user_id::text,'')
                      ~'^-?[0-9]+([.][0-9]+)?$'
                AND (latest.stack_result->'written'->>NEW.user_id::text)::numeric
                      IS NOT DISTINCT FROM NEW.stack)
         ) THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id,NEW.table_id,NEW.seat_number,NEW.stack,
          v_starting_chips
          USING ERRCODE='check_violation',
                HINT='Only initial admission uses starting_chips; a RUNNING lifecycle reseat must match the locked roster and latest accepted hand exactly.';
      END IF;
    END IF;
  END IF;

  -- Cash reservations keep their existing zero-stack path. A positive seat is
  -- still reachable only through the engine or one declared money authority.
  IF COALESCE(NEW.stack,0)<=0 THEN
    RETURN NEW;
  END IF;
  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;
  IF v_path IN (
       'atomic_table_buyin','fn_take_seat_and_buy_in',
       'fn_seat_horse_in_seat_first_game','fn_seat_late_registrant',
       'fn_assign_tournament_player_seat_atomic',
       'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path,''),'none'),COALESCE(auth.role(),'none'),
    COALESCE(NULLIF(current_setting('application_name',true),''),'none'),
    NEW.table_id,NEW.seat_number,NEW.stack
    USING ERRCODE='check_violation',
          HINT='The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$seat_guard$;

REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation()
  FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_guard_seat_creation() IS
  'BEFORE-seat funding invariant. Initial Spin and heads-up seat-first admission equals starting_chips; a changed RUNNING lifecycle stack must match the locked playing roster and latest accepted hand in both journals.';

CREATE OR REPLACE FUNCTION public.fn_assign_tournament_player_seat_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_table_id uuid,
  p_seat_number integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_seat_assignment$
DECLARE
  v_gate jsonb;
  v_choice jsonb;
  v_existing_live_count integer;
  v_existing_table_id uuid;
  v_existing_seat_number integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION
      'fn_assign_tournament_player_seat_atomic requires service authority'
      USING ERRCODE='28000';
  END IF;

  -- Lock the tournament root, not a stale caller-selected child. The private
  -- chooser establishes capacity and locks one legal table/chair below that
  -- same root. Caller coordinates are preferences only.
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;

  -- A response-loss retry must replay the chair this player already owns.
  -- The free-chair chooser deliberately excludes occupied seats, so invoking
  -- it first would redirect a committed retry and hide the private assigner's
  -- exact replay receipt. Lock the beneficiary before its live seat, matching
  -- tournament -> roster -> seat order, and use the existing coordinates only
  -- when the locked database proves there is exactly one.
  PERFORM tp.id
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   ORDER BY tp.id
   FOR UPDATE;
  PERFORM existing.id
    FROM public.table_seats existing
    JOIN public.tables existing_table ON existing_table.id=existing.table_id
   WHERE existing_table.tournament_id=p_tournament_id
     AND existing.user_id=p_user_id AND existing.left_at IS NULL
   ORDER BY existing.id
   FOR UPDATE OF existing;
  SELECT count(*)::integer
    INTO v_existing_live_count
    FROM public.table_seats existing
    JOIN public.tables existing_table ON existing_table.id=existing.table_id
   WHERE existing_table.tournament_id=p_tournament_id
     AND existing.user_id=p_user_id AND existing.left_at IS NULL;
  IF v_existing_live_count>1 THEN
    RAISE EXCEPTION 'tournament player already owns multiple live seats'
      USING ERRCODE='P0404';
  END IF;
  IF v_existing_live_count=1 THEN
    SELECT existing.table_id,existing.seat_number
      INTO STRICT v_existing_table_id,v_existing_seat_number
      FROM public.table_seats existing
      JOIN public.tables existing_table ON existing_table.id=existing.table_id
     WHERE existing_table.tournament_id=p_tournament_id
       AND existing.user_id=p_user_id AND existing.left_at IS NULL;
    RETURN public.fn_ca_assign_tournament_player_seat_locked(
      p_tournament_id,p_user_id,v_existing_table_id,
      v_existing_seat_number);
  END IF;

  v_choice:=public.fn_ca_choose_tournament_seat_locked(
    p_tournament_id,p_user_id,p_table_id,p_seat_number);
  IF COALESCE((v_choice->>'ok')::boolean,false) IS NOT TRUE
     OR v_choice->>'table_id' IS NULL
     OR v_choice->>'seat_number' IS NULL THEN
    RAISE EXCEPTION 'database tournament seat choice is not exact: %',v_choice
      USING ERRCODE='P0404';
  END IF;

  RETURN public.fn_ca_assign_tournament_player_seat_locked(
    p_tournament_id,p_user_id,(v_choice->>'table_id')::uuid,
    (v_choice->>'seat_number')::integer);
END;
$atomic_tournament_seat_assignment$;

REVOKE ALL ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) TO service_role;
COMMENT ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) IS
  'Service-only atomic tournament reseat. Caller coordinates are hints; the locked database chooser owns capacity, legal format cap, table and chair selection before the exact assignment receipt commits.';

DO $prove_database_owned_tournament_reseating$
DECLARE
  v_assign text;
  v_choose text;
  v_guard text;
BEGIN
  SELECT p.prosrc INTO STRICT v_assign
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)'::regprocedure
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[];
  IF position(
       'fn_ca_lock_tournament_seat_acquisition(' IN v_assign)=0
     OR position(
          'p_tournament_id,NULL,p_user_id' IN
          regexp_replace(v_assign,'[[:space:]]','','g'))=0
     OR position('v_existing_live_count=1' IN
          regexp_replace(v_assign,'[[:space:]]','','g'))=0
     OR position('FOR UPDATE OF existing' IN v_assign)=0
     OR position('fn_ca_choose_tournament_seat_locked(' IN v_assign)=0
     OR position('fn_ca_assign_tournament_player_seat_locked(' IN v_assign)=0
     OR position(
          'fn_ca_assign_tournament_player_seat_locked(' IN
          substring(
            v_assign FROM
            position('fn_ca_choose_tournament_seat_locked(' IN v_assign)+1))=0
     OR has_function_privilege(
          'anon',
          'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
          'EXECUTE')
     OR has_function_privilege(
          'authenticated',
          'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
          'EXECUTE')
     OR NOT has_function_privilege(
          'service_role',
          'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'database-owned tournament seat selection changed';
  END IF;

  SELECT p.prosrc INTO STRICT v_choose
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[];
  IF v_choose NOT LIKE '%fn_ensure_late_registration_capacity%'
     OR v_choose NOT LIKE '%fn_ca_tournament_seat_cap%'
     OR v_choose NOT LIKE '%NOT COALESCE(tb.is_deleted,false)%'
     OR v_choose NOT LIKE '%FOR UPDATE OF tb%'
     OR v_choose NOT LIKE '%generate_series%'
     OR v_choose NOT LIKE '%p_preferred_table_id%'
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',
          'EXECUTE')
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'private locked tournament chair chooser changed';
  END IF;

  SELECT p.prosrc INTO STRICT v_guard
    FROM pg_proc p
   WHERE p.oid='public.fn_ca_guard_seat_creation()'::regprocedure
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[];
  IF v_guard NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%'
     OR v_guard NOT LIKE '%fn_assign_tournament_player_seat_atomic%'
     OR v_guard NOT LIKE '%v_tournament_status=''RUNNING''%'
     OR v_guard NOT LIKE '%v_tournament_type%SPIN%'
     OR v_guard NOT LIKE '%public.tournament_players%'
     OR v_guard NOT LIKE '%public.hand_atomic_commits%'
     OR v_guard NOT LIKE '%public.settlement_idempotency_keys%'
     OR v_guard NOT LIKE '%latest.stack_result%NEW.user_id%'
     OR has_function_privilege(
          'service_role','public.fn_ca_guard_seat_creation()','EXECUTE')
     OR (SELECT count(*) FROM pg_trigger tg
          WHERE tg.tgrelid='public.table_seats'::regclass
            AND tg.tgname='trg_ca_guard_seat_creation'
            AND tg.tgfoid='public.fn_ca_guard_seat_creation()'::regprocedure
            AND NOT tg.tgisinternal AND tg.tgenabled<>'D')<>1 THEN
    RAISE EXCEPTION 'seat-first lifecycle funding distinction changed';
  END IF;
END;
$prove_database_owned_tournament_reseating$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: ATOMIC SCHEDULER CAPTURE AND DISABLE
-- ===========================================================================
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:eliminate-absent-tournament-players:v1',0));
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:release-broke-seats:v1',0));

DO $phase_a_require_live_freeze$
DECLARE
  v_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION 'scheduler fence requires the maintenance entry freeze authority'
      USING ERRCODE='55000';
  END IF;
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;
  IF NOT v_pristine
     AND public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'scheduler fence requires the maintenance entry freeze'
      USING ERRCODE='55006';
  END IF;
END;
$phase_a_require_live_freeze$;

INSERT INTO public.tournament_mutator_scheduler_retirement_receipts(
  migration_version,captured_at,job_ids,jobs)
SELECT
  '20260910042112_stage_b_current_postimage_contraction',
  clock_timestamp(),
  COALESCE(
    array_agg(j.jobid ORDER BY j.jobid)
      FILTER (WHERE j.jobid IS NOT NULL),
    '{}'::bigint[]),
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'jobid',j.jobid,
        'jobname',j.jobname,
        'command',j.command,
        'schedule',j.schedule,
        'database',j.database,
        'username',j.username,
        'nodename',j.nodename,
        'nodeport',j.nodeport,
        'active',j.active)
      ORDER BY j.jobid)
      FILTER (WHERE j.jobid IS NOT NULL),
    '[]'::jsonb)
FROM cron.job j
WHERE j.jobname IN (
        'ca-eliminate-absent-players','ca-release-broke-seats')
   OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
   OR j.command ILIKE '%fn_ca_release_broke_seats%';

CREATE OR REPLACE FUNCTION public.fn_ca_release_broke_seats(
  p_min_dwell_minutes integer DEFAULT 15,
  p_limit integer DEFAULT 200,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retired_broke_seat_mutator_fence$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:job:release-broke-seats:v1',0));
  RAISE EXCEPTION 'broke-seat mutation job is retired'
    USING ERRCODE='55000';
END;
$retired_broke_seat_mutator_fence$;

REVOKE ALL ON FUNCTION public.fn_ca_eliminate_absent_tournament_players(
  integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_release_broke_seats(
  integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;

DO $commit_retired_tournament_mutator_schedule_fence$
DECLARE
  r record;
  v_job_ids bigint[];
BEGIN
  SELECT x.job_ids INTO STRICT v_job_ids
    FROM public.tournament_mutator_scheduler_retirement_receipts x
   WHERE x.migration_version='20260910042112_stage_b_current_postimage_contraction';

  IF cardinality(v_job_ids)<>2 THEN
    RAISE EXCEPTION
      'scheduler fence expected exactly two tournament mutator jobs, found %',
      cardinality(v_job_ids)
      USING ERRCODE='55000';
  END IF;

  FOR r IN
    SELECT j.jobid FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
     ORDER BY j.jobid
  LOOP
    PERFORM cron.alter_job(job_id=>r.jobid,active=>false);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
       AND j.active)
     OR (SELECT count(*) FROM cron.job j
          WHERE j.jobid=ANY(v_job_ids))<>2
     OR EXISTS (
       SELECT 1 FROM cron.job j
        WHERE (j.jobname IN (
                 'ca-eliminate-absent-players','ca-release-broke-seats')
            OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
            OR j.command ILIKE '%fn_ca_release_broke_seats%')
          AND (j.jobid<>ALL(v_job_ids) OR j.active)) THEN
    RAISE EXCEPTION
      'retired tournament mutation jobs were not retained exactly once and disabled';
  END IF;
END;
$commit_retired_tournament_mutator_schedule_fence$;

DO $phase_a_freeze_still_held$
DECLARE
  v_pristine boolean;
BEGIN
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;
  IF NOT v_pristine
     AND public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'maintenance entry freeze expired before scheduler fence commit'
      USING ERRCODE='55006';
  END IF;
END;
$phase_a_freeze_still_held$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: FINAL ROSTER-SEAT AUTHORITY AND SCHEDULER RETIREMENT
-- ===========================================================================
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:eliminate-absent-tournament-players:v1',0));
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:release-broke-seats:v1',0));

DO $preflight$
DECLARE
  v_pristine boolean;
BEGIN
  IF to_regclass('public.tournament_seat_exit_authority_cutover') IS NULL
     OR to_regclass(
          'public.tournament_mutator_scheduler_retirement_receipts') IS NULL
     OR to_regprocedure(
          'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'final tournament seat authority requires M6 first'
      USING ERRCODE='55000';
  END IF;

  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;

  IF NOT v_pristine
     AND (to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL
          OR public.fn_entry_purchases_frozen() IS NOT TRUE) THEN
    RAISE EXCEPTION
      'final tournament roster-seat cutover requires the maintenance entry freeze'
      USING ERRCODE='55006';
  END IF;

  IF to_regclass('public.tournament_place_settlement_batches') IS NULL
     OR to_regclass('public.tournament_satellite_settlement_batches') IS NULL
     OR to_regclass('public.tournament_terminal_settlements') IS NULL
     OR to_regclass('public.tournament_cancellation_receipts') IS NULL THEN
    RAISE EXCEPTION 'final tournament authority is missing terminal evidence tables'
      USING ERRCODE='55000';
  END IF;
END;
$preflight$;

-- This transaction has captured and disabled both jobs while holding their exact advisory locks,
-- but CREATE OR REPLACE cannot change a PL/pgSQL invocation that had already
-- entered its old body. Use the durably captured pg_cron IDs plus live command
-- text to refuse the cutover if one survived. Phase A retained each disabled
-- cron row, so the run-history join cannot lose its identity before this proof.
DO $drain_pre_tombstone_tournament_mutator_invocations$
DECLARE
  v_job_ids bigint[];
BEGIN
  SELECT r.job_ids INTO STRICT v_job_ids
    FROM public.tournament_mutator_scheduler_retirement_receipts r
   WHERE r.migration_version='20260910042112_stage_b_current_postimage_contraction';

  PERFORM pg_stat_clear_snapshot();
  IF EXISTS (
    SELECT 1 FROM cron.job_run_details d
     WHERE d.jobid=ANY(v_job_ids)
       AND d.end_time IS NULL)
     OR EXISTS (
    SELECT 1
      FROM pg_stat_activity a
      LEFT JOIN cron.job_run_details d
        ON d.job_pid=a.pid
       AND d.jobid=ANY(v_job_ids)
       AND d.end_time IS NULL
       AND (d.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
         OR d.command ILIKE '%fn_ca_release_broke_seats%')
     WHERE a.pid<>pg_backend_pid()
       AND a.datname=current_database()
       AND a.state<>'idle'
       AND (
         a.query ILIKE '%fn_ca_eliminate_absent_tournament_players%'
         OR a.query ILIKE '%fn_ca_release_broke_seats%'
         OR d.job_pid IS NOT NULL)) THEN
    RAISE EXCEPTION
      'a pre-tombstone tournament mutator invocation is still active'
      USING ERRCODE='55006';
  END IF;
END;
$drain_pre_tombstone_tournament_mutator_invocations$;

DO $unschedule_disabled_tournament_mutator_jobs$
DECLARE
  v_job_ids bigint[];
  r record;
BEGIN
  SELECT x.job_ids INTO STRICT v_job_ids
    FROM public.tournament_mutator_scheduler_retirement_receipts x
   WHERE x.migration_version='20260910042112_stage_b_current_postimage_contraction';

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids) AND j.active) THEN
    RAISE EXCEPTION 'a tournament mutator job was reactivated after Phase A'
      USING ERRCODE='55006';
  END IF;

  FOR r IN
    SELECT j.jobid FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
     ORDER BY j.jobid
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
        OR j.jobname IN (
             'ca-eliminate-absent-players','ca-release-broke-seats')
        OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
        OR j.command ILIKE '%fn_ca_release_broke_seats%') THEN
    RAISE EXCEPTION 'a retired tournament mutator schedule survived unscheduling';
  END IF;
END;
$unschedule_disabled_tournament_mutator_jobs$;

-- Match the established lifecycle lock order and drain any older child writer
-- before function capture, healer retirement or invariant installation.
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_players IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_knockout_candidates
  IN SHARE ROW EXCLUSIVE MODE;

-- The binding product rule is explicit: a target entry funded by a satellite
-- win can unregister only into a tournament-entry ticket, never wallet chips.
-- This is the complete ticket-only actual-start implementation, emitted
-- statically under the final private name. The later cash patch is intentionally
-- not captured on either replay history.
CREATE FUNCTION public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $ticket_only_unregister_seat_exit_core_v2$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
  v_ticket jsonb;
  v_receipt jsonb;
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
  v_players_before integer;
  v_rows integer;
  v_seat_number integer;
  v_seats_taken integer;
  v_non_cash_count integer;
  v_wallet_debits numeric:=0;
  v_wallet_refunds_before numeric:=0;
  v_wallet_refunds_after numeric:=0;
  v_entitled_wallet_total numeric:=0;
  v_tranche_total numeric:=0;
  v_refund_prize numeric:=0;
  v_refund_bounty numeric:=0;
  v_refund_fee numeric:=0;
  v_refund_total numeric:=0;
  v_wallet_amount numeric:=0;
  v_ticket_amount numeric:=0;
  v_running_owed numeric:=0;
  v_rake_before numeric:=0;
  v_rake_after numeric:=0;
  v_fees_reversed numeric:=0;
  v_entitlement_ids uuid[]:='{}'::uuid[];
  v_ticket_ids uuid[]:='{}'::uuid[];
  v_credit_ledger_ids uuid[]:='{}'::uuid[];
  v_wallet_transaction_ids uuid[]:='{}'::uuid[];
  v_source_wallet_club_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_ids uuid[]:='{}'::uuid[];
  v_fee_source_rake_record_ids uuid[]:='{}'::uuid[];
  v_fee_entitlement_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_id uuid;
  v_fee_source_count integer:=0;
  v_fee_source_entitlement_count integer:=0;
  v_fee_source_amount numeric:=0;
  v_request_id uuid:=COALESCE(p_request_id,gen_random_uuid());
  v_start_authority text:='scheduled_clock';
  v_launch_completed_at timestamptz;
  v_persisted_hand_exists boolean:=false;
  v_actual_status text;
  v_actual_started_at timestamptz;
  v_unregistered_at timestamptz;
  v_description text:=COALESCE(
    NULLIF(btrim(p_description),''),'Tournament unregistration refund');
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required'
      USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- Spins and Heads-Up Sit & Gos are separate products, but both are
  -- seat-first: start_time is only their human fill-window deadline. Neither
  -- product has a scheduled start. Satellite feeders remain outside this
  -- change and retain the existing scheduled-clock contract.
  IF v_t.satellite_target_id IS NULL
     AND upper(COALESCE(v_t.tournament_type::text,''))<>'SATELLITE'
     AND (lower(COALESCE(v_t.variant::text,''))='spin'
       OR upper(COALESCE(v_t.tournament_type::text,''))='SPIN') THEN
    v_start_authority:='spin_actual_start';
  ELSIF v_t.satellite_target_id IS NULL
     AND upper(COALESCE(v_t.tournament_type::text,''))='SNG'
     AND lower(COALESCE(v_t.variant::text,''))<>'spin'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_start_authority:='heads_up_sng_actual_start';
  END IF;

  -- A caller-supplied request id is a durable operation identity. It may only
  -- name this exact player/event/endpoint scope. If its pre-start outcome is
  -- already committed, replay that immutable outcome even when the wall clock
  -- is now past the start; this branch performs no new unregistration writes.
  IF p_request_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id
         AND (r.tournament_id IS DISTINCT FROM p_tournament_id
           OR r.user_id IS DISTINCT FROM p_user_id
           OR r.source_table_id IS DISTINCT FROM p_expected_table_id)) THEN
      RAISE EXCEPTION 'unregistration request id belongs to another intent'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id) THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,p_request_id);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
      RAISE EXCEPTION
        'unregistration request id belongs to a prior registration lifecycle'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status::text IN ('registered','playing')
   ORDER BY tp.id LIMIT 1 FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;

  -- A persisted hand is stronger actual-start evidence than either a mutable
  -- parent status or a launch receipt that an interrupted launcher failed to
  -- complete. Canonical accepted-hand commits carry tournament_id; the
  -- table-linked branch also fails closed for older rows that omitted it. The
  -- exclusive lifecycle advisory lock above serializes this read against the
  -- shared lock held by every canonical accepted-hand commit.
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE
    SELECT r.completed_at INTO v_launch_completed_at
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id=p_tournament_id;
    IF v_t.started_at IS NOT NULL OR v_launch_completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  END IF;
  IF v_reg.id IS NULL THEN
    -- Rolling clients without a request id may recover a just-lost response
    -- only while registration remains open. They can never turn an old receipt
    -- into a successful post-start response.
    IF p_request_id IS NULL THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,NULL);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT s.seat_number INTO v_seat_number
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id
       AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
     ORDER BY s.id LIMIT 1 FOR UPDATE OF s;
    IF v_seat_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok',false,'reason','spin_entry_already_booked');
  END IF;

  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
   ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_non_cash_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.registration_id=v_reg.id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id);
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>1 THEN
    RAISE EXCEPTION
      'satellite-funded registration % requires one unspent ticket entitlement',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  IF NOT COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>0 THEN
    RAISE EXCEPTION
      'cash registration % cannot own a satellite ticket entitlement',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(e.refund_prize),0),2),
         round(COALESCE(sum(e.refund_bounty),0),2),
         round(COALESCE(sum(e.refund_fee),0),2),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind='wallet_charge'),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind IN ('satellite_seat','tournament_ticket')),0),2)
    INTO v_refund_prize,v_refund_bounty,v_refund_fee,v_refund_total,
         v_wallet_amount,v_ticket_amount
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  IF v_refund_total IS DISTINCT FROM
       round(v_refund_prize+v_refund_bounty+v_refund_fee,2)
     OR v_refund_total IS DISTINCT FROM
       round(v_wallet_amount+v_ticket_amount,2) THEN
    RAISE EXCEPTION 'registration % has invalid entitlement totals',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  -- A satellite seat, including a returned ticket that was used for a later
  -- target entry, is a noncash entry for its entire registration lifecycle.
  -- Any wallet-charge entitlement attached to that registration is corrupt;
  -- refuse the whole transaction instead of ever returning chips.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND (v_wallet_amount<>0 OR v_ticket_amount<=0
       OR v_refund_total IS DISTINCT FROM v_ticket_amount) THEN
    RAISE EXCEPTION
      'satellite-funded registration % can return only a tournament ticket',
      v_reg.id USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_debits
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(e.gross),0),2) INTO v_entitled_wallet_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge';
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT round(COALESCE(sum(tr.amount_paid_now),0),2) INTO v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_wallet_debits IS DISTINCT FROM v_entitled_wallet_total
     OR v_wallet_refunds_before IS DISTINCT FROM v_tranche_total
     OR v_wallet_refunds_before>v_wallet_debits THEN
    RAISE EXCEPTION 'registration % wallet and entitlement journals disagree',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  v_running_owed:=v_tranche_total;

  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_before
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[])
    INTO v_fee_entitlement_ids
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND e.refund_fee>0
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);

  -- Bind every fee-bearing entitlement to its actual same-transaction rake
  -- journal. The refund wallet club is deliberately absent from this match:
  -- it identifies the payer, while rake_records.club_id identifies the fee
  -- recipient and can be a different club.
  WITH fee_sources AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id,
           r.club_id,r.rake_amount
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_fee_entitlement_ids)
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         round(COALESCE(sum(rake_amount),0),2),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_source_count,v_fee_source_entitlement_count,
         v_fee_source_amount,v_fee_source_rake_record_ids
    FROM fee_sources;
  IF v_fee_source_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_entitlement_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_count<>(
       SELECT count(DISTINCT id)
         FROM unnest(v_fee_source_rake_record_ids) source(id))
     OR v_fee_source_amount IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % fee entitlements do not map one-to-one to exact rake evidence',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.rake_records r
   WHERE r.id=ANY(v_fee_source_rake_record_ids)
   ORDER BY r.club_id,r.id FOR UPDATE;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'unregister entitlement escrow prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_players_before<=0
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance
     OR v_t.total_rake IS DISTINCT FROM v_rake_before
     OR v_t.prize_pool<v_refund_prize
     OR v_t.bounty_pool<v_refund_bounty
     OR v_t.total_rake<v_refund_fee THEN
    RAISE EXCEPTION 'registration % cannot leave divergent tournament state',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.entitlement_kind='wallet_charge'
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_running_owed:=round(v_running_owed+v_ent.gross,2);
    v_settle:=public.fn_settle_tournament_refund_exact(
      p_tournament_id,p_user_id,v_ent.refund_wallet_club_id,v_running_owed,
      v_ent.refund_prize,v_ent.refund_bounty,v_ent.refund_fee,
      'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
       OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_settle->>'amount_paid')::numeric IS DISTINCT FROM v_running_owed
       OR (v_settle->>'source_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id THEN
      RAISE EXCEPTION 'registration % exact wallet refund failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_credit_ledger_ids:=array_append(
      v_credit_ledger_ids,(v_settle->>'credit_ledger_id')::uuid);
    v_wallet_transaction_ids:=array_append(
      v_wallet_transaction_ids,(v_settle->>'wallet_transaction_id')::uuid);
  END LOOP;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.registration_id=v_reg.id
       AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
      v_ent.id,'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
       OR (v_ticket->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_ticket->>'refund_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id
       OR (v_ticket->>'ticket_id') IS NULL THEN
      RAISE EXCEPTION 'registration % tournament-ticket return failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_ticket_ids:=array_append(v_ticket_ids,(v_ticket->>'ticket_id')::uuid);
  END LOOP;

  FOR v_fee_group IN
    SELECT r.club_id,round(sum(r.rake_amount),2) AS fee,
           array_agg(r.id ORDER BY r.id) AS source_rake_record_ids,
           array_agg(e.id ORDER BY e.id) AS entitlement_ids
      FROM public.rake_records r
      JOIN public.tournament_refund_entitlements e
        ON e.id=ANY(v_fee_entitlement_ids)
       AND e.refund_fee=r.rake_amount
       AND e.tournament_id=r.tournament_id
       AND e.user_id=p_user_id
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
      JOIN public.chip_ledger l
        ON l.id=e.source_ledger_id AND l.created_at=r.created_at
     WHERE r.id=ANY(v_fee_source_rake_record_ids)
     GROUP BY r.club_id ORDER BY r.club_id
  LOOP
    IF v_fee_group.fee>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,metadata)
      VALUES(
        NULL,NULL,v_fee_group.club_id,-v_fee_group.fee,v_fee_group.fee,1,
        0,true,p_tournament_id,'fn_unregister_from_tournament',
        jsonb_build_object(
          'kind','tournament_fee_refund','user_id',p_user_id,
          'registration_id',v_reg.id,
          'fee_recipient_club_id',v_fee_group.club_id,
          'entitlement_ids',to_jsonb(v_fee_group.entitlement_ids),
          'original_rake_record_ids',
            to_jsonb(v_fee_group.source_rake_record_ids)))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(
        v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee_group.fee,2);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids
    FROM unnest(v_fee_reversal_ids) reversal(id);
  IF v_fees_reversed IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % reversed % in exact fee rows but owes %',
      v_reg.id,v_fees_reversed,v_refund_fee USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(v_t.prize_pool-v_refund_prize,2),
         bounty_pool=round(v_t.bounty_pool-v_refund_bounty,2),
         total_rake=round(v_t.total_rake-v_refund_fee,2),updated_at=now()
   WHERE id=p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,
         scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb
                 WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_after
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.status::text IN ('registered','playing'))<>v_players_before-1
     OR v_wallet_refunds_after IS DISTINCT FROM
          round(v_wallet_refunds_before+v_wallet_amount,2)
     OR v_escrow_after.prize_balance IS DISTINCT FROM
          round(v_escrow_before.prize_balance-v_refund_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
          round(v_escrow_before.bounty_balance-v_refund_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
          round(v_escrow_before.fee_balance-v_refund_fee,2)
     OR v_rake_after IS DISTINCT FROM round(v_rake_before-v_refund_fee,2)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=p_tournament_id
          AND t.current_players=v_players_before-1
          AND t.prize_pool=v_escrow_after.prize_balance
          AND t.bounty_pool=v_escrow_after.bounty_balance
          AND t.total_rake=v_rake_after) THEN
    RAISE EXCEPTION 'registration % did not leave exact final state',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT count(*) INTO v_seats_taken FROM public.table_seats s
     WHERE s.table_id=p_expected_table_id AND s.left_at IS NULL;
  END IF;

  -- Re-prove the chosen start authority after all money and seat work. Timed
  -- events still use the locked schedule cutoff; every product also treats a
  -- persisted hand as irreversible start truth; seat-first products further
  -- use status, started_at and completed launch truth. Any loss of the race
  -- rolls every preceding write back atomically.
  v_unregistered_at:=clock_timestamp();
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RAISE EXCEPTION
      'tournament hand persisted before unregistration could commit'
      USING ERRCODE='55000';
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT t.status::text,t.started_at,launch.completed_at
      INTO v_actual_status,v_actual_started_at,v_launch_completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts launch
        ON launch.tournament_id=t.id
     WHERE t.id=p_tournament_id;
    IF upper(COALESCE(v_actual_status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR v_actual_started_at IS NOT NULL
       OR v_launch_completed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'seat-first tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,start_authority,settled_at)
  VALUES(
    v_reg.id,v_request_id,p_tournament_id,p_user_id,p_expected_table_id,
    v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids,
    v_source_wallet_club_ids,v_credit_ledger_ids,v_wallet_transaction_ids,
    v_fees_reversed,v_fee_reversal_ids,v_fee_source_rake_record_ids,
    v_seat_number,v_seats_taken,v_t.start_time,v_start_authority,v_unregistered_at);
  v_receipt:=public.fn_ca_tournament_unregistration_receipt(
    p_tournament_id,p_user_id,p_expected_table_id,v_request_id);
  IF v_receipt IS NULL
     OR (v_receipt->>'registration_id')::uuid IS DISTINCT FROM v_reg.id THEN
    RAISE EXCEPTION 'registration % has no exact unregistration receipt',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  RETURN v_receipt||jsonb_build_object('replayed',false);
END;
$ticket_only_unregister_seat_exit_core_v2$;

-- The later satellite body is still canonical: a wrapper source names the M6
-- private core, otherwise the public body is the newest core. Exact
-- unregistration is deliberately not captured here because the later cash
-- patch contradicted the binding ticket-only satellite-exit contract.
DO $capture_final_late_cores$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure(
       'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'a reserved final seat-exit core name already exists'
      USING ERRCODE='42710';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure;
  IF position('fn_settle_satellite_tournament_pre_seat_guard'
              IN v_source)>0
     AND position('fn_ca_open_tournament_seat_exit_authority'
                  IN v_source)>0 THEN
    IF to_regprocedure(
         'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)') IS NULL THEN
      RAISE EXCEPTION 'satellite wrapper lost its private core';
    END IF;
    ALTER FUNCTION
      public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)
      RENAME TO fn_settle_satellite_tournament_seat_exit_core_v2;
  ELSE
    ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
      RENAME TO fn_settle_satellite_tournament_seat_exit_core_v2;
  END IF;
END;
$capture_final_late_cores$;

REVOKE ALL ON FUNCTION
  public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(
    uuid,uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $unregister_with_final_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament player % has % live seats; exact unregistration refuses ambiguous chips',
      p_user_id,v_live_seats USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'unregister',p_user_id);
  BEGIN
    v_result:=
      public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(
        p_tournament_id,p_user_id,p_expected_table_id,p_description,p_request_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$unregister_with_final_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(
  uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $satellite_with_final_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_target_id uuid;
  v_target_status text;
  v_user_id uuid;
  v_award record;
  v_assignment jsonb;
  v_seat_award_count integer;
  v_assigned_count integer:=0;
  v_exact_count integer;
  v_was_already_settled boolean:=false;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite settlement requires service authority'
      USING ERRCODE='28000';
  END IF;

  -- A RUNNING target award changes the beneficiary from registered to seated
  -- in this same transaction. Take the canonical acquisition prefix before
  -- the source exit opener or the settlement core can lock any roster/chair.
  -- Every source player is bounded by the locked field and is acquired in UUID
  -- order; the exact award subset is not known until the core atomically fixes
  -- the target admission plan.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  SELECT true INTO v_was_already_settled
    FROM public.tournament_satellite_settlements settlement
   WHERE settlement.tournament_id=p_tournament_id;
  v_was_already_settled:=FOUND;
  IF NOT v_was_already_settled THEN
    FOR v_user_id IN
      SELECT DISTINCT tp.user_id
        FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       ORDER BY tp.user_id
    LOOP
      PERFORM public.fn_lock_daily_mission_user(v_user_id);
    END LOOP;
  END IF;

  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'satellite_finish',NULL);
  BEGIN
    v_result:=public.fn_settle_satellite_tournament_seat_exit_core_v2(
      p_tournament_id,p_observed_winner_id);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite core returned no successful exact receipt: %',
        v_result USING ERRCODE='P0404';
    END IF;

    SELECT settlement.target_id,upper(COALESCE(target.status::text,''))
      INTO STRICT v_target_id,v_target_status
      FROM public.tournament_satellite_settlements settlement
      JOIN public.tournaments target ON target.id=settlement.target_id
     WHERE settlement.tournament_id=p_tournament_id
     FOR UPDATE OF target;
    IF (v_result->>'target_id')::uuid IS DISTINCT FROM v_target_id THEN
      RAISE EXCEPTION
        'satellite core target disagrees with its immutable settlement header'
        USING ERRCODE='P0404';
    END IF;

    SELECT count(*)::integer INTO v_seat_award_count
      FROM public.tournament_satellite_awards award
     WHERE award.tournament_id=p_tournament_id
       AND award.delivery_kind='seat';
    IF (v_result->>'seat_count')::integer IS DISTINCT FROM v_seat_award_count THEN
      RAISE EXCEPTION
        'satellite core seat count disagrees with its immutable award rows'
        USING ERRCODE='P0404';
    END IF;

    -- REGISTERING targets deliberately retain zero-chip registrations until
    -- launch. A RUNNING target has no such intermediate state: choose/create
    -- one legal chair and promote every funded qualifier before the deferred
    -- reciprocal roster-seat invariant is allowed to run at commit.
    IF NOT v_was_already_settled AND v_target_status='RUNNING' THEN
      FOR v_award IN
        SELECT award.user_id,award.registration_id,award.place
          FROM public.tournament_satellite_awards award
         WHERE award.tournament_id=p_tournament_id
           AND award.delivery_kind='seat'
         ORDER BY award.user_id,award.place
      LOOP
        v_assignment:=public.fn_assign_tournament_player_seat_atomic(
          v_target_id,v_award.user_id,NULL,NULL);
        IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE
           OR (v_assignment->>'tournament_id')::uuid IS DISTINCT FROM v_target_id
           OR (v_assignment->>'user_id')::uuid IS DISTINCT FROM v_award.user_id
           OR v_assignment->>'table_id' IS NULL
           OR v_assignment->>'seat_id' IS NULL
           OR v_assignment->>'seat_number' IS NULL
           OR v_assignment->>'stack' IS NULL
           OR (v_assignment->>'stack')::numeric<=0 THEN
          RAISE EXCEPTION
            'RUNNING satellite target award % has no exact atomic chair receipt: %',
            v_award.place,v_assignment USING ERRCODE='P0404';
        END IF;

        SELECT count(*)::integer INTO v_exact_count
          FROM public.tournament_players tp
          JOIN public.table_seats seat
            ON seat.table_id=tp.table_id
           AND seat.seat_number=tp.seat_number
           AND seat.user_id=tp.user_id
           AND seat.left_at IS NULL
          JOIN public.tables target_table
            ON target_table.id=seat.table_id
           AND target_table.tournament_id=v_target_id
         WHERE tp.id=v_award.registration_id
           AND tp.tournament_id=v_target_id
           AND tp.user_id=v_award.user_id
           AND tp.status::text='playing'
           AND COALESCE(tp.chips,0)>0
           AND COALESCE(tp.is_satellite_qualifier,false)
           AND tp.source_satellite_id=p_tournament_id
           AND seat.id=(v_assignment->>'seat_id')::uuid
           AND seat.table_id=(v_assignment->>'table_id')::uuid
           AND seat.seat_number=(v_assignment->>'seat_number')::integer
           AND seat.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric
           AND tp.chips::numeric IS NOT DISTINCT FROM
                 (v_assignment->>'stack')::numeric
           AND (SELECT count(*)
                  FROM public.table_seats exact_seat
                  JOIN public.tables exact_table
                    ON exact_table.id=exact_seat.table_id
                   AND exact_table.tournament_id=v_target_id
                 WHERE exact_seat.user_id=v_award.user_id
                   AND exact_seat.left_at IS NULL)=1;
        IF v_exact_count<>1 THEN
          RAISE EXCEPTION
            'RUNNING satellite target award % did not become one exact funded roster-seat generation',
            v_award.place USING ERRCODE='P0404';
        END IF;
        v_assigned_count:=v_assigned_count+1;
      END LOOP;
      IF v_assigned_count<>v_seat_award_count THEN
        RAISE EXCEPTION
          'RUNNING satellite target assigned % of % immutable seat awards',
          v_assigned_count,v_seat_award_count USING ERRCODE='P0404';
      END IF;
    END IF;

    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$satellite_with_final_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;

-- The new wrappers are the only callers of these v2 cores. The older M6 names
-- are stale on replay and were renamed away on live-after-M6 history.
DROP FUNCTION IF EXISTS
  public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(
    uuid,uuid,uuid,text,uuid) RESTRICT;
DROP FUNCTION IF EXISTS
 public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid) RESTRICT;

-- Re-emit the final ticket-admission authority statically. The post-M6 source
-- regressed to a capacity helper that had already been retired and treated an
-- ambiguous seat response as success without proving what was on the felt.
-- The canonical bounded capacity owner and the exact reciprocal postcondition
-- keep funding, roster and chair in the same transaction.
CREATE OR REPLACE FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(
  p_tournament_id uuid,
  p_ticket_id uuid,
  p_beneficiary_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $ticket_admission_for$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_split record;
  v_username text;
  v_registration_id uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_entitlement_id uuid;
  v_resolved_club uuid;
  v_is_bounty boolean;
  v_late_open boolean:=false;
  v_start_chips integer:=0;
  v_seat jsonb;
  v_seat_reason text;
  v_players_before integer;
  v_wallet_rows_before bigint;
  v_wallet_rows_after bigint;
  v_rows integer;
  v_key text;
  v_ticket_use_token uuid:=gen_random_uuid();
  v_previous_ticket_use_token text:=
    current_setting('app.ca_satellite_ticket_use_token',true);
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  IF v_ticket.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_ticket.redemption_mode IS DISTINCT FROM 'tournament_entry_only' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_is_wallet_only');
  END IF;

  IF v_ticket.source_refund_entitlement_id IS NOT NULL THEN
    SELECT count(*) INTO v_rows
      FROM public.tournament_refund_entitlements source_e
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key='tourney:'
             ||source_e.tournament_id::text
             ||':satellite-ticket-return:'||source_e.id::text
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_e.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
     WHERE source_e.id=v_ticket.source_refund_entitlement_id
       AND v_ticket.source_satellite_award_place IS NULL
       AND source_e.user_id=v_uid
       AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND source_e.gross=v_ticket.value
       AND source_e.refund_prize=v_ticket.entry_prize
       AND source_e.refund_bounty=v_ticket.entry_bounty
       AND source_e.refund_fee=v_ticket.entry_fee
       AND source_e.source_satellite_id=v_ticket.source_satellite_id
       AND source_e.tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=source_e.id)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1;
  ELSE
    -- A cap-blocked satellite winner never held a target registration, so its
    -- noncash ticket is sourced directly by the immutable satellite award.
    SELECT count(*) INTO v_rows
      FROM public.tournament_satellite_awards source_a
      JOIN public.tournament_satellite_settlements source_h
        ON source_h.tournament_id=source_a.tournament_id
      JOIN public.tournament_payouts source_p ON source_p.id=source_a.payout_id
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key=source_a.idempotency_key||':ticket_escrow'
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_a.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
       AND issue_l.tournament_id=source_a.tournament_id
       AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
       AND issue_l.metadata->>'ticket_id'=v_ticket.id::text
       AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
       AND issue_l.metadata->>'satellite_target_id'=
             v_ticket.source_tournament_id::text
       AND issue_l.metadata->>'user_id'=source_a.user_id::text
       AND issue_l.metadata->>'position'=source_a.place::text
     WHERE source_a.tournament_id=v_ticket.source_satellite_id
       AND source_a.place=v_ticket.source_satellite_award_place
       AND source_a.user_id=v_uid
       AND source_a.delivery_kind='ticket'
       AND source_a.ticket_id=v_ticket.id
       AND source_a.amount=v_ticket.value
       AND source_a.payout_source='satellite_ticket'
       AND source_p.tournament_id=source_a.tournament_id
       AND source_p.user_id=source_a.user_id
       AND source_p."position"=source_a.place
       AND source_p.amount=source_a.amount
       AND source_p.source=source_a.payout_source
       AND source_p.idempotency_key=source_a.idempotency_key
       AND source_h.target_id=v_ticket.source_tournament_id
       AND source_h.ticket_cost=v_ticket.value
       AND source_h.target_buy_in=v_ticket.entry_prize
       AND source_h.target_fee=v_ticket.entry_fee
       AND p_tournament_id=v_ticket.source_tournament_id
       AND v_ticket.entry_bounty=0
       AND NOT EXISTS(
         SELECT 1 FROM public.wallet_credit_idempotency wallet_key
          WHERE wallet_key.key=source_a.idempotency_key)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'source_tournament_id'=
                     p_tournament_id::text
               AND issue_tx.metadata->>'source_satellite_id'=source_a.tournament_id::text
               AND issue_tx.metadata->>'source_award_place'=source_a.place::text
               AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
               AND issue_tx.metadata->>'idempotency_key'=
                     source_a.idempotency_key)=1;
  END IF;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket has no exact noncash issue evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_ticket.status='redeemed' THEN
    SELECT count(*),min(e.id::text)::uuid,min(e.registration_id::text)::uuid
      INTO v_rows,v_entitlement_id,v_registration_id
      FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
     WHERE e.source_ticket_id=v_ticket.id
       AND e.entitlement_kind='tournament_ticket'
       AND e.tournament_id=p_tournament_id
       AND e.user_id=v_uid
       AND tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id;
    IF v_rows=1 AND v_entitlement_id IS NOT NULL
       AND v_registration_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',v_registration_id,
        'entitlement_id',v_entitlement_id,'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_ticket.status<>'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  IF lower(COALESCE(v_t.variant,''))='spin'
     OR (v_t.max_players IS NOT NULL
       AND v_t.max_players>0 AND v_t.max_players<=2) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
  END IF;
  IF v_t.status='RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id)
                 AND NOT COALESCE(v_t.prize_pool_finalized,false);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
  END IF;
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_full');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','already_registered');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.club_members m
     WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
       AND COALESCE(m.status,'active') IN ('active','approved')) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  IF v_t.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_mismatch');
  END IF;
  IF v_t.union_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.union_clubs uc
     WHERE uc.union_id=v_t.union_id AND uc.club_id=v_ticket.club_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_union_mismatch');
  END IF;
  v_resolved_club:=public.fn_tournament_club_for_user(
    v_uid,p_tournament_id,v_ticket.club_id);
  IF v_resolved_club IS DISTINCT FROM v_ticket.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  IF COALESCE(v_t.authorized_to_register,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_registration_approvals a
        WHERE a.tournament_id=p_tournament_id AND a.user_id=v_uid)
     AND NOT public.is_club_admin(v_ticket.club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized_to_register');
  END IF;
  IF COALESCE(v_t.is_vip_only,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.profiles pr
        WHERE pr.id=v_uid AND COALESCE(pr.is_vip,false)
          AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at>now()))
     AND NOT EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
          AND m.role IN ('owner','co_owner','admin','agent')) THEN
    RETURN jsonb_build_object('ok',false,'reason','vip_only');
  END IF;

  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<=0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2)
     OR v_ticket.value IS DISTINCT FROM v_split.charge
     OR v_ticket.entry_prize IS DISTINCT FROM v_split.prize
     OR v_ticket.entry_bounty IS DISTINCT FROM v_split.bounty
     OR v_ticket.entry_fee IS DISTINCT FROM v_split.rake THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;

  IF COALESCE(v_t.early_bird_enabled,false)
     AND now()<v_t.start_time AND COALESCE(v_t.early_bird_chips,0)>0 THEN
    v_start_chips:=v_t.early_bird_chips;
  END IF;
  SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),'Player')
    INTO v_username FROM public.profiles p WHERE p.id=v_uid;
  v_username:=COALESCE(v_username,'Player');

  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'ticket admission prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  SELECT count(*) INTO v_wallet_rows_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance THEN
    RAISE EXCEPTION 'ticket admission found divergent tournament escrow'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,username,chips,status,current_bounty,
    mystery_bounty_value,bounties_collected,bounty_winnings,
    club_id,is_satellite_qualifier,source_satellite_id)
  VALUES(
    p_tournament_id,v_uid,v_username,v_start_chips,'registered',
    v_split.bounty,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
  RETURNING id INTO v_registration_id;

  v_key:='ticket:'||v_ticket.id::text||':tournament:'
         ||p_tournament_id::text||':entry';
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    v_uid,'escrow',v_ticket.id,'tournament entry ticket',
    'prize_liability',p_tournament_id,'tournaments escrow',
    v_ticket.value,'ticket_redeem',v_ticket.club_id,p_tournament_id,
    v_key,'ticket-entry:'||v_ticket.id::text,
    'fn_register_for_tournament_with_ticket',
    'Tournament-entry ticket committed to tournament admission',
    jsonb_build_object(
      'kind','tournament_entry_ticket_admission','ticket_id',v_ticket.id,
      'user_id',v_uid,'registration_id',v_registration_id,
      'source_tournament_id',v_ticket.source_tournament_id,
      'source_satellite_id',v_ticket.source_satellite_id,
      'entry_prize',v_ticket.entry_prize,
      'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee),
    v_ticket.value,0,
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance,2),
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance+v_ticket.value,2))
  RETURNING id INTO v_ledger_id;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'tournament-entry ticket admission',
    p_gross_in=>v_ticket.value,p_bounty_in=>v_ticket.entry_bounty);
  IF v_ticket.entry_fee>0 THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_ticket.club_id,v_ticket.entry_fee,v_ticket.value,1,
      0,true,p_tournament_id,'fn_register_for_tournament_with_ticket',
      jsonb_build_object(
        'kind','tournament_ticket_entry_fee','user_id',v_uid,
        'registration_id',v_registration_id,'ticket_id',v_ticket.id));
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before+1,
         prize_pool=round(v_t.prize_pool+v_ticket.entry_prize,2),
         bounty_pool=round(v_t.bounty_pool+v_ticket.entry_bounty,2),
         total_rake=round(v_t.total_rake+v_ticket.entry_fee,2),
         updated_at=now()
   WHERE id=p_tournament_id
     -- The canonical roster trigger has already counted the row inserted
     -- above. Require that exact post-insert count instead of expecting the
     -- stale pre-insert cache and then reporting a false registration race.
     AND current_players IS NOT DISTINCT FROM v_players_before+1
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket admission tournament cache changed'
      USING ERRCODE='40001';
  END IF;

  INSERT INTO public.tournament_ticket_admission_authorizations(
    token,ticket_id,tournament_id,user_id,registration_id)
  VALUES(
    v_ticket_use_token,v_ticket.id,p_tournament_id,v_uid,v_registration_id);

  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_ticket_use_token::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_ticket.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',
    COALESCE(v_previous_ticket_use_token,''),true);
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket changed during admission'
      USING ERRCODE='40001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_ticket_admission_authorizations a
     WHERE a.token=v_ticket_use_token) THEN
    RAISE EXCEPTION
      'tournament-entry ticket authorization was not consumed by admission'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    source_ticket_id,escrow_bucket,evidence_kind,created_at)
  VALUES(
    p_tournament_id,v_uid,'tournament_ticket','tournament_ticket',
    v_ticket.club_id,v_ticket.value,v_ticket.entry_prize,
    v_ticket.entry_bounty,v_ticket.entry_fee,v_ledger_id,
    v_registration_id,v_ticket.source_satellite_id,NULL,v_ticket.id,
    'ticket_gross','atomic_tournament_ticket',transaction_timestamp())
  RETURNING id INTO v_entitlement_id;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_ticket.club_id,v_uid,NULL,v_ticket.value,
    'tournament_ticket_entry','Tournament-Entry Ticket Used',NULL,
    jsonb_build_object(
      'ticket_id',v_ticket.id,'holder_id',v_uid,
      'target_tournament_id',p_tournament_id,
      'registration_id',v_registration_id,
      'entitlement_id',v_entitlement_id,'ledger_id',v_ledger_id,
      'idempotency_key',v_key,'wallet_chips_credited',0))
  RETURNING id INTO v_tx_id;

  IF v_late_open THEN
    BEGIN
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,1);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    END;
    v_seat_reason:=v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean,false)
       AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,1);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
      v_seat_reason:=v_seat->>'reason';
      IF NOT COALESCE((v_seat->>'ok')::boolean,false)
         AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
        RAISE EXCEPTION
          'Late ticket admission could not seat the player (%)',
          COALESCE(v_seat_reason,'unknown') USING ERRCODE='55000';
      END IF;
    END IF;
    -- Even the legacy ambiguous response is success only when the committed
    -- roster and chair already prove the exact same positive generation.
    IF (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid
           AND lower(COALESCE(tp.status::text,''))='playing'
           AND COALESCE(tp.chips,0)>0)<>1
       OR (SELECT count(*) FROM public.table_seats s
           JOIN public.tables tb ON tb.id=s.table_id
          WHERE tb.tournament_id=p_tournament_id
            AND s.user_id=v_uid AND s.left_at IS NULL)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
         JOIN public.table_seats s
           ON s.table_id=tp.table_id
          AND s.seat_number=tp.seat_number
          AND s.user_id=tp.user_id
          AND s.left_at IS NULL
          AND s.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric
         JOIN public.tables tb
           ON tb.id=s.table_id AND tb.tournament_id=tp.tournament_id
        WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid
          AND lower(COALESCE(tp.status::text,''))='playing'
          AND COALESCE(tp.chips,0)>0) THEN
      RAISE EXCEPTION
        'Late ticket admission has no exact positive roster-seat generation'
        USING ERRCODE='P0404';
    END IF;
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_ticket_registration');
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_wallet_rows_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_after.prize_balance IS DISTINCT FROM
       round(v_escrow_before.prize_balance+v_ticket.entry_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
       round(v_escrow_before.bounty_balance+v_ticket.entry_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
       round(v_escrow_before.fee_balance+v_ticket.entry_fee,2)
     OR v_wallet_rows_after IS DISTINCT FROM v_wallet_rows_before THEN
    RAISE EXCEPTION 'ticket admission did not preserve exact noncash rails'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'registration_id',v_registration_id,'entitlement_id',v_entitlement_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'ticket_value',v_ticket.value,'wallet_chips_credited',0,
    'prize_contribution',v_ticket.entry_prize,
    'bounty_contribution',v_ticket.entry_bounty,
    'fee_contribution',v_ticket.entry_fee,'late_registration',v_late_open,
    'seat',v_seat);
END;
$ticket_admission_for$;

REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(
  uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- M6 owns the one-time, evidence-bound repair for an accepted zero-stack hand.
-- This later migration must never reverse that cutover or infer chips from a
-- stale chair. Fail closed if any latest unresolved zero-stack candidate still
-- has a live chair; enabling the reciprocal invariant is not allowed to hide
-- that historical generation by mirroring the chair stack into the roster.
DO $prove_no_pending_zero_live_seat_survived$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id=c.tournament_id
   WHERE upper(COALESCE(t.status::text,''))='RUNNING'
     AND c.state='pending' AND c.resolved_at IS NULL AND c.stack_after=0
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=c.tournament_id
          AND s.user_id=c.eliminated_user_id AND s.left_at IS NULL)) THEN
    RAISE EXCEPTION 'a pending accepted zero-stack candidate still has a live seat'
      USING ERRCODE='P0404';
  END IF;
END;
$prove_no_pending_zero_live_seat_survived$;

-- The later expiry migration regressed to a candidate-snapshot estimate. The
-- final definition locks the terminal root and tournament, re-reads the whole
-- board, skips a filled/funded/launched race, and totals only the immutable
-- receipt returned by atomic cancellation.
CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(
  p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $expire_unfilled_from_exact_cancellation_receipt$
DECLARE
  v_minutes integer;
  g record;
  v_current record;
  v_skipped integer:=0;
  v_result jsonb;
  v_expired integer:=0;
  v_failed integer:=0;
  v_refunded numeric:=0;
  v_ids jsonb:='[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_spin_expire_unfilled requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT unfilled_timeout_minutes INTO v_minutes
    FROM public.spin_fill_policy LIMIT 1;
  v_minutes:=COALESCE(v_minutes,30);
  IF v_minutes<=0 THEN
    RETURN jsonb_build_object('ok',true,'disabled',true,'expired',0);
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_global();

  FOR g IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.variant='spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND t.started_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
         JOIN public.tables tb ON tb.id=s.table_id
          WHERE tb.tournament_id=t.id AND s.left_at IS NULL
            AND s.joined_at<now()-make_interval(mins=>v_minutes))
       AND (SELECT count(*) FROM public.table_seats s
             JOIN public.tables tb ON tb.id=s.table_id
            WHERE tb.tournament_id=t.id AND s.left_at IS NULL)
           <COALESCE(t.max_players,3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit,50),1)
  LOOP
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=g.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_skipped:=v_skipped+1;
      CONTINUE;
    END IF;

    SELECT t.status,t.variant,t.started_at,t.spin_multiplier,
           COALESCE(t.max_players,3) AS max_players,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL) AS live_seats,
           EXISTS(SELECT 1 FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL
               AND s.joined_at<now()-make_interval(mins=>v_minutes))
             AS has_expired_waiter,
           EXISTS(SELECT 1 FROM public.spin_reserve_ledger l
             WHERE l.tournament_id=t.id AND l.kind='jackpot_draw')
             OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r
               WHERE r.tournament_id=t.id) AS has_booked_draw
      INTO v_current FROM public.tournaments t WHERE t.id=g.id;

    IF v_current.variant IS DISTINCT FROM 'spin'
       OR v_current.status NOT IN ('REGISTERING','ANNOUNCED')
       OR v_current.status IS NULL
       OR v_current.started_at IS NOT NULL
       OR v_current.live_seats>=v_current.max_players
       OR NOT v_current.has_expired_waiter
       OR v_current.spin_multiplier IS NOT NULL
       OR v_current.has_booked_draw THEN
      v_skipped:=v_skipped+1;
      CONTINUE;
    END IF;

    BEGIN
      v_result:=public.atomic_cancel_tournament(g.id,NULL);
      IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'atomic cancellation returned no success receipt';
      END IF;
      v_expired:=v_expired+1;
      v_refunded:=v_refunded+
        COALESCE((v_result->>'total_refunded')::numeric,0);
      v_ids:=v_ids||to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %',g.id,SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object(
    'ok',v_failed=0,'expired',v_expired,'failed',v_failed,
    'skipped_raced',v_skipped,
    'chips_refunded',round(v_refunded,2),'timeout_minutes',v_minutes,
    'tournament_ids',v_ids);
END;
$expire_unfilled_from_exact_cancellation_receipt$;

REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer)
  TO service_role;

-- This verifier is read-only. It is invoked by deferred constraint triggers on
-- both halves of the relationship and by the RUNNING parent transition.
CREATE OR REPLACE FUNCTION
  public.fn_ca_assert_running_tournament_roster_seat(
    p_tournament_id uuid,p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $running_roster_seat_invariant$
DECLARE
  v_status text;
  v_bad_user uuid;
  v_reason text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN;
  END IF;
  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN;
  END IF;

  SELECT tp.user_id,
         CASE
           WHEN lower(COALESCE(tp.status::text,''))='registered'
             THEN 'registered roster survived RUNNING'
           WHEN COALESCE(tp.chips,0)<=0
             THEN 'zero-chip playing roster retained a live seat'
           ELSE 'positive playing roster has no exact live seat mirror'
         END
    INTO v_bad_user,v_reason
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND (p_user_id IS NULL OR tp.user_id=p_user_id)
     AND (
       lower(COALESCE(tp.status::text,''))='registered'
       OR (
         lower(COALESCE(tp.status::text,''))='playing'
         AND COALESCE(tp.chips,0)<=0
         AND EXISTS (
           SELECT 1 FROM public.table_seats s
           JOIN public.tables tb ON tb.id=s.table_id
            WHERE tb.tournament_id=tp.tournament_id
              AND s.user_id=tp.user_id AND s.left_at IS NULL))
       OR (
         lower(COALESCE(tp.status::text,''))='playing'
         AND COALESCE(tp.chips,0)>0
         AND (
           tp.table_id IS NULL OR tp.seat_number IS NULL
           OR (SELECT count(*) FROM public.table_seats s
               JOIN public.tables tb ON tb.id=s.table_id
              WHERE tb.tournament_id=tp.tournament_id
                AND s.user_id=tp.user_id AND s.left_at IS NULL)<>1
           OR NOT EXISTS (
             SELECT 1 FROM public.table_seats s
             JOIN public.tables tb ON tb.id=s.table_id
              WHERE tb.tournament_id=tp.tournament_id
                AND s.user_id=tp.user_id AND s.left_at IS NULL
                AND s.table_id=tp.table_id
                AND s.seat_number=tp.seat_number
                AND s.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric))))
   ORDER BY tp.user_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'RUNNING_TOURNAMENT_ROSTER_SEAT_MISMATCH: tournament %, user %, %',
      p_tournament_id,v_bad_user,v_reason USING ERRCODE='23514';
  END IF;

  SELECT s.user_id,'live seat has no exact positive playing roster mirror'
    INTO v_bad_user,v_reason
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
     AND (
       (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id
           AND tp.user_id=s.user_id
           AND lower(COALESCE(tp.status::text,''))='playing'
           AND COALESCE(tp.chips,0)>0)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id=p_tournament_id
            AND tp.user_id=s.user_id
            AND lower(COALESCE(tp.status::text,''))='playing'
            AND COALESCE(tp.chips,0)>0
            AND tp.table_id=s.table_id
            AND tp.seat_number=s.seat_number
            AND tp.chips::numeric IS NOT DISTINCT FROM s.stack::numeric))
   ORDER BY s.user_id,s.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'RUNNING_TOURNAMENT_ROSTER_SEAT_MISMATCH: tournament %, user %, %',
      p_tournament_id,v_bad_user,v_reason USING ERRCODE='23514';
  END IF;
END;
$running_roster_seat_invariant$;

REVOKE ALL ON FUNCTION
  public.fn_ca_assert_running_tournament_roster_seat(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION
  public.trg_ca_assert_running_tournament_roster_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $running_roster_seat_constraint_trigger$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_TABLE_NAME='tournament_players' THEN
    IF TG_OP<>'INSERT' THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        OLD.tournament_id,OLD.user_id);
    END IF;
    IF TG_OP='INSERT' THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        NEW.tournament_id,NEW.user_id);
    ELSIF TG_OP='UPDATE'
          AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
               OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        NEW.tournament_id,NEW.user_id);
    END IF;
  ELSIF TG_TABLE_NAME='table_seats' THEN
    IF TG_OP<>'INSERT' THEN
      SELECT tb.tournament_id INTO v_old_tournament_id
        FROM public.tables tb WHERE tb.id=OLD.table_id;
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        v_old_tournament_id,OLD.user_id);
    END IF;
    IF TG_OP='INSERT' THEN
      SELECT tb.tournament_id INTO v_new_tournament_id
        FROM public.tables tb WHERE tb.id=NEW.table_id;
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        v_new_tournament_id,NEW.user_id);
    ELSIF TG_OP='UPDATE' THEN
      SELECT tb.tournament_id INTO v_new_tournament_id
        FROM public.tables tb WHERE tb.id=NEW.table_id;
      IF v_new_tournament_id IS DISTINCT FROM v_old_tournament_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        PERFORM public.fn_ca_assert_running_tournament_roster_seat(
          v_new_tournament_id,NEW.user_id);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='tournaments' THEN
    IF TG_OP<>'DELETE' THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(NEW.id,NULL);
    END IF;
  ELSE
    RAISE EXCEPTION 'running roster-seat trigger attached to unexpected table %',
      TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$running_roster_seat_constraint_trigger$;

REVOKE ALL ON FUNCTION
  public.trg_ca_assert_running_tournament_roster_seat()
  FROM PUBLIC,anon,authenticated,service_role;

-- Existing production rows must already satisfy the invariant. M6 performs
-- the only evidence-bound cutover repair; this migration repairs no roster or
-- chair state and aborts on every remaining mismatch.
DO $assert_existing_running_roster_seat_state$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t.id FROM public.tournaments t
            WHERE upper(COALESCE(t.status::text,''))='RUNNING'
            ORDER BY t.id
  LOOP
    PERFORM public.fn_ca_assert_running_tournament_roster_seat(r.id,NULL);
  END LOOP;
END;
$assert_existing_running_roster_seat_state$;

DROP TRIGGER IF EXISTS tournament_live_seat_has_active_roster
  ON public.table_seats;
DROP TRIGGER IF EXISTS tournament_live_seat_update_has_active_roster
  ON public.table_seats;
DROP TRIGGER IF EXISTS tournament_roster_cannot_orphan_live_seat
  ON public.tournament_players;
DROP TRIGGER IF EXISTS tournament_roster_update_cannot_orphan_live_seat
  ON public.tournament_players;
DROP FUNCTION IF EXISTS
  public.trg_assert_live_tournament_seat_has_roster() RESTRICT;

CREATE CONSTRAINT TRIGGER tournament_players_match_live_seat_at_commit
  AFTER INSERT OR UPDATE OR DELETE ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.trg_ca_assert_running_tournament_roster_seat();

CREATE CONSTRAINT TRIGGER tournament_live_seats_match_roster_at_commit
  AFTER INSERT OR UPDATE OR DELETE ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.trg_ca_assert_running_tournament_roster_seat();

CREATE CONSTRAINT TRIGGER running_tournament_roster_seat_match_at_commit
  AFTER INSERT OR UPDATE ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.trg_ca_assert_running_tournament_roster_seat();

-- Re-emit the complete current conservation sweep as static source without the
-- absent-player entry. The sweep remains an operator detector; it no longer
-- calls or advertises a mutation job through an executable SQL string.
CREATE OR REPLACE FUNCTION public.fn_ca_conservation_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $conservation_sweep_without_absent_mutation$
DECLARE
  c record;
  v_n bigint;
  v_rows jsonb;
  v_verdict jsonb;
  v_found integer:=0;
  v_failed integer:=0;
  v_ran integer:=0;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() where severity <> ''ok'' limit 20) t',
       'warning'),
      ('fn_settlement_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_settlement_conservation_check() limit 20) t',
       'critical'),
      ('fn_union_chip_integrity_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_chip_integrity_check() limit 20) t',
       'critical'),
      ('fn_union_money_path_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_money_path_check() limit 20) t',
       'warning'),
      ('fn_club_arena_global_wallet_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_club_arena_global_wallet_check() limit 20) t',
       'warning'),
      ('fn_tournament_chip_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_chip_conservation_check(0.01) limit 20) t',
       'warning'),
      ('fn_satellite_conservation_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_satellite_conservation_audit(24) limit 20) t',
       'warning'),
      ('fn_tournament_prize_disbursement_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_prize_disbursement_audit(24) limit 20) t',
       'warning'),
      ('fn_union_credit_risk_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_credit_risk_check() limit 20) t',
       'warning'),
      ('fn_union_governance_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_governance_check() limit 20) t',
       'warning'),
      ('fn_union_house_club_stamp_check',
       'select v.n, case when v.n > 0 then jsonb_build_object(''unstamped_union_tables'', v.n) end from (select public.fn_union_house_club_stamp_check() as n) v',
       'warning'),
      ('fn_union_law_integrity_breaches',
       'select coalesce(jsonb_array_length(v.j),0), case when coalesce(jsonb_array_length(v.j),0) > 0 then v.j end from (select public.fn_union_law_integrity_breaches() as j) v',
       'critical'),
      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning'),
      ('fn_rake_spec_self_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_rake_spec_self_check() limit 20) t',
       'warning'),
      ('fn_spin_ladder_drift_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_spin_ladder_drift_check(7) limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning'),
      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning'),
      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning'),
      ('fn_ca_hand_commit_refusals',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_hand_commit_refusals(24) limit 20) t',
       'warning')
    ) v(check_name,q,sev)
  LOOP
    BEGIN
      v_ran:=v_ran+1;
      EXECUTE c.q INTO v_n,v_rows;
      IF COALESCE(v_n,0)>0 THEN
        v_found:=v_found+1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:'||c.check_name,
          'ledger_imbalance',c.sev,
          'sweep:'||c.check_name||':'||CURRENT_DATE::text,
          0,NULL,v_n::numeric,'ledger',c.check_name,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
          c.check_name||' returned '||v_n||
            ' finding(s) - an invariant does not hold',
          false,jsonb_build_object('rows',v_rows,'row_count',v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:'||c.check_name,'unknown','warning',
        'sweepfail:'||c.check_name||':'||CURRENT_DATE::text,
        0,NULL,NULL,'ledger',c.check_name,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        'check could not run: '||SQLERRM||
          ' - a check that errors is as silent as one that never runs',
        false,jsonb_build_object('sqlstate',SQLSTATE));
    END;
  END LOOP;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_bbj_conservation_check',
       'select public.fn_bbj_conservation_check()','healthy'),
      ('fn_bbj_promo_bank_check',
       'select public.fn_bbj_promo_bank_check()','reconciles'),
      ('fn_settler_lag_check',
       'select public.fn_settler_lag_check()','healthy'),
      ('fn_tournament_guarantee_check',
       'select public.fn_tournament_guarantee_check(24)','__guarantee')
    ) v(check_name,q,health_key)
  LOOP
    BEGIN
      v_ran:=v_ran+1;
      EXECUTE c.q INTO v_verdict;
      IF (c.health_key='__guarantee'
            AND (COALESCE((v_verdict->>'short_of_guarantee')::numeric,0)>0
              OR COALESCE((v_verdict->>'paid_nothing')::numeric,0)>0))
         OR (c.health_key<>'__guarantee'
            AND COALESCE((v_verdict->>c.health_key)::boolean,true) IS NOT TRUE)
      THEN
        v_found:=v_found+1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:'||c.check_name,
          'ledger_imbalance','warning',
          'sweep:'||c.check_name||':'||CURRENT_DATE::text,
          COALESCE((v_verdict->>'drift_from_baseline')::numeric,
                   (v_verdict->>'over_swept')::numeric,
                   (v_verdict->>'chips_short')::numeric,0),
          NULL,NULL,'ledger',c.check_name,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
          c.check_name||' reports a conservation failure',false,v_verdict);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:'||c.check_name,'unknown','warning',
        'sweepfail:'||c.check_name||':'||CURRENT_DATE::text,
        0,NULL,NULL,'ledger',c.check_name,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        'check could not run: '||SQLERRM,
        false,jsonb_build_object('sqlstate',SQLSTATE));
    END;
  END LOOP;

  INSERT INTO public.ca_detector_runs(detector,detail)
  VALUES('fn_ca_conservation_sweep',jsonb_build_object(
    'checks_run',v_ran,'with_findings',v_found,'errored',v_failed));

  RETURN jsonb_build_object(
    'ok',true,'checks_run',v_ran,
    'with_findings',v_found,'errored',v_failed);
END;
$conservation_sweep_without_absent_mutation$;

REVOKE ALL ON FUNCTION public.fn_ca_conservation_sweep()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_conservation_sweep()
  TO service_role;

DELETE FROM public.ca_detector_registry
 WHERE source='fn_ca_conservation_sweep:fn_ca_absent_tournament_players';

DROP FUNCTION public.fn_ca_absent_tournament_players(integer) RESTRICT;
DROP FUNCTION public.fn_ca_release_broke_seats(
  integer,integer,boolean) RESTRICT;
DROP TABLE public.ca_broke_seat_sightings RESTRICT;

-- Prize recalculation keeps one narrow database door. It is allowed only while
-- the event is RUNNING, before a place/satellite batch, terminal/cancellation
-- receipt, or any prepared or paid place evidence exists. Compare-and-set makes
-- a retry or stale engine snapshot explicit instead of silently overwriting a
-- new value.
CREATE OR REPLACE FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_prize numeric,
  p_new_prize numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $reprice_unpaid_tournament_place$
DECLARE
  v_tournament_status text;
  v_roster_id uuid;
  v_current_prize numeric;
  v_updated_prize numeric;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament prize repricing requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_expected_prize IS NULL OR p_new_prize IS NULL
     OR p_expected_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_new_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_expected_prize<0 OR p_new_prize<0
     OR p_expected_prize<>round(p_expected_prize,2)
     OR p_new_prize<>round(p_new_prize,2) THEN
    RAISE EXCEPTION 'tournament prize repricing requires finite nonnegative exact cents'
      USING ERRCODE='22023';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF v_tournament_status<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament prize repricing requires RUNNING status'
      USING ERRCODE='55000';
  END IF;

  SELECT tp.id,tp.prize::numeric INTO v_roster_id,v_current_prize
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament player does not exist'
      USING ERRCODE='P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
              WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements h
                 WHERE h.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts c
                 WHERE c.tournament_id=p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id
          AND o.kind IN (
            'place','bubble_protection','final_table_deal',
            'late_reg_adjustment'))
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id=p_tournament_id
          AND (p.source IN (
            'structure','reconcile','hu_shortfall','late_reg_adjustment',
            'clawback','spin_backpay','overlay_backpay','final_table_deal')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 p.tournament_id,p.idempotency_key))) THEN
    RAISE EXCEPTION
      'tournament prize repricing is closed after prepared or paid terminal evidence'
      USING ERRCODE='55000';
  END IF;

  IF v_current_prize IS DISTINCT FROM p_expected_prize THEN
    RAISE EXCEPTION 'tournament prize changed from expected % to %',
      p_expected_prize,v_current_prize USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players tp
     SET prize=p_new_prize
   WHERE tp.id=v_roster_id
     AND tp.tournament_id=p_tournament_id
     AND tp.user_id=p_user_id
     AND tp.prize IS NOT DISTINCT FROM p_expected_prize
  RETURNING tp.prize::numeric INTO v_updated_prize;
  IF NOT FOUND OR v_updated_prize IS DISTINCT FROM p_new_prize THEN
    RAISE EXCEPTION 'tournament prize compare-and-set lost its locked row'
      USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',p_tournament_id,'user_id',p_user_id,
    'prize',v_updated_prize);
END;
$reprice_unpaid_tournament_place$;

REVOKE ALL ON FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  uuid,uuid,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  uuid,uuid,numeric,numeric) TO service_role;

-- Raw service-role roster writes are no longer a runtime API. Registration,
-- seating, hands, rebuys, elimination, terminal settlement and this one prize
-- compare-and-set all execute through their scoped SECURITY DEFINER owners.
REVOKE INSERT,UPDATE,DELETE ON TABLE public.tournament_players
  FROM service_role;

DO $postcondition$
DECLARE
  v_source text;
  v_trigger_count integer;
  r record;
BEGIN
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)'::regprocedure;
  IF position(
       'satellite-funded registration % can return only a tournament ticket'
       IN v_source)=0
     OR position('fn_ca_return_satellite_entitlement_as_ticket' IN v_source)=0
     OR position('v_ticket_amount<=0' IN v_source)=0
     OR position('returns the same escrow value in cash' IN v_source)>0
     OR position('wallet_chips_from_satellite_entitlements' IN v_source)>0 THEN
    RAISE EXCEPTION 'final exact-unregistration core is not ticket-only';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure;
  IF position(
       'fn_ca_unregister_tournament_player_exact_seat_exit_core_v2'
       IN v_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0 THEN
    RAISE EXCEPTION 'final exact-unregistration seat wrapper is incomplete';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure;
  IF position('fn_settle_satellite_tournament_seat_exit_core_v2'
              IN v_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0 THEN
    RAISE EXCEPTION 'final satellite seat wrapper is incomplete';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'a superseded M6 late core survived final capture';
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'a final seat-exit core is directly executable';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid='public.fn_spin_expire_unfilled(integer)'::regprocedure;
  IF position('FOR UPDATE SKIP LOCKED' IN v_source)=0
     OR position('has_booked_draw' IN v_source)=0
     OR position('skipped_raced' IN v_source)=0
     OR position($needle$v_result->>'total_refunded'$needle$ IN v_source)=0
     OR position('buy_in_amount' IN v_source)>0 THEN
    RAISE EXCEPTION 'Spin expiry is not the locked exact-receipt definition';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)') IS NULL THEN
    RAISE EXCEPTION 'the owner-only felt-aware eliminator was lost';
  END IF;
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)'::regprocedure;
  IF position('THE FELT DECIDES WHO BUSTED' IN v_source)=0
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)',
          'EXECUTE')
     OR has_function_privilege(
          'authenticated',
          'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)',
          'EXECUTE')
     OR has_function_privilege(
          'anon',
          'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)',
          'EXECUTE')
     OR to_regprocedure(
          'public.fn_ca_absent_tournament_players(integer)') IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_release_broke_seats(integer,integer,boolean)') IS NOT NULL
     OR to_regclass('public.ca_broke_seat_sightings') IS NOT NULL THEN
    RAISE EXCEPTION
      'retired sweep surface or felt-aware dormant authority is not canonical';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobname IN (
       'ca-eliminate-absent-players','ca-release-broke-seats')
        OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
        OR j.command ILIKE '%fn_ca_release_broke_seats%') THEN
    RAISE EXCEPTION 'a retired tournament mutation cron survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ca_detector_registry d
     WHERE d.source=
       'fn_ca_conservation_sweep:fn_ca_absent_tournament_players') THEN
    RAISE EXCEPTION 'retired absent-player detector registration survived';
  END IF;
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid='public.fn_ca_conservation_sweep()'::regprocedure;
  IF position('fn_ca_absent_tournament_players' IN v_source)>0
     OR position('fn_ca_stranded_tournament_players' IN v_source)=0
     OR position('0,NULL,v_n::numeric,''ledger'',c.check_name' IN v_source)=0
     OR position('INSERT INTO public.ca_detector_runs' IN v_source)=0 THEN
    RAISE EXCEPTION 'final conservation sweep source is not canonical';
  END IF;

  SELECT count(*) INTO v_trigger_count
    FROM pg_trigger tg
   WHERE (tg.tgrelid,tg.tgname) IN (
     ('public.tournament_players'::regclass,
      'tournament_players_match_live_seat_at_commit'),
     ('public.table_seats'::regclass,
      'tournament_live_seats_match_roster_at_commit'),
     ('public.tournaments'::regclass,
      'running_tournament_roster_seat_match_at_commit'))
     AND tg.tgfoid=
       'public.trg_ca_assert_running_tournament_roster_seat()'::regprocedure
     AND tg.tgconstraint<>0 AND tg.tgdeferrable AND tg.tginitdeferred
     AND NOT tg.tgisinternal AND tg.tgenabled='O';
  IF v_trigger_count<>3 THEN
    RAISE EXCEPTION 'running tournament roster-seat invariant is not deferred on all roots';
  END IF;

  FOR r IN SELECT t.id FROM public.tournaments t
            WHERE upper(COALESCE(t.status::text,''))='RUNNING'
            ORDER BY t.id
  LOOP
    PERFORM public.fn_ca_assert_running_tournament_roster_seat(r.id,NULL);
  END LOOP;

  IF has_table_privilege(
       'service_role','public.tournament_players','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_players','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_players','DELETE') THEN
    RAISE EXCEPTION 'service_role retains a raw tournament roster write';
  END IF;
  IF NOT has_function_privilege(
       'service_role',
       'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',
       'EXECUTE')
     OR NOT (SELECT p.prosecdef FROM pg_proc p
              WHERE p.oid=
                'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)'::regprocedure) THEN
    RAISE EXCEPTION 'prize repricing RPC ACL or definer contract is incomplete';
  END IF;

END;
$postcondition$;

DO $phase_b_freeze_still_held$
DECLARE
  v_pristine boolean;
BEGIN
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;
  IF NOT v_pristine
     AND public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION
      'final tournament roster-seat maintenance entry freeze expired before commit'
      USING ERRCODE='55006';
  END IF;
END;
$phase_b_freeze_still_held$;

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: STRICT TOURNAMENT-MANAGER AUTHORITY
-- ===========================================================================
-- 20260910002530_tournament_manager_request_fencing_is_strict
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 15:50:43 UTC.
--
/*
 * 20260910002530 -- STAGE B strict activation of the tournament-manager
 * request fence.
 *
 * This is deliberately a separate, forward-only cutover from Stage A.  Apply
 * it only after the exact-seat expansion (20260908161534) is installed and
 * the exact Stage-A engine build is the sole running build and
 * every older process has drained.  There is no timer, watcher, repair sweep,
 * or runtime flag: generation-blind engine compatibility doors are removed
 * transactionally here without changing unrelated shared-estate traffic.
 *
 * The database can prove three things at this boundary:
 *
 *   1. every manager-exclusive or engine-authority Data API route identifies
 *      its actor, while unrelated shared-estate service traffic stays valid;
 *   2. a tournament-manager request holds one exact, fresh lease generation
 *      for the complete PostgREST transaction;
 *   3. a marked manager may mutate the four shared core row families only
 *      inside that tournament.
 *
 * Ordinary service work remains valid because Club Arena and World Hub share
 * this PostgREST database hook and credential. Scheduling, registration,
 * recovery and cash-table services also legitimately share manager relations.
 * It would be incorrect to infer "manager" from service_role or a table name.
 * The runtime's single-client/method-binding guards plus the private-route
 * boundary prove that manager work cannot silently shed its actor marker.
 */


/* A busy relation aborts the whole cutover instead of making a live table
   wait behind DDL. Re-run only in the audited quiet window after inspecting
   the unchanged catalog; never hide a timeout behind an automatic retry. */

/* The transaction-start gate already owns realtime.subscription before every
   public relation/catalog operation in this composed boundary. */

/* Stage B is a contraction after the independently receipted seat-first
   retirement. Refuse to duplicate or bypass that boundary: the atomic creator
   must exist and both legacy repair doors must already be absent. */
DO $require_seat_first_retirement$
BEGIN
  IF to_regprocedure(
       'public.fn_create_seat_first_game_atomic(uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the atomic seat-first creator';
  END IF;

  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL
     OR to_regprocedure(
          'public.fn_repair_seat_first_games_before_maintenance_gate(integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the receipted seat-first retirement first';
  END IF;
END;
$require_seat_first_retirement$;

/* Refuse an out-of-order cutover or an accidental replacement of an unrelated
   PostgREST hook. This contraction is forward-only and applied once; the
   Supabase migration ledger, not source-level replay, prevents reapplication. */
DO $require_stage_a_request_authority$
DECLARE
  v_hook oid:=to_regprocedure(
    'smarter_private.fn_smarter_data_api_pre_request()');
  v_claim oid:=to_regprocedure(
    'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)');
  v_heartbeat oid:=to_regprocedure(
    'public.heartbeat_tournament_leases_v4(text,jsonb,integer)');
  v_exact_hand oid:=to_regprocedure(
    'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)');
  v_addon oid:=to_regprocedure(
    'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)');
  v_close oid:=to_regprocedure(
    'public.fn_close_empty_tournament_table(uuid,uuid,uuid)');
  v_postgres oid:='postgres'::regrole;
  v_bad integer;
  v_source text;
  v_hook_semantic text;
  v_claim_source text;
  v_heartbeat_source text;
  v_settlement_core text;
  v_settlement_door text;
  v_settlement_wrapper text;
  v_manager_write_lease_pattern text := $manager_write_lease_pattern$FROM[[:space:]]+public\.engine_tournament_leases[[:space:]]+l[[:space:]]+WHERE[[:space:]]+l\.tournament_id[[:space:]]*=[[:space:]]*v_tournament_id[[:space:]]+AND[[:space:]]+l\.protocol_version[[:space:]]*=[[:space:]]*2[[:space:]]+AND[[:space:]]+l\.lease_generation[[:space:]]*=[[:space:]]*v_lease_generation[[:space:]]+AND[[:space:]]+l\.heartbeat_at[[:space:]]*>=[[:space:]]*clock_timestamp\(\)[[:space:]]*-[[:space:]]*make_interval\(secs[[:space:]]*=>[[:space:]]*v_stale_seconds\)[^;]*FOR[[:space:]]+KEY[[:space:]]+SHARE[[:space:]]*;$manager_write_lease_pattern$;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM supabase_migrations.schema_migrations m
        WHERE m.version='20260910063559'
          AND m.name='a_busy_manager_keeps_its_lease'
          AND cardinality(m.statements)=1
          AND octet_length(m.statements[1])=6980
          AND encode(extensions.digest(m.statements[1],'sha256'),'hex')=
            '2e95299dd7693a09ee310a4086b2dcdf16f0f942582007bdede0c4c81024e07d'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM supabase_migrations.schema_migrations m
        WHERE m.version='20260910064701'
          AND m.name=
            'a_hand_commit_does_not_hold_the_lease_against_its_own_heartb'
          AND cardinality(m.statements)=1
          AND octet_length(m.statements[1])=4328
          AND encode(extensions.digest(m.statements[1],'sha256'),'hex')=
            '5816d16550ef470f9359cae427aec0c5346df92f5c6d35b07385def4ab9b4c04'
     ) THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the exact 063559 and 064701 live lease postimages';
  END IF;

  IF v_hook IS NULL OR v_claim IS NULL OR v_heartbeat IS NULL
     OR v_exact_hand IS NULL OR v_addon IS NULL OR v_close IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires every current lease authority function';
  END IF;

  /* These PG17 hashes were derived by replaying the two byte-exact live
     migrations above over their measured preimages. Bind source, catalog
     behavior, and the direct EXECUTE grantees before any Stage-B replacement. */
  SELECT count(*)::integer INTO v_bad
    FROM (
      VALUES
        (v_hook,
         'c57716917b5ec20ccdf19c90e7a86427'::text,
         'ab227471f29f2944ebd64909622b6af7'::text,
         'void'::regtype,false,0,0,
         ARRAY['search_path=pg_catalog, pg_temp']::text[],
         ARRAY['anon','authenticated','postgres','service_role']::name[]),
        (v_claim,
         '73abfc4523de42cb4b8bca5443602cbd'::text,
         'd1b5100c2b9f92bec5fd1680b0b4f230'::text,
         'record'::regtype,true,5,3,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[]),
        (v_heartbeat,
         '4a41b0124e75e46ed8121e6a56014758'::text,
         '5e6c99545e07c21efcb50e5cb3441c14'::text,
         'record'::regtype,true,3,1,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[]),
        (v_exact_hand,
         'e3a2120fc6db33ad84fc4967126fe9b8'::text,
         '457ad8f1e1528ad205f7bd43488f3e14'::text,
         'jsonb'::regtype,false,11,0,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres']::name[]),
        (v_addon,
         '276314a02cecc35607cde1afdc2fdf21'::text,
         '8ab94f005d1dcc695c7094eec3fd279d'::text,
         'jsonb'::regtype,false,4,0,
         ARRAY['search_path=public, extensions, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[]),
        (v_close,
         '0af954ab1264dc12ebce7741b7845343'::text,
         '4abef1a7ccd6d56c2523fe6cb02396b6'::text,
         'jsonb'::regtype,false,3,0,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[])
    ) expected(
      function_oid,definition_md5,source_md5,return_type,returns_set,
      argument_count,default_count,configuration,execute_grantees)
    LEFT JOIN pg_proc p ON p.oid=expected.function_oid
    LEFT JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid IS NULL
      OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM expected.definition_md5
      OR md5(p.prosrc) IS DISTINCT FROM expected.source_md5
      OR p.proowner IS DISTINCT FROM v_postgres
      OR NOT p.prosecdef OR p.proretset IS DISTINCT FROM expected.returns_set
      OR p.proisstrict OR p.proleakproof
      OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.prokind<>'f'
      OR p.prorettype IS DISTINCT FROM expected.return_type
      OR p.pronargs IS DISTINCT FROM expected.argument_count
      OR p.pronargdefaults IS DISTINCT FROM expected.default_count
      OR p.proconfig IS DISTINCT FROM expected.configuration
      OR l.lanname IS DISTINCT FROM 'plpgsql'
      OR (
        SELECT array_agg(
                 (CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                       ELSE pg_get_userbyid(acl.grantee) END)::name
                 ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                               ELSE pg_get_userbyid(acl.grantee) END)
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE acl.privilege_type='EXECUTE'
           AND acl.grantor=p.proowner
           AND NOT acl.is_grantable
      ) IS DISTINCT FROM expected.execute_grantees
      OR EXISTS (
        SELECT 1
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE acl.privilege_type<>'EXECUTE'
            OR acl.grantor<>p.proowner
            OR acl.is_grantable
      );
  IF v_bad<>0 THEN
    RAISE EXCEPTION
      'Stage-B lease authority preflight found % drifted 063559/064701 functions',
      v_bad;
  END IF;

  SELECT p.prosrc INTO STRICT v_source
    FROM pg_proc p
   WHERE p.oid=v_hook;
  -- Comments are explanatory, not executable tokens. Remove them before the
  -- bounded statement regex so a semicolon inside the audited lease rationale
  -- cannot be mistaken for the SQL statement terminator.
  v_hook_semantic := regexp_replace(v_source, '/\*.*?\*/', ' ', 'gs');
  SELECT p.prosrc INTO STRICT v_claim_source
    FROM pg_proc p WHERE p.oid=v_claim;
  SELECT p.prosrc INTO STRICT v_heartbeat_source
    FROM pg_proc p WHERE p.oid=v_heartbeat;

  IF position('app.smarter_data_actor' IN v_source) = 0
     OR position('x-smarter-data-actor' IN v_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_source) = 0
     OR v_hook_semantic !~ v_manager_write_lease_pattern
     OR v_hook_semantic ~
          'engine_tournament_leases[[:space:]]+l[[:space:]][^;]*FOR[[:space:]]+SHARE[[:space:]]*;'
     OR position('request.jwt.claims' IN v_source) = 0
     OR position('auth.role()' IN v_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_source) = 0
     OR position(E'PERFORM 1 FROM public.engine_tournament_leases l\n'
                 '   WHERE l.tournament_id = p_tournament_id\n'
                 '   FOR UPDATE;\n\n'
                 '  INSERT INTO public.engine_tournament_leases' IN
                 v_claim_source) = 0
     OR position('FOR NO KEY UPDATE OF l SKIP LOCKED' IN
                 v_heartbeat_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B activation over an incomplete busy-manager lease repair';
  END IF;

  IF to_regprocedure(
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'
     ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_tournament_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_table_leases_v4(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_table_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_process_hand_post_commit_obligations(uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires every tournament and table protocol-2 authority door';
  END IF;

  /* This contraction deletes the rolling 11-argument hand door below. The
     seat-exit authority prerequisite has already moved the receipt-aware,
     rolling exact-seat implementation behind an owner-only name and installed
     an owner-only capability wrapper at the canonical name. Inspect that real
     composition rather than the wrapper as though it were still the inner
     writer. The immediately following 20260910002540 boundary contracts the
     preserved implementation to strict exact-seat input before the stopped
     engine may restart. Any partial or unknown composition aborts whole. */
  SELECT pg_get_functiondef(
           'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
         )
    INTO STRICT v_settlement_door;

  SELECT pg_get_functiondef(
           'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
         )
    INTO STRICT v_settlement_core;

  SELECT p.prosrc
    INTO STRICT v_settlement_wrapper
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
     AND p.prosecdef;

  IF md5(v_settlement_core) <> '2c5f04ae307d38f187b8b72a3f557738'
     OR md5(v_settlement_door) <> 'a1738adaf943656868e68a7bf7ce8d1e'
     OR md5(v_settlement_wrapper) <> '9d6a12c82aa260c22e1c013e95faca0e'
     OR position('v_exact_seat_generation' IN v_settlement_core) = 0
     OR position('v_exact_seat_generation' IN v_settlement_door) = 0
     OR position('tournament_zero_stack_seat_generations' IN v_settlement_core) = 0
     OR position('post_commit_request_hash' IN v_settlement_door) = 0
     OR (
          length(v_settlement_door)-length(replace(
            v_settlement_door,
            'public.fn_ca_share_settlement_lane_for_table(p_table_id)',
            ''))
        )/length('public.fn_ca_share_settlement_lane_for_table(p_table_id)')<>1
     OR position('pg_advisory_xact_lock_shared' IN v_settlement_door)>0
     OR position('fn_ca_open_tournament_hand_seat_exit_authority'
                 IN v_settlement_wrapper) = 0
     OR position('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority'
                 IN v_settlement_wrapper) = 0
     OR position('fn_ca_close_tournament_seat_exit_authority'
                 IN v_settlement_wrapper) = 0 THEN
    RAISE EXCEPTION
      'Stage-B manager fencing found an unknown composed hand-settlement source';
  END IF;
END;
$require_stage_a_request_authority$;

/* Contract the Stage-A tournament-settlement compatibility door only after the
   exact atomic-batch engine is the sole running build. Stage A deliberately
   kept this public signature behavior-compatible with older engines and kept
   every format completion, certificate and pool-lifecycle trigger disabled.
   The payer and all seven guards contract in this one transaction, so no state can expose one
   strict boundary without the others. */
DO $require_stage_a_tournament_settlement_expand$
DECLARE
  v_source text;
  v_satellite_cash_source text;
  v_satellite_guard_enabled boolean;
  v_guard_enabled boolean;
  v_final_deal_guard_enabled boolean;
  v_finish_claim_guard_enabled boolean;
  v_finish_certificate_guard_enabled boolean;
  v_pool_window_guard_enabled boolean;
  v_pool_freeze_guard_enabled boolean;
BEGIN
  IF to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'
     ) IS NULL
     OR to_regprocedure(
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_tournament_atomic_place_completion_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_guard_atomic_satellite_completion()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_atomic_final_table_deal_completion_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_guard_tournament_completing_claim()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_guard_tournament_completed_certificate()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_tournament_pool_finalization_window_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_freeze_finalized_tournament_prize_pool()'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A expand objects';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
         )
    INTO v_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B contraction over an unknown single-obligation wrapper';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'::regprocedure
         )
    INTO v_satellite_cash_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_satellite_cash_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_satellite_cash_source) > 0 THEN
    RAISE EXCEPTION
      'Stage-B requires the atomic satellite helper to use the private obligation core';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_satellite_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'aaa_guard_atomic_satellite_completion'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A satellite completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_tournaments_atomic_place_completion_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_final_deal_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzzz_tournaments_atomic_final_table_deal_completion_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A final-table-deal completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_finish_claim_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'aa_guard_tournament_completing_claim'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A finish-claim guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_finish_certificate_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzzzz_tournaments_financial_certificate'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A financial-certificate guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_pool_window_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_tournament_pool_finalization_window_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A pool-window guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_pool_freeze_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_freeze_finalized_tournament_prize_pool'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A finalized-pool guard';
  END IF;

  IF position('atomic_batch_required' IN v_source) = 0 THEN
    IF position('FOR UPDATE' IN v_source) > 0
       OR v_satellite_guard_enabled
       OR v_guard_enabled
       OR v_final_deal_guard_enabled
       OR v_finish_claim_guard_enabled
       OR v_finish_certificate_guard_enabled
       OR v_pool_window_guard_enabled
       OR v_pool_freeze_guard_enabled THEN
      RAISE EXCEPTION
        'Stage-A settlement expand objects are not in their compatible state';
    END IF;
  ELSIF position('v_kind' IN v_source) = 0
        OR position('v_atomic_kinds' IN v_source) = 0
        OR position('v_kind = ANY(v_atomic_kinds)' IN v_source) = 0
        OR position('satellite_remainder' IN v_source) = 0
        OR position($needle$'seat'$needle$ IN v_source) = 0
        OR position('FOR UPDATE' IN v_source) > 0
        OR position('v_is_satellite' IN v_source) > 0
        OR NOT v_satellite_guard_enabled
        OR NOT v_guard_enabled
        OR NOT v_final_deal_guard_enabled
        OR NOT v_finish_claim_guard_enabled
        OR NOT v_finish_certificate_guard_enabled
        OR NOT v_pool_window_guard_enabled
        OR NOT v_pool_freeze_guard_enabled THEN
    RAISE EXCEPTION
      'Existing Stage-B settlement contract is incomplete';
  END IF;
END;
$require_stage_a_tournament_settlement_expand$;

/* Retire the raw-table rolling bridge at one explicit writer boundary. Lock
   tables first because the old request obtains that relation before its
   deferred validator locks a protocol-1 lease. NOWAIT makes a concurrent
   legacy insert or wake/receipt writer abort this entire cutover without a
   partial catalog change. The transaction-start ACCESS EXCLUSIVE lease hold
   prevents a heartbeat or a bridge lock from crossing the replacement. */
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_table_origins IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_capacity_table_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_manager_wakes IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $refuse_live_protocol_one_tournament_manager$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.engine_tournament_leases l
     WHERE l.protocol_version = 1
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
  ) THEN
    RAISE EXCEPTION
      'Stage-B cutover refused: a fresh protocol-1 tournament manager still owns a lease';
  END IF;
END;
$refuse_live_protocol_one_tournament_manager$;

/* Stage B preserves every already-committed bridge table as an ordinary
   capacity origin with its canonical receipt. Only the transaction-time
   synthesis is removed; all future capacity paths are receipt-only. */
CREATE OR REPLACE FUNCTION public.trg_validate_tournament_table_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  SELECT t.status::text INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament table origin lost parent tournament %', NEW.tournament_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.origin_kind = 'capacity' THEN
    IF upper(v_parent_status) <> 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED: RUNNING table % must create its canonical capacity receipt in the same transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'launch' THEN
    IF upper(v_parent_status) <> 'REGISTERING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
            AND r.launch_id = NEW.launch_id
            AND r.lease_generation = NEW.launch_lease_generation
            AND r.completed_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: table % does not belong to the exact incomplete launch receipt',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'prelaunch' THEN
    IF upper(v_parent_status) = 'RUNNING'
       OR EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_PRELAUNCH_ORIGIN_STALE: table % crossed a launch boundary in its birth transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'legacy' THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'unknown tournament table origin %', NEW.origin_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)
  RESTRICT;

DO $assert_stage_a_legacy_capacity_bridge_retired$
DECLARE
  v_origin_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_origin_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_validate_tournament_table_origin()'::regprocedure
     AND p.prosecdef;

  IF to_regprocedure(
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'
     ) IS NOT NULL
     OR position('fn_stage_a_bridge_legacy_capacity_receipt'
                 IN v_origin_source) > 0
     OR position('tournament_capacity_table_receipts'
                 IN v_origin_source) = 0
     OR position('TOURNAMENT_CAPACITY_RECEIPT_REQUIRED'
                 IN v_origin_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B capacity validation still has a legacy admission path';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_table_origins o
     WHERE o.origin_kind = 'capacity'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = o.table_id
            AND c.tournament_id = o.tournament_id
       )
  ) THEN
    RAISE EXCEPTION 'Stage-B found a capacity origin without durable receipt provenance';
  END IF;
END;
$assert_stage_a_legacy_capacity_bridge_retired$;

/* Freeze the five ledgers that can reveal an in-flight legacy final-table
   deal before inspecting them. A concurrent writer refuses this attempt;
   holding these locks through COMMIT prevents a new one from crossing between
   the proof and the strict payer/trigger activation. */
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_obligations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_payouts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_batches
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $refuse_inflight_legacy_final_table_deal$
BEGIN
  IF EXISTS (
    SELECT 1
     FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('RUNNING', 'COMPLETING')
       AND (
         EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_batches b
            WHERE b.tournament_id = t.id
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_receipts r
            WHERE r.tournament_id = t.id
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_obligations o
            WHERE o.tournament_id = t.id
              AND o.kind = 'final_table_deal'
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = t.id
              AND p.source = 'final_table_deal'
         )
       )
  ) THEN
    RAISE EXCEPTION
      'an active final-table deal has a batch or payment evidence that cannot replay; drain or resolve it before Stage B';
  END IF;
END;
$refuse_inflight_legacy_final_table_deal$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_atomic_kinds CONSTANT text[] := ARRAY[
    'place', 'late_reg_adjustment', 'bubble_protection',
    'final_table_deal', 'satellite_remainder', 'seat'
  ];
BEGIN
  /* Preserve the private core's canonical validation responses for malformed
     calls and non-structure classes. Every valid structure class is private to
     its complete atomic transaction, regardless of tournament format. */
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR round(COALESCE(p_amount, 0), 2) < 0
     OR v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty',
                       'refund','seat','satellite_remainder',
                       'bubble_protection','final_table_deal',
                       'late_reg_adjustment')
     OR (v_kind IN ('place', 'late_reg_adjustment') AND p_place IS NULL)
     OR NOT (v_kind = ANY(v_atomic_kinds)) THEN
    RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
      p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source,
      p_description, p_adjustment_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', false, 'paid', 0, 'already_paid', 0,
    'refused_reason', 'atomic_batch_required', 'obligation_id', NULL,
    'idempotency_key', NULL,
    'detail', 'prize-pool money, including satellite seats and cash remainder, moves only inside its complete atomic batch');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) IS
  'Strict Stage-B single-obligation payer for non-pool money. Every prize-pool kind, including satellite seats and cash remainder, is refused for every tournament format; only private cores inside complete atomic batch functions may move that money.';

ALTER TABLE public.tournaments
  ENABLE TRIGGER aaa_guard_atomic_satellite_completion;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER aa_guard_tournament_completing_claim;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzzz_tournaments_financial_certificate;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;

/* The stopped-engine precertification boundary immediately before Stage B owns
   the finite Stage-A cohort. This DDL transaction only proves that boundary is
   closed while its seven trigger-enabling locks are held. It never evaluates
   thousands of readiness functions or updates finish receipts under Stage B's
   30-second statement budget. Any candidate aborts the entire cutover. */
DO $require_stage_a_atomic_finishes_precertified$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.status='COMPLETED'
       AND (
         EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
                  WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b
                     WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                     WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_finish_receipts f
          WHERE f.tournament_id=t.id
            AND f.certified_at IS NOT NULL
            AND f.completed_at IS NOT NULL
            AND jsonb_typeof(f.evidence)='object'
       )
  ) THEN
    RAISE EXCEPTION
      'Stage-B requires the stopped-engine atomic finish precertification boundary first'
      USING ERRCODE='check_violation';
  END IF;
END;
$require_stage_a_atomic_finishes_precertified$;

/* The atomic engines are now the only running builds, so retire the complete
   deferred payout-repair graph in this contraction transaction. Stage A left
   these exact RPCs and dispatch routes alive for rolling compatibility with
   older processes. RESTRICT makes an unknown database dependency abort the
   cutover instead of being cascade-dropped. */
DO $retire_applying_rpc_authority$
BEGIN
  IF to_regprocedure('public.fn_tournament_payout_sweep(integer,boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.fn_ca_backpay_guarantee_shortfalls(boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.sp_ca_reconcile_backpaid_events(boolean)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'DELETE FROM public.ca_settle_sources WHERE lower(source) = ANY($1)'
      USING ARRAY[
        'reconcile',
        'fn_tournament_payout_reconcile',
        'fn_pay_backed_payout_shortfalls',
        'fn_ca_backpay_guarantee_shortfalls',
        'fn_tournament_payout_sweep',
        'sp_ca_reconcile_backpaid_events',
        'fn_backpay_hu_winner_shortfalls'
      ]::text[];
  END IF;
END;
$retire_applying_rpc_authority$;

/* A removed RPC must not remain discoverable as a dormant money path. The
   historical payout and alert rows stay intact; only executable and dispatch
   authority is retired. */
DELETE FROM public.ca_money_rpc_registry
 WHERE proname IN (
   'fn_tournament_payout_reconcile',
   'fn_pay_backed_payout_shortfalls',
   'fn_ca_backpay_guarantee_shortfalls',
   'fn_tournament_payout_sweep',
   'sp_ca_reconcile_backpaid_events',
   'fn_backpay_hu_winner_shortfalls'
 );

DO $retire_applying_sweep$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid)
      FROM cron.job j
     WHERE j.jobname = 'ca-payout-sweep-hourly'
        OR j.command ~* '(fn_tournament_payout_sweep|fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)';
  END IF;
END;
$retire_applying_sweep$;

DO $retire_legacy_roster$
BEGIN
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.ca_expected_cron_jobs WHERE jobname = $1'
      USING 'ca-payout-sweep-hourly';
  END IF;
END;
$retire_legacy_roster$;

DROP PROCEDURE IF EXISTS public.sp_ca_reconcile_backpaid_events(boolean) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_tournament_payout_sweep(integer, boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_pay_backed_payout_shortfalls(boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_backpay_hu_winner_shortfalls(integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_tournament_payout_reconcile(uuid, boolean) RESTRICT;

/* These two findings describe failures of the retired applying sweep itself,
   not proof that a player's shortfall was repaired. Every obligation and
   player-money finding stays open. */
UPDATE public.financial_alerts
   SET resolved = true,
       resolved_at = now(),
       resolution =
         'The applying payout repair cron was retired by the Stage-B atomic tournament settlement cutover. This closes only the retired sweep operation and does not close any player-money finding.'
 WHERE resolved IS NOT TRUE
   AND source IN ('fn_tournament_payout_sweep',
                  'fn_tournament_payout_sweep_truncated');

REVOKE ALL ON SCHEMA smarter_private
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  v_stale_seconds constant integer := 30;
  v_manager_exclusive_paths constant text[] := ARRAY[
    'rpc/fn_ack_tournament_capacity_tables',
    'rpc/fn_apply_prize_guarantee',
    'rpc/fn_assign_tournament_player_seat_atomic',
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_bounty_obligation_has_complete_marker',
    'rpc/fn_ca_paid_spin_launch_entitlements',
    'rpc/fn_ca_reprice_unpaid_tournament_place',
    'rpc/fn_ca_tournament_launch_supply_version',
    'rpc/fn_claim_tournament_bounty_elimination',
    'rpc/fn_close_tournament_addon_period',
    'rpc/fn_close_empty_tournament_table',
    'rpc/fn_close_tournament_entry_window',
    'rpc/fn_collect_bounty',
    'rpc/fn_complete_tournament_entry_reprice',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_complete_tournament_terminal_proposal',
    'rpc/fn_begin_tournament_deal_review',
    'rpc/fn_close_tournament_deal_review',
    'rpc/fn_eliminate_tournament_player_atomic',
    'rpc/fn_ensure_late_registration_capacity',
    'rpc/fn_get_tournament_satellite_entitlement_depth',
    'rpc/fn_mystery_bounty_pay',
    'rpc/fn_mystery_bounty_reserve',
    'rpc/fn_mystery_bounty_seed',
    'rpc/fn_move_tournament_player',
    'rpc/fn_open_tournament_rebuy_decisions',
    'rpc/fn_prove_played_spin_launch_recovery',
    'rpc/fn_settle_final_table_deal_atomic',
    'rpc/fn_spin_draw_and_settle_atomic',
    'rpc/fn_spin_draw_multiplier',
    'rpc/fn_spin_settle_game',
    'rpc/fn_sync_tournament_live_seat_chips',
    'rpc/fn_tournament_has_unsettled_bounties'
  ]::text[];
  /* These three routines deliberately serve two identities. An authenticated
     player may reach the routine's existing user/award authorization, while
     a server caller must be one exact protocol-2 tournament manager. Keeping
     this as a disjoint class prevents either the browser exception or the
     manager lease requirement from being widened to generic service_role. */
  v_player_or_manager_paths constant text[] := ARRAY[
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/claim_table_lease_v2',
    'rpc/claim_tournament_lease_v2',
    'rpc/fn_ack_tournament_manager_wakes',
    'rpc/fn_ca_commit_hand_settlement',
    'rpc/fn_ca_process_hand_post_commit_obligations',
    'rpc/fn_certify_tournament_finish',
    'rpc/fn_claim_tournament_finish',
    'rpc/fn_complete_tournament_terminal',
    'rpc/fn_finalize_bounty_pool',
    'rpc/fn_get_tournament_deal_consensus',
    'rpc/fn_mystery_bounty_settle',
    'rpc/fn_normalize_tournament_final_standings',
    'rpc/fn_prepare_tournament_place_obligations',
    'rpc/fn_project_hand_side_effects',
    'rpc/fn_resolve_committed_tournament_seat_move',
    'rpc/fn_resolve_satellite_settlement_outcome',
    'rpc/fn_resolve_tournament_terminal_proposal_outcome',
    'rpc/fn_resolve_tournament_terminal_outcome',
    'rpc/fn_settle_satellite_finish_atomic',
    'rpc/fn_settle_satellite_tournament',
    'rpc/fn_settle_tournament_obligation',
    'rpc/fn_settle_tournament_places_atomic',
    'rpc/fn_settle_tournament_rake',
    'rpc/fn_sweep_pending_tournament_bounties',
    'rpc/fn_sync_seat_first_player_count',
    'rpc/heartbeat_table_leases_v4',
    'rpc/heartbeat_tournament_leases_v4',
    'rpc/release_table_leases_v2',
    'rpc/release_tournament_leases_v2'
  ]::text[];
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* SECURITY DEFINER makes current_user the function owner.  The JWT claims
     supplied and verified by PostgREST are the request identity here. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));
  /* Direct PostgREST reports `rpc/name`; Supabase gateways may retain the
     `rest/v1/` prefix. Normalize both shapes before applying the same exact
     route allowlist. Never use a suffix/substring match for authority. */
  IF left(v_path, 8) = 'rest/v1/' THEN
    v_path := substr(v_path, 9);
  END IF;

  /* Transaction-local settings are reset by PostgreSQL at transaction end,
     but clear the proof explicitly before evaluating this request as a
     fail-closed defence against an incorrectly pooled session. */
  PERFORM set_config('app.smarter_manager_request_fenced', '', true);
  PERFORM set_config('app.smarter_manager_deleted_table_ids', '', true);

  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* This hook is shared by the entire estate. Do not turn the shared
     service-role credential into a Club-Arena-only protocol. Restrict only
     the RPC routes whose authority belongs to the engine. Manager-exclusive
     routes fail when a callback loses its bound manager context; recovery and
     lease-coordination routes accept the explicitly marked service actor too.
     Old/headerless engine binaries can use none of these server paths after
     cutover. */
  IF v_path = ANY(v_player_or_manager_paths)
     AND NOT (
       (v_request_role = 'authenticated' AND v_actor = '')
       OR v_actor = 'tournament-manager'
     ) THEN
    RAISE EXCEPTION
      'PLAYER_OR_MANAGER_AUTHORITY_REQUIRED: RPC requires its authenticated player or exact lease manager'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED: manager RPC requires exact lease authority'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_engine_service_paths)
     AND v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION
      'ENGINE_DATA_AUTHORITY_REQUIRED: engine RPC requires an identified service actor'
      USING ERRCODE = '42501';
  END IF;

  /* Unrelated World Hub/Club Arena service traffic deliberately remains
     compatible when unmarked. Browser traffic keeps its normal unmarked
     shape too. Only the engine-private paths above require identification. */
  IF v_actor = '' THEN
    IF v_request_role = 'service_role' THEN
      PERFORM set_config('app.smarter_data_actor', 'shared-estate-service', true);
    ELSE
      PERFORM set_config('app.smarter_data_actor', 'browser', true);
    END IF;
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     /* Preserve 20260910063559: a manager request must exclude a takeover
        without excluding its own FOR NO KEY UPDATE heartbeat. The takeover
        remains explicit in claim_tournament_lease_v2 as FOR UPDATE. */
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
  /* This marker is written last and only after the exact lease row is held
     FOR KEY SHARE. Row triggers can consume this transaction proof without
     doing the same indexed lease read again for every affected row. */
  PERFORM set_config('app.smarter_manager_request_fenced', 'protocol-2', true);
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() IS
  'Private, non-API Stage-B shared-estate Data API boundary. Unrelated unmarked service_role traffic remains valid; engine-private routes require an identified actor; protocol-2 tournament managers must hold and transaction-lock one exact fresh generation.';

DROP FUNCTION IF EXISTS public.fn_smarter_data_api_pre_request();

/* A marked manager is not merely "some manager".  Every direct row it touches
   must resolve to the same tournament named by the transaction-local request
   proof. The pre-request hook already holds the exact lease FOR KEY SHARE for
   the complete PostgREST transaction. Re-reading that same row once per
   affected row would add hot-path work without strengthening the lock. */
CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_lease_generation uuid;
BEGIN
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED: manager actor is absent'
      USING ERRCODE = '42501';
  END IF;

  IF current_setting('app.smarter_manager_request_fenced', true)
       IS DISTINCT FROM 'protocol-2' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_REQUIRED: request lease proof is absent'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_tournament_id :=
      NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_lease_generation :=
      NULLIF(
        current_setting('app.smarter_tournament_lease_generation', true),
        ''
      )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed authority context'
      USING ERRCODE = '22023';
  END;

  IF p_tournament_id IS NULL
     OR v_tournament_id IS NULL
     OR v_lease_generation IS NULL
     OR p_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: row belongs to another tournament'
      USING ERRCODE = '42501';
  END IF;

END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_tournament_manager_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_deleted_table_ids uuid[];
BEGIN
  /* Shared tables have valid ordinary service writers.  Only the explicitly
     marked manager actor is scoped by this trigger; guessing from relation
     names would reject registration, scheduling, recovery, and cash games. */
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'tables' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT t.tournament_id INTO v_old_tournament_id
        FROM public.tables t
       WHERE t.id = OLD.table_id;
      IF NOT FOUND THEN
        /* An ON DELETE CASCADE seat trigger runs after its parent table tuple
           has become invisible to this statement. The parent's own BEFORE
           DELETE scope trigger already proved the exact tournament. Consume
           that transaction proof only for a nested DELETE; a direct orphan
           mutation still fails closed. */
        BEGIN
          v_deleted_table_ids := COALESCE(
            NULLIF(
              current_setting('app.smarter_manager_deleted_table_ids', true),
              ''
            )::uuid[],
            '{}'::uuid[]
          );
        EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
          v_deleted_table_ids := '{}'::uuid[];
        END;
        IF TG_OP = 'DELETE'
           AND pg_trigger_depth() > 1
           AND OLD.table_id = ANY(v_deleted_table_ids) THEN
          BEGIN
            v_old_tournament_id :=
              NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
          EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
            v_old_tournament_id := NULL;
          END;
          IF v_old_tournament_id IS NULL THEN
            RAISE EXCEPTION
              'TOURNAMENT_MANAGER_SCOPE_VIOLATION: cascaded seat has no parent proof'
              USING ERRCODE = '42501';
          END IF;
        ELSE
          RAISE EXCEPTION
            'TOURNAMENT_MANAGER_SCOPE_VIOLATION: old seat table is missing'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT t.tournament_id INTO v_new_tournament_id
        FROM public.tables t
       WHERE t.id = NEW.table_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'TOURNAMENT_MANAGER_SCOPE_VIOLATION: new seat table is missing'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: unsupported trigger relation'
      USING ERRCODE = '55000';
  END IF;

  IF v_old_tournament_id IS NOT NULL THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_old_tournament_id);
  END IF;
  IF v_new_tournament_id IS NOT NULL
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_new_tournament_id);
  END IF;

  /* A manager must never touch a cash table/seat (NULL tournament_id), nor may
     it turn a tournament table into a cash table. */
  IF (TG_OP <> 'INSERT' AND v_old_tournament_id IS NULL)
     OR (TG_OP <> 'DELETE' AND v_new_tournament_id IS NULL) THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: manager write has no tournament'
      USING ERRCODE = '42501';
  END IF;

  /* The exact parent row has now passed manager scope. Persist its id only
     for this transaction so the subsequent FK ON DELETE CASCADE can prove
     why its parent tuple is no longer visible. This is not a broad nested-
     trigger exemption: the child must name an id admitted here. */
  IF TG_TABLE_NAME = 'tables' AND TG_OP = 'DELETE' THEN
    BEGIN
      v_deleted_table_ids := COALESCE(
        NULLIF(
          current_setting('app.smarter_manager_deleted_table_ids', true),
          ''
        )::uuid[],
        '{}'::uuid[]
      );
    EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
      RAISE EXCEPTION
        'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed deleted-table proof'
        USING ERRCODE = '22023';
    END;
    IF NOT OLD.id = ANY(v_deleted_table_ids) THEN
      v_deleted_table_ids := array_append(v_deleted_table_ids, OLD.id);
    END IF;
    PERFORM set_config(
      'app.smarter_manager_deleted_table_ids',
      v_deleted_table_ids::text,
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_tournament_manager_write_scope()
  FROM PUBLIC, anon, authenticated, service_role;

/* `a0_` is intentional. PostgreSQL runs same-kind triggers alphabetically;
   manager authority must lock the lease before the existing `aa_` launch
   triggers lock receipt/tournament parents. */
DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournaments;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournament_players;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tables;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.table_seats;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

/* No application role may bypass the exact RPCs by editing lease rows. */
REVOKE ALL ON TABLE public.engine_tournament_leases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.engine_table_leases
  FROM PUBLIC, anon, authenticated, service_role;

/* Remove every generation-blind or superseded engine door after the old
   process drain. No CASCADE: an unexpected dependency aborts this cutover. */
DROP FUNCTION IF EXISTS public.claim_tournament_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases_v3(text, jsonb, integer);
DROP FUNCTION IF EXISTS public.release_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
);
DROP FUNCTION IF EXISTS public.fn_complete_tournament_launch_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_table_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v3(text, jsonb, integer);
DROP FUNCTION IF EXISTS public.release_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
);

/* Keep only the exact protocol-2 application doors. */
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_table_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_table_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;


DO $assert_strict_manager_request_fence$
DECLARE
  v_legacy_roster_has_job boolean := false;
  v_authenticator_oid oid;
  v_current_database_oid oid;
  v_canonical_global_hook_settings bigint;
  v_applicable_hook_settings bigint;
  v_hook_source text;
  v_hook_semantic text;
  v_scope_source text;
  v_row_guard_source text;
  v_single_obligation_source text;
  v_satellite_cash_source text;
  v_manager_write_lease_pattern text := $manager_write_lease_pattern$FROM[[:space:]]+public\.engine_tournament_leases[[:space:]]+l[[:space:]]+WHERE[[:space:]]+l\.tournament_id[[:space:]]*=[[:space:]]*v_tournament_id[[:space:]]+AND[[:space:]]+l\.protocol_version[[:space:]]*=[[:space:]]*2[[:space:]]+AND[[:space:]]+l\.lease_generation[[:space:]]*=[[:space:]]*v_lease_generation[[:space:]]+AND[[:space:]]+l\.heartbeat_at[[:space:]]*>=[[:space:]]*clock_timestamp\(\)[[:space:]]*-[[:space:]]*make_interval\(secs[[:space:]]*=>[[:space:]]*v_stale_seconds\)[^;]*FOR[[:space:]]+KEY[[:space:]]+SHARE[[:space:]]*;$manager_write_lease_pattern$;
BEGIN
  SELECT r.oid INTO STRICT v_authenticator_oid
    FROM pg_roles r
   WHERE r.rolname = 'authenticator';
  SELECT d.oid INTO STRICT v_current_database_oid
    FROM pg_database d
   WHERE d.datname = current_database();

  SELECT p.prosrc INTO STRICT v_hook_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;
  v_hook_semantic := regexp_replace(v_hook_source, '/\*.*?\*/', ' ', 'gs');
  SELECT p.prosrc INTO STRICT v_scope_source
    FROM pg_proc p
   WHERE p.oid =
         'public.fn_assert_tournament_manager_write_scope(uuid)'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_row_guard_source
    FROM pg_proc p
   WHERE p.oid =
         'public.trg_tournament_manager_write_scope()'::regprocedure
     AND p.prosecdef;
  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
         )
    INTO STRICT v_single_obligation_source;
  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'::regprocedure
         )
    INTO STRICT v_satellite_cash_source;

  IF position('PLAYER_OR_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('v_player_or_manager_paths' IN v_hook_source) = 0
     OR position('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('ENGINE_DATA_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position($needle$'shared-estate-service'$needle$ IN v_hook_source) = 0
     OR position($needle$'browser'$needle$ IN v_hook_source) = 0
     OR v_hook_semantic !~ v_manager_write_lease_pattern
     OR v_hook_semantic ~
          'engine_tournament_leases[[:space:]]+l[[:space:]][^;]*FOR[[:space:]]+SHARE[[:space:]]*;'
     OR position('l.lease_generation = v_lease_generation' IN v_hook_source) = 0
     OR position('app.smarter_manager_request_fenced' IN v_hook_source) = 0
     OR position('auth.role()' IN v_hook_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_hook_source) = 0
     OR position($needle$'rpc/fn_project_hand_side_effects'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_move_tournament_player'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_complete_tournament_terminal_proposal'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_begin_tournament_deal_review'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_close_tournament_deal_review'$needle$ IN v_hook_source) = 0
     OR position($needle$left(v_path, 8) = 'rest/v1/'$needle$ IN v_hook_source) = 0
     OR position($needle$'protocol-2'$needle$ IN v_scope_source) = 0
     OR position('p_tournament_id IS DISTINCT FROM v_tournament_id' IN v_scope_source) = 0
     OR position('app.smarter_manager_deleted_table_ids' IN v_row_guard_source) = 0
     OR position('OLD.table_id = ANY(v_deleted_table_ids)' IN v_row_guard_source) = 0
     OR position('pg_trigger_depth() > 1' IN v_row_guard_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B route authority or manager row scope is incomplete';
  END IF;

  IF position('v_kind' IN v_single_obligation_source) = 0
     OR position('v_atomic_kinds' IN v_single_obligation_source) = 0
     OR position('v_kind = ANY(v_atomic_kinds)'
                 IN v_single_obligation_source) = 0
     OR position('FOR UPDATE' IN v_single_obligation_source) > 0
     OR position('v_is_satellite' IN v_single_obligation_source) > 0
     OR position('late_reg_adjustment' IN v_single_obligation_source) = 0
     OR position('bubble_protection' IN v_single_obligation_source) = 0
     OR position('final_table_deal' IN v_single_obligation_source) = 0
     OR position('satellite_remainder' IN v_single_obligation_source) = 0
     OR position($needle$'seat'$needle$ IN v_single_obligation_source) = 0
     OR position('atomic_batch_required' IN v_single_obligation_source) = 0
     OR position('fn_settle_tournament_obligation_before_atomic_batch_gate('
                 IN v_single_obligation_source) = 0
     OR has_function_privilege(
          'anon',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        )
     OR NOT has_function_privilege(
          'service_role',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'Stage-B single-obligation settlement boundary is not strict';
  END IF;

  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_satellite_cash_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_satellite_cash_source) > 0 THEN
    RAISE EXCEPTION 'Stage-B atomic satellite payer does not use its private core';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname IN (
         'aaa_guard_atomic_satellite_completion',
         'aa_guard_tournament_completing_claim',
         'zzzz_tournaments_atomic_place_completion_guard',
         'zzzzz_tournaments_atomic_final_table_deal_completion_guard',
         'zzzzzz_tournaments_financial_certificate',
         'zzzz_tournament_pool_finalization_window_guard',
         'zzzz_freeze_finalized_tournament_prize_pool'
       )
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  ) <> 7 THEN
    RAISE EXCEPTION 'Stage-B finish, certificate or pool-lifecycle guard is not enabled';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'fn_tournament_payout_reconcile',
         'fn_pay_backed_payout_shortfalls',
         'fn_ca_backpay_guarantee_shortfalls',
         'fn_tournament_payout_sweep',
         'sp_ca_reconcile_backpaid_events',
         'fn_backpay_hu_winner_shortfalls'
       )
  ) THEN
    RAISE EXCEPTION 'a deferred tournament payout reconciliation routine remains installed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.ca_money_rpc_registry
     WHERE proname IN (
       'fn_tournament_payout_reconcile',
       'fn_pay_backed_payout_shortfalls',
       'fn_ca_backpay_guarantee_shortfalls',
       'fn_tournament_payout_sweep',
       'sp_ca_reconcile_backpaid_events',
       'fn_backpay_hu_winner_shortfalls'
     )
  ) THEN
    RAISE EXCEPTION 'a retired tournament payout reconciliation route remains registered';
  END IF;

  /* Keep cron.job in a statement reached only when the cron extension exists. PostgreSQL
     resolves relations while preparing a statement, so a combined boolean
     expression still breaks a development database without that extension. */
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-payout-sweep-hourly') THEN
      RAISE EXCEPTION 'the applying payout repair cron is still scheduled';
    END IF;
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE active
         AND command ~* '(fn_tournament_payout_sweep|fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)'
    ) THEN
      RAISE EXCEPTION 'a deferred tournament payout reconciliation command is still scheduled';
    END IF;
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_settle_sources WHERE lower(source) = ANY($1))'
      INTO v_legacy_roster_has_job
      USING ARRAY[
        'reconcile',
        'fn_tournament_payout_reconcile',
        'fn_pay_backed_payout_shortfalls',
        'fn_ca_backpay_guarantee_shortfalls',
        'fn_tournament_payout_sweep',
        'sp_ca_reconcile_backpaid_events',
        'fn_backpay_hu_winner_shortfalls'
      ]::text[];
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'retired reconcile sources can still settle obligations directly';
    END IF;
  END IF;
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_expected_cron_jobs WHERE jobname = $1)'
      INTO v_legacy_roster_has_job
      USING 'ca-payout-sweep-hourly';
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'the retired payout repair cron is still in the expected roster';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_alerts
     WHERE resolved IS NOT TRUE
       AND source IN ('fn_tournament_payout_sweep',
                      'fn_tournament_payout_sweep_truncated')
  ) THEN
    RAISE EXCEPTION 'a retired applying payout sweep finding is still open';
  END IF;

  IF to_regprocedure('public.claim_tournament_lease(uuid,text,text,integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v2(text,uuid[],integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v3(text,jsonb,integer)')
       IS NOT NULL
     OR to_regprocedure('public.release_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
        ) IS NOT NULL
     OR to_regprocedure('public.claim_table_lease(uuid,text,text,integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v2(text,uuid[],integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v3(text,jsonb,integer)')
        IS NOT NULL
     OR to_regprocedure('public.release_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'A legacy or superseded tournament/table authority door survived Stage B';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_tournament_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit tournament leases outside exact RPCs';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_table_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit table leases outside exact RPCs';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.heartbeat_table_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.heartbeat_table_leases_v4(text,jsonb,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Exact engine RPC grants or private settlement-core ACL are wrong';
  END IF;

  IF (SELECT count(*)
        FROM pg_trigger t
       WHERE t.tgname = 'a0_tournament_manager_write_scope'
         AND t.tgrelid IN (
           'public.tournaments'::regclass,
           'public.tournament_players'::regclass,
           'public.tables'::regclass,
           'public.table_seats'::regclass
         )
         AND NOT t.tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'Every manager-owned row family is not scope guarded';
  END IF;

  /* PostgREST reads settings for its login role in this database. Require the
     one intentional role-wide hook and refuse a database-wide or
     role-in-database value that could override it for this API instance. Rows
     for another database or login role are not applicable here. */
  SELECT
    count(*) FILTER (
      WHERE s.setdatabase = 0
        AND s.setrole = v_authenticator_oid
        AND setting.value =
            'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
    ),
    count(*)
    INTO v_canonical_global_hook_settings, v_applicable_hook_settings
    FROM pg_db_role_setting s
    CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) setting(value)
   WHERE s.setdatabase IN (0, v_current_database_oid)
     AND s.setrole IN (0, v_authenticator_oid)
     AND setting.value LIKE 'pgrst.db_pre_request=%';

  IF v_canonical_global_hook_settings <> 1
     OR v_applicable_hook_settings <> 1 THEN
    RAISE EXCEPTION
      'PostgREST strict request hook settings are not exact (canonical global %, applicable %)',
      v_canonical_global_hook_settings,
      v_applicable_hook_settings;
  END IF;

  IF to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'Strict request hook remains callable from the exposed public schema';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'anon',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_schema_privilege('service_role', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('anon', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'smarter_private', 'USAGE')
     OR has_schema_privilege('service_role', 'smarter_private', 'CREATE')
     OR has_schema_privilege('anon', 'smarter_private', 'CREATE')
     OR has_schema_privilege('authenticated', 'smarter_private', 'CREATE')
     OR has_function_privilege(
       'authenticator',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(p.proacl) acl
        WHERE p.oid =
              'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(n.nspacl) acl
        WHERE n.nspname = 'smarter_private'
          AND acl.grantee = 0
          AND acl.privilege_type IN ('USAGE', 'CREATE')
     ) THEN
    RAISE EXCEPTION 'Private strict request hook ACL is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
      CROSS JOIN LATERAL regexp_split_to_table(
        split_part(setting.value, '=', 2),
        '[[:space:]]*,[[:space:]]*'
      ) AS exposed(schema_name)
     WHERE s.setdatabase IN (0, v_current_database_oid)
       AND s.setrole IN (0, v_authenticator_oid)
       AND setting.value LIKE 'pgrst.db_schemas=%'
       AND exposed.schema_name = 'smarter_private'
  ) THEN
    RAISE EXCEPTION 'smarter_private must not be a PostgREST exposed schema';
  END IF;
END;
$assert_strict_manager_request_fence$;

COMMENT ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid) IS
  'Private Stage-B row-scope proof. A manager write must consume the transaction marker set only after the request hook locks its exact fresh protocol-2 lease, then name that same tournament and generation.';
COMMENT ON FUNCTION public.trg_tournament_manager_write_scope() IS
  'Scopes marked tournament-manager writes on tournaments, tournament_players, tables and table_seats to the transaction authority established by the Data API request hook.';

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';


/*
 * ROLLBACK ORDER (emergency forward migration, never an ad-hoc production
 * toggle): restore the Stage-A hook first; restore only the legacy tournament
 * overloads from the tournament-lease generation migration, table overloads
 * and superseded nine- and eleven-argument settlement from the table-lease
 * generation migration if an old engine is being deliberately reintroduced;
 * keep the obligations-aware twelve-argument core; then remove the four a0_
 * triggers and the two private scope functions.
 * Reopening any superseded engine door without also restoring Stage-A
 * compatibility is an invalid mixed protocol. Normal rollback is a new
 * audited migration.
 */

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: EXACT HAND SEAT GENERATION
-- ===========================================================================
-- 20260910002540_hand_settlement_requires_exact_seat_generation
--
-- STRICT CONTRACT AFTER THE ROLLING EXPANSION
-- -------------------------------------------
-- 20260908161534 taught the accepted-hand functions to settle the immutable
-- `(table_seats.id, table_seats.joined_at)` generation while temporarily
-- retaining all-legacy payloads for a zero-downtime engine rollout. The later
-- Stage-B authority cutover 20260910002530 removes the old 9- and 11-argument
-- RPC doors, but its surviving 12-argument RPC and seven-argument stack core
-- can still receive a generation-blind JSON roster. That compatibility path
-- can target whichever active row happens to exist after a leave/rejoin.
--
-- This is the contract half of expand/contract. Apply it only after:
--
--   1. 20260908161534 is installed;
--   2. the exact engine is the sole live engine and old requests have drained;
--   3. 20260910002530 has removed both old hand-commit signatures.
--
-- A later terminal-receipt migration was applied after the expansion from an
-- older source snapshot and replaced both functions, losing the exact-seat
-- selectors while adding atomic terminal receipts and zero-stack tournament
-- close. Production then restored the rolling exact-seat expansion over those
-- receipt-aware bodies. Production migration 20260910054712 subsequently
-- folded each hand's time-bank state into the same exact stack-row write. This
-- current-postimage contraction recognizes only those measured 54712 catalog
-- bodies. The obsolete generation-blind and pre-one-write ancestries do not
-- converge to the same strict implementation and are rejected rather than
-- retained as speculative compatibility paths.
-- The seat-exit authority prerequisite renamed the measured implementation to
-- fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority and installed an
-- owner-only capability wrapper at the public name. This contraction edits
-- the preserved private core in place; replacing the wrapper would silently
-- remove zero-stack seat-exit authority. The exact path retains every receipt,
-- lifecycle, lock-order and
-- zero-seat behavior while removing the compatibility fallback.
--
-- Every nonempty stack and time-bank item must then name a valid seat_id plus
-- seat_joined_at. Stack selection/write and time-bank write have no user-only
-- active-row fallback. A different-chair rejoin cannot be selected. A reused
-- same-chair row has a different joined_at and is refused whole. Exact departed
-- cash settlement still uses only the historical row's club; departed
-- tournament settlement remains fail closed.
--
-- The direct seven-argument stack function is an implementation core, not a
-- runtime RPC. No production caller needs it, and exposing it to service_role
-- bypasses the exact table lease, atomic hand history, projection outbox and
-- post-commit envelope. This cutover makes it owner-only. The 12-argument RPC
-- remains the only service_role settlement door.
--
-- No cron, retry, repair sweep, reconciliation write, data rewrite or runtime
-- flag is introduced. Exact source hashes and one-hit substitutions abort on
-- drift. CREATE OR REPLACE preserves function owner/identity. Rollback is a new
-- forward migration after a deliberately redeployed legacy-compatible engine;
-- do not reopen a generation-blind door during an ordinary application rollback.


-- The global realtime boundary has been held since transaction start.

DO $strict_contract$
DECLARE
  v_inner text;
  v_inner_source text;
  v_outer text;
  v_outer_source text;
  v_anchors text[];
  v_replacements text[];
  v_expected_hits integer[];
  v_hits integer;
  v_i integer;
  v_inner_strict boolean;
  v_outer_strict boolean;
BEGIN
  IF to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
     ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
        ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'strict exact-seat contraction requires both expanded settlement functions';
  END IF;

  -- These are the rolling public doors retired by 20260910002530. Refuse an
  -- out-of-order contraction rather than breaking a still-draining engine.
  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'strict exact-seat contraction requires Stage-B legacy hand doors retired';
  END IF;

  SELECT pg_get_functiondef(p.oid),p.prosrc
    INTO v_inner,v_inner_source
    FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  SELECT pg_get_functiondef(p.oid),p.prosrc
    INTO v_outer,v_outer_source
    FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;

  v_inner_strict :=
    position('Exact seat generation is required for every hand settlement participant' in v_inner) > 0
    AND position('v_exact_seat_generation' in v_inner) = 0;
  v_outer_strict :=
    position('exact_stack_seat_generation_required' in v_outer) > 0
    AND position('exact_time_bank_seat_generation_required' in v_outer) > 0
    AND position('v_exact_seat_generation' in v_outer) = 0;

  IF v_inner_strict IS DISTINCT FROM v_outer_strict THEN
    RAISE EXCEPTION 'strict exact-seat contraction is partially installed';
  END IF;

  IF v_inner_strict THEN
    IF md5(v_inner) <> '9d1376a2b2e13e4dc1d25025b2d2e403'
       OR md5(v_inner_source) <> '3c2d594f08f52a66436f9a766947a1f1'
       OR md5(v_outer) <> '242f8a9d3ad57dac46cd8aa5b395b430'
       OR md5(v_outer_source) <> '9a3e7fccb42d396b4004b45672634e4f' THEN
      RAISE EXCEPTION 'strict exact-seat settlement source changed after cutover';
    END IF;
    RAISE NOTICE 'strict exact seat-generation settlement is already installed';
  ELSE
    IF has_function_privilege(
         'anon',
         'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'authenticated',
         'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'service_role',
         'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'anon',
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'authenticated',
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
         'EXECUTE'
       )
       OR NOT has_function_privilege(
         'service_role',
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
         'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'receipt-aware settlement ACL changed before strict contraction';
    END IF;

    /* Production migration 20260910054712 composed the one-seat-write
       time-bank envelope over the rolling exact-seat, receipt-aware bodies.
       Contract that byte-exact catalog source directly; do not replay or
       discard Diamond dispatch, hand history/receipts, custody, terminal
       receipts, zero-stack behavior, or the time-bank envelope. */
    IF md5(v_inner) = '2c5f04ae307d38f187b8b72a3f557738'
       AND md5(v_inner_source) = 'e67e89b3aec325f8038e0507a1511eec'
       AND md5(v_outer) = 'a1738adaf943656868e68a7bf7ce8d1e'
       AND md5(v_outer_source) = '0ef3c57a6a31acc383ce4b95a0f9519f' THEN
      v_anchors := ARRAY[
      $old$  v_exact_seat_generation boolean;
$old$,
      $old$  -- Rolling expansion accepts either a wholly legacy roster or a wholly exact
  -- roster. One-sided and mixed generations can otherwise create a request
  -- whose hash says one thing while individual rows are selected another way.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_stacks) x
     WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
        OR CASE WHEN x ? 'seat_id'
                THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                ELSE false END
        OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                THEN (x->>'seat_id') !~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                ELSE false END
        OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                THEN NOT pg_input_is_valid(
                  x->>'seat_joined_at', 'timestamp with time zone'
                )
                ELSE false END
  ) THEN
    RAISE EXCEPTION 'Invalid hand settlement seat generation'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
    RAISE EXCEPTION 'Mixed legacy and exact hand settlement seat generations'
      USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
    INTO v_exact_seat_generation
    FROM jsonb_array_elements(p_stacks) x;
$old$,
      $old$      || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', (x->>'seat_id')::uuid,
              'seat_joined_at', x->>'seat_joined_at')
              ELSE '{}'::jsonb END
$old$,
      $old$      v_exact_seat_id := NULL;
      v_exact_seat_joined_at := NULL;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      IF v_exact_seat_generation THEN
        v_exact_seat_id := (e->>'seat_id')::uuid;
        v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
        SELECT ts.stack, ts.left_at, ts.club_id
          INTO v_old, v_exact_seat_left_at, v_exact_seat_club
          FROM public.table_seats ts
         WHERE ts.id = v_exact_seat_id
           AND ts.joined_at = v_exact_seat_joined_at
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
         FOR UPDATE;
      ELSE
        SELECT ts.stack INTO v_old FROM public.table_seats ts
         WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
         FOR UPDATE;
      END IF;
      v_exact_seat_found := FOUND;
      IF NOT v_exact_seat_found
         OR (v_exact_seat_generation AND v_exact_seat_left_at IS NOT NULL) THEN
        -- If the exact row id was reused in place, joined_at no longer matches.
        -- There is no historical row left to settle, so fail the hand whole.
        IF v_exact_seat_generation AND NOT v_exact_seat_found THEN
          RAISE EXCEPTION
            'exact seat generation missing or replaced for % - hand write rejected whole',
            v_uid;
        END IF;
$old$,
      $old$          IF v_exact_seat_generation THEN
            -- Use the club captured on the exact departed generation. Looking
            -- up the latest departed row can cross a later rejoin or club move.
            v_dep_club := v_exact_seat_club;
          ELSE
            SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
             WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
             ORDER BY ts.left_at DESC LIMIT 1;
          END IF;
$old$,
      $old$          IF v_dep_club IS NULL AND NOT v_exact_seat_generation THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
$old$,
      $old$            ) || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            ) ELSE '{}'::jsonb END
$old$,
      $old$         AND (v_tb_env->>'exact')::boolean IS NOT DISTINCT FROM v_exact_seat_generation
$old$,
      $old$                   AND (NOT v_exact_seat_generation OR (
                     (i.value->>'seat_id') ~*
                       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     AND pg_input_is_valid(i.value->>'seat_joined_at',
                                           'timestamp with time zone'))) AS ok
$old$,
      $old$      IF v_tb IS NOT NULL AND v_exact_seat_generation
         AND ((v_tb->>'seat_id')::uuid IS DISTINCT FROM (e->>'seat_id')::uuid
              OR (v_tb->>'seat_joined_at')::timestamptz
                   IS DISTINCT FROM (e->>'seat_joined_at')::timestamptz) THEN
$old$,
      $old$      IF v_exact_seat_generation THEN
        IF v_tb IS NOT NULL THEN
          UPDATE public.table_seats ts
             SET stack = v_target,
                 time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
                 time_bank_remaining = (v_tb->>'seconds_remaining')::integer
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL;
        ELSE
          UPDATE public.table_seats ts SET stack = v_target
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL;
        END IF;
      ELSE
        IF v_tb IS NOT NULL THEN
          UPDATE public.table_seats ts
             SET stack = v_target,
                 time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
                 time_bank_remaining = (v_tb->>'seconds_remaining')::integer
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
        ELSE
          UPDATE public.table_seats ts SET stack = v_target
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
        END IF;
      END IF;
$old$,
      $old$             AND (
               (v_exact_seat_generation
                 AND ts.id = (e->>'seat_id')::uuid
                 AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
                 AND ts.left_at IS NULL)
               OR (NOT v_exact_seat_generation AND ts.left_at IS NULL)
             )
$old$
      ];
      v_replacements := ARRAY[
      ''::text,
      $new$  -- Exact seat generation is required for every hand settlement participant.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_stacks) x
     WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
        OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
        OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                THEN (x->>'seat_id') !~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                ELSE true END
        OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                THEN NOT pg_input_is_valid(
                  x->>'seat_joined_at', 'timestamp with time zone'
                )
                ELSE true END
  ) THEN
    RAISE EXCEPTION 'Exact hand settlement seat generation is required'
      USING ERRCODE = '22023';
  END IF;
$new$,
      $new$      || jsonb_build_object(
           'seat_id', (x->>'seat_id')::uuid,
           'seat_joined_at', x->>'seat_joined_at')
$new$,
      $new$      v_exact_seat_id := (e->>'seat_id')::uuid;
      v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      SELECT ts.stack, ts.left_at, ts.club_id
        INTO v_old, v_exact_seat_left_at, v_exact_seat_club
        FROM public.table_seats ts
       WHERE ts.id = v_exact_seat_id
         AND ts.joined_at = v_exact_seat_joined_at
         AND ts.table_id = p_table_id
         AND ts.user_id = v_uid
       FOR UPDATE;
      v_exact_seat_found := FOUND;
      IF NOT v_exact_seat_found THEN
        -- A row id can be reused in place. A changed joined_at is not the seat
        -- this hand dealt, and no current active seat is an acceptable fallback.
        RAISE EXCEPTION
          'exact seat generation missing or replaced for % - hand write rejected whole',
          v_uid;
      END IF;
      IF v_exact_seat_left_at IS NOT NULL THEN
$new$,
      $new$          -- Use the club captured on the exact departed generation. Looking
          -- up the latest departed row can cross a later rejoin or club move.
          v_dep_club := v_exact_seat_club;
$new$,
      ''::text,
      $new$            ) || jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            )
$new$,
      $new$         AND (v_tb_env->>'exact')::boolean IS TRUE
$new$,
      $new$                   AND (i.value->>'seat_id') ~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   AND pg_input_is_valid(i.value->>'seat_joined_at',
                                         'timestamp with time zone') AS ok
$new$,
      $new$      IF v_tb IS NOT NULL
         AND ((v_tb->>'seat_id')::uuid IS DISTINCT FROM (e->>'seat_id')::uuid
              OR (v_tb->>'seat_joined_at')::timestamptz
                   IS DISTINCT FROM (e->>'seat_joined_at')::timestamptz) THEN
$new$,
      $new$      IF v_tb IS NOT NULL THEN
        UPDATE public.table_seats ts
           SET stack = v_target,
               time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
               time_bank_remaining = (v_tb->>'seconds_remaining')::integer
         WHERE ts.id = (e->>'seat_id')::uuid
           AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
           AND ts.left_at IS NULL;
      ELSE
        UPDATE public.table_seats ts SET stack = v_target
         WHERE ts.id = (e->>'seat_id')::uuid
           AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
           AND ts.left_at IS NULL;
      END IF;
$new$,
      $new$             AND ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.left_at IS NULL
$new$
      ];
      FOR v_i IN 1..array_length(v_anchors, 1) LOOP
        v_hits := (length(v_inner) - length(replace(v_inner, v_anchors[v_i], '')))
                  / length(v_anchors[v_i]);
        IF v_hits <> 1 THEN
          RAISE EXCEPTION 'restored exact inner anchor % expected once, found %',
            v_i, v_hits;
        END IF;
        v_inner := replace(v_inner, v_anchors[v_i], v_replacements[v_i]);
      END LOOP;
      IF md5(v_inner) <> '9d1376a2b2e13e4dc1d25025b2d2e403'
         OR position('v_exact_seat_generation' in v_inner) > 0
         OR position('Exact seat generation is required for every hand settlement participant'
                     in v_inner) = 0
         OR position('tournament_zero_stack_seat_generations' in v_inner) = 0 THEN
        RAISE EXCEPTION 'restored exact inner contraction produced an unknown source';
      END IF;
      EXECUTE v_inner;
      SELECT p.prosrc INTO STRICT v_inner_source
        FROM pg_proc p
       WHERE p.oid=
        'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
      IF md5(v_inner_source) <> '3c2d594f08f52a66436f9a766947a1f1' THEN
        RAISE EXCEPTION
          'strict exact inner contraction produced an unknown catalog body';
      END IF;

      v_anchors := ARRAY[
      $old$  v_exact_seat_generation boolean := false;
$old$,
      $old$  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;
$old$,
      $old$      'exact', v_exact_seat_generation,
$old$,
      $old$      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
$old$,
      $old$      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );$old$,
      $old$      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;$old$
      ];
      v_replacements := ARRAY[
      ''::text,
      $new$  -- Strict exact-engine contract. Every nonempty narrative names one
  -- immutable seat generation; no active-row lookup is a legal substitute.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
          OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
          OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE true END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE true END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (exact_stack_seat_generation_required)';
    END IF;
  END IF;

  IF jsonb_array_length(p_post_commit_obligations->'time_banks') > 0
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
        WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
           OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
           OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
           OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                   THEN (x->>'seat_id') !~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   ELSE true END
           OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                   THEN NOT pg_input_is_valid(
                     x->>'seat_joined_at', 'timestamp with time zone'
                   )
                   ELSE true END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (exact_time_bank_seat_generation_required)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
          AND s->>'seat_id' = x->>'seat_id'
          AND (s->>'seat_joined_at')::timestamptz =
              (x->>'seat_joined_at')::timestamptz
     )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (time_bank_seat_generation_mismatch)';
  END IF;
$new$,
      $new$      'exact', true,
$new$,
      $new$      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND s.id = (v_item->>'seat_id')::uuid
         AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz;
$new$,
      $new$      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.id = (v_item->>'seat_id')::uuid
         AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz
         AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         );$new$,
      $new$      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK. Count a verified exact
         departed generation as a lawful no-op, and count an active exact row
         whose requested values already match when the redundant-update guard
         suppressed the physical UPDATE. A missing or reused generation still
         refuses the whole accepted hand. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.id = (v_item->>'seat_id')::uuid
           AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz
           AND (
             s.left_at IS NOT NULL
             OR (
               s.time_bank_uses_remaining =
                 (v_item->>'uses_remaining')::integer
               AND s.time_bank_remaining =
                 (v_item->>'seconds_remaining')::integer
             )
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;$new$
      ];
      v_expected_hits := ARRAY[1, 1, 1, 1, 1, 1];
      FOR v_i IN 1..array_length(v_anchors, 1) LOOP
        v_hits := (length(v_outer) - length(replace(v_outer, v_anchors[v_i], '')))
                  / length(v_anchors[v_i]);
        IF v_hits <> v_expected_hits[v_i] THEN
          RAISE EXCEPTION
            'restored exact outer anchor % expected % occurrence(s), found %',
            v_i, v_expected_hits[v_i], v_hits;
        END IF;
        v_outer := replace(v_outer, v_anchors[v_i], v_replacements[v_i]);
      END LOOP;
      IF md5(v_outer) <> '242f8a9d3ad57dac46cd8aa5b395b430'
         OR position('v_exact_seat_generation' in v_outer) > 0
         OR position('exact_stack_seat_generation_required' in v_outer) = 0
         OR position('exact_time_bank_seat_generation_required' in v_outer) = 0
         OR position('post_commit_request_hash' in v_outer) = 0
         OR position('tournament_zero_stack_seat_generations' in v_outer) = 0
         OR position('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK' in v_outer) = 0 THEN
        RAISE EXCEPTION 'restored exact outer contraction produced an unknown source';
      END IF;
      EXECUTE v_outer;
      SELECT p.prosrc INTO STRICT v_outer_source
        FROM pg_proc p
       WHERE p.oid=
        'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
      IF md5(v_outer_source) <> '9a3e7fccb42d396b4004b45672634e4f' THEN
        RAISE EXCEPTION
          'strict exact outer contraction produced an unknown catalog body';
      END IF;
    ELSE
      RAISE EXCEPTION
        'strict exact-seat contraction requires the measured 20260910054712 production postimage';
    END IF;
  END IF;
END;
$strict_contract$;

-- The inner writer is an owner-only implementation detail after contraction.
REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(
  uuid, bigint, jsonb, numeric, numeric, text, numeric
) FROM PUBLIC, anon, authenticated, service_role;

DO $postconditions$
DECLARE
  v_inner text;
  v_inner_source text;
  v_outer text;
  v_outer_source text;
  v_wrapper text;
BEGIN
  SELECT pg_get_functiondef(p.oid),p.prosrc
    INTO STRICT v_inner,v_inner_source
    FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  SELECT pg_get_functiondef(p.oid),p.prosrc
    INTO STRICT v_outer,v_outer_source
    FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
  SELECT p.prosrc
    INTO STRICT v_wrapper
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
     AND p.prosecdef;

  IF position('Exact seat generation is required for every hand settlement participant'
              in v_inner) = 0
     OR md5(v_inner) <> '9d1376a2b2e13e4dc1d25025b2d2e403'
     OR md5(v_inner_source) <> '3c2d594f08f52a66436f9a766947a1f1'
     OR position('v_exact_seat_generation' in v_inner) > 0
     OR position('ts.id = v_exact_seat_id' in v_inner) = 0
     OR position('ts.joined_at = v_exact_seat_joined_at' in v_inner) = 0
     OR position('v_dep_club := v_exact_seat_club' in v_inner) = 0
     OR position('public.fn_poker_diamond_settle_cash_hand(' in v_inner) = 0
     OR position('app.ca_hand_time_banks' in v_inner) = 0
     OR position('(v_tb_env->>''exact'')::boolean IS TRUE' in v_inner) = 0
     OR position('time_bank_uses_remaining = (v_tb->>''uses_remaining'')::integer'
                 in v_inner) = 0
     OR position('time_bank_remaining = (v_tb->>''seconds_remaining'')::integer'
                 in v_inner) = 0
     OR position('tournament_zero_stack_seat_generations' in v_inner) = 0
     OR position('ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL'
                 in v_inner) > 0 THEN
    RAISE EXCEPTION
      'strict exact-seat stack postconditions failed (inner md5 %, outer md5 %)',
      md5(v_inner),md5(v_outer);
  END IF;
  IF position('exact_stack_seat_generation_required' in v_outer) = 0
     OR md5(v_outer) <> '242f8a9d3ad57dac46cd8aa5b395b430'
     OR md5(v_outer_source) <> '9a3e7fccb42d396b4004b45672634e4f'
     OR position('exact_time_bank_seat_generation_required' in v_outer) = 0
     OR position('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK' in v_outer) = 0
     OR position('''exact'', true' in v_outer) = 0
     OR position('v_diamond boolean := false' in v_outer) = 0
     OR position('diamond_chip_obligation_or_fractional_fact' in v_outer) = 0
     OR position('(v_result->>''history_id'')::uuid' in v_outer) = 0
     OR position('public.hand_atomic_commits' in v_outer) = 0
     OR position('post_commit_request_hash' in v_outer) = 0
     OR position('post_commit_payload_hash' in v_outer) = 0
     OR (
          length(v_outer)-length(replace(
            v_outer,
            'public.fn_ca_share_settlement_lane_for_table(p_table_id)',
            ''))
        )/length('public.fn_ca_share_settlement_lane_for_table(p_table_id)')<>1
     OR position('pg_advisory_xact_lock_shared' in v_outer)>0
     OR position('v_exact_seat_generation' in v_outer) > 0
     OR position('s.id = (v_item->>''seat_id'')::uuid' in v_outer) = 0
     OR position('s.joined_at = (v_item->>''seat_joined_at'')::timestamptz' in v_outer) = 0
     OR position('app.ca_hand_time_banks' in v_outer) = 0
     OR position('SELECT count(*)::integer INTO v_row_count' in v_outer) = 0
     OR position('IF v_row_count = 0 THEN' in v_outer) = 0 THEN
    RAISE EXCEPTION 'strict exact-seat time-bank postconditions failed (source md5 %)',
      md5(v_outer);
  END IF;

  IF md5(v_wrapper) <> '9d6a12c82aa260c22e1c013e95faca0e'
     OR position('fn_ca_open_tournament_hand_seat_exit_authority'
                 in v_wrapper)=0
     OR position('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority'
                 in v_wrapper)=0
     OR position('fn_ca_close_tournament_seat_exit_authority'
                 in v_wrapper)=0 THEN
    RAISE EXCEPTION
      'accepted-hand seat-exit wrapper changed during strict contraction';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'a rolling hand-commit door survived strict exact-seat contraction';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'strict settlement function ACL is wrong';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
     WHERE p.oid =
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'the direct stack implementation core is not owner-only';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
     WHERE p.oid =
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'the accepted-hand seat-exit wrapper is not owner-only';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
     WHERE p.oid =
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee NOT IN (
         p.proowner,
         (SELECT oid FROM pg_roles WHERE rolname = 'service_role')
       )
  ) THEN
    RAISE EXCEPTION 'the exact hand RPC has an unexpected executor';
  END IF;
END;
$postconditions$;

/* The API cache must forget both removed overloads in the same release
   boundary that commits their catalog deletion. */
NOTIFY pgrst, 'reload schema';

-- ===========================================================================
-- FORWARD-COMPOSED BOUNDARY: ATOMIC TOURNAMENT SEAT MOVE
-- ===========================================================================
-- 20260910002550_tournament_seat_moves_are_one_atomic_receipt
--
-- Tournament seat movement has one canonical mutation authority:
-- public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text).
-- The predecessor migration installs that writer, its one-use seat-exit
-- capability, and its immutable request receipt. An earlier Stage-B draft
-- introduced a second, unwired *_atomic writer with an incompatible receipt
-- schema. Two service-callable writers are not redundancy; they are split
-- authority. This contraction removes those draft overloads, preserves the
-- destination-pointer uniqueness guard, and proves the runtime writer and the
-- lease-loss resolver are the only surviving move surfaces.



-- The global realtime boundary has been held since transaction start.

DO $require_canonical_move_authority$
BEGIN
  IF to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Canonical tournament move writer, receipt, or read-only resolver is missing';
  END IF;
END;
$require_canonical_move_authority$;

-- Retire every signature from the abandoned Stage-B draft. No CASCADE: an
-- unexpected dependency is evidence of a real second caller and must stop the
-- cutover rather than be silently removed.
DROP FUNCTION IF EXISTS public.fn_move_tournament_player_atomic(
  uuid,uuid,uuid,uuid,integer,uuid,timestamptz,integer,uuid,integer
);
DROP FUNCTION IF EXISTS public.fn_move_tournament_player_atomic(
  uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer
);

-- The six-argument legacy writer predates durable request identity.
DROP FUNCTION IF EXISTS public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid
);

-- One active roster pointer may name one destination chair. Historical
-- eliminated/winner coordinates remain testimony and are intentionally
-- outside this partial uniqueness guard.
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_tournament_players_one_active_destination_pointer
  ON public.tournament_players (tournament_id,table_id,seat_number)
  WHERE status IN ('registered','playing')
    AND table_id IS NOT NULL
    AND seat_number IS NOT NULL;

DO $prove_one_tournament_move_authority$
DECLARE
  v_writer_source text;
  v_writer_config text[];
  v_resolver_source text;
  v_receipt_shape text[];
  v_move_function_count integer;
BEGIN
  SELECT p.prosrc,p.proconfig
    INTO STRICT v_writer_source,v_writer_config
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'::regprocedure
     AND p.prosecdef;

  SELECT p.prosrc
    INTO STRICT v_resolver_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure
     AND p.prosecdef;

  SELECT count(*)::integer
    INTO v_move_function_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('fn_move_tournament_player',
                       'fn_move_tournament_player_atomic');

  SELECT array_agg(
           a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||
           CASE WHEN a.attnotnull THEN 'not-null' ELSE 'nullable' END
           ORDER BY a.attnum)
    INTO v_receipt_shape
    FROM pg_attribute a
   WHERE a.attrelid='public.tournament_seat_move_receipts'::regclass
     AND a.attnum>0 AND NOT a.attisdropped;

  IF v_move_function_count<>1
     OR to_regprocedure(
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,integer,uuid,integer)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Tournament move mutation authority is not singular';
  END IF;

  IF v_receipt_shape IS DISTINCT FROM ARRAY[
       'request_id:uuid:not-null',
       'tournament_id:uuid:not-null',
       'user_id:uuid:not-null',
       'source_table_id:uuid:not-null',
       'destination_table_id:uuid:not-null',
       'source_seat_id:uuid:not-null',
       'destination_seat_id:uuid:not-null',
       'source_seat_number:integer:not-null',
       'destination_seat_number:integer:not-null',
       'source_mode:text:not-null',
       'stack:numeric:not-null',
       'moved_at:timestamp with time zone:not-null'
     ]::text[] THEN
    RAISE EXCEPTION
      'Canonical tournament move receipt schema drifted: %',v_receipt_shape;
  END IF;

  IF NOT COALESCE(v_writer_config,'{}'::text[])
       @> ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
     OR position('fn_caller_is_engine()' IN v_writer_source)=0
     OR position(
          'fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'
          IN v_writer_source)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_writer_source)>0
     OR position('table_cap:' IN v_writer_source)=0
     OR position('fn_ca_tournament_seat_move_receipt(p_request_id)'
                 IN v_writer_source)=0
     OR position('tournament move requires exactly one live source seat'
                 IN v_writer_source)=0
     OR position('v_source.stack-v_tp.chips::numeric' IN v_writer_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority'
                 IN v_writer_source)=0
     OR position($needle$SET stack=0,left_at=v_moved_at$needle$
                 IN v_writer_source)=0
     OR position('SET table_id=p_destination_table_id'
                 IN v_writer_source)=0
     OR position('SET current_players=(' IN v_writer_source)=0
     OR position('INSERT INTO public.tournament_seat_move_receipts'
                 IN v_writer_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority(v_token,true)'
                 IN v_writer_source)=0 THEN
    RAISE EXCEPTION
      'Canonical tournament move writer lost a lock, chip, seat, roster, or receipt invariant';
  END IF;

  IF position('app.smarter_data_actor' IN v_resolver_source)=0
     OR position(
          'fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'
          IN v_resolver_source)=0
     OR position('ca:tournament-terminal-settlement:v1'
                 IN v_resolver_source)>0
     OR position('fn_ca_tournament_seat_move_receipt(p_request_id)'
                 IN v_resolver_source)=0
     OR v_resolver_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M' THEN
    RAISE EXCEPTION
      'Tournament move lease-loss resolver is not receipt-only';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','DELETE') THEN
    RAISE EXCEPTION
      'Tournament move writer, resolver, or receipt ACL is not exact';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_class c
        WHERE c.oid='public.tournament_seat_move_receipts'::regclass
          AND c.relrowsecurity)
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgrelid='public.tournament_seat_move_receipts'::regclass
          AND t.tgname='tournament_seat_move_receipts_append_only'
          AND NOT t.tgisinternal
          AND t.tgenabled='O')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_class index_relation
         JOIN pg_namespace index_namespace
           ON index_namespace.oid=index_relation.relnamespace
         JOIN pg_index index_catalog
           ON index_catalog.indexrelid=index_relation.oid
        WHERE index_namespace.nspname='public'
          AND index_relation.relname=
                'idx_tournament_players_one_active_destination_pointer'
          AND index_catalog.indrelid='public.tournament_players'::regclass
          AND index_catalog.indisunique
          AND index_catalog.indisvalid
          AND index_catalog.indisready
          AND ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(index_catalog.indkey)
                       WITH ORDINALITY AS key_column(attnum,position)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid=index_catalog.indrelid
                   AND attribute.attnum=key_column.attnum
                 ORDER BY key_column.position)
              =ARRAY['tournament_id','table_id','seat_number']::text[]
          AND pg_get_expr(
                index_catalog.indpred,index_catalog.indrelid,true)
              ='(status = ANY (ARRAY[''registered''::text, ''playing''::text])) AND table_id IS NOT NULL AND seat_number IS NOT NULL') THEN
    RAISE EXCEPTION
      'Tournament move receipt immutability or active destination uniqueness is missing';
  END IF;
END;
$prove_one_tournament_move_authority$;

NOTIFY pgrst, 'reload schema';

-- The historical chain above is deliberately forward-composed over the current
-- production postimage. Prove that the later live fixes survived byte-for-byte
-- and that the intentionally retained eliminator is dormant rather than a
-- scheduled reconciliation path.
DO $verify_current_postimage_contraction$
DECLARE
  v_bad integer;
  v_unplanned text;
BEGIN
  SELECT count(*)::integer INTO v_bad
    FROM (
      VALUES
        ('public.trg_lock_and_validate_tournament_live_seat()'::regprocedure,
         '27e86e2b51bb6cfb17c13569c8870f10'::text),
        /* 20260910054638: retain the current trusted-auth-admin maintenance
           boundary body, not 034411's earlier pre-auth-admin postimage. */
        ('public.fn_active_maintenance_release_boundary()'::regprocedure,
         '66f0ca0e4ebf27a74dd4b7c211c4fd0f'::text),
        ('public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)'::regprocedure,
         '16a587f7567336fe4379135f22e3fb41'::text),
        /* 20260910072322: retain the knockout-door ownership predicate
           composed over 10002804's felt-first eliminator body. */
        ('public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)'::regprocedure,
         '05855868cb0cbb1199049b5e0e97aa56'::text),
        ('public.fn_concurrent_game_load(uuid,uuid,uuid,uuid)'::regprocedure,
         '4ecd7a690da622a1d18eaec13206e5a5'::text),
        ('public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)'::regprocedure,
         '216b09a2aaf0c60559538ad7caecfbae'::text),
        ('public.fn_tournament_club_for_user(uuid,uuid,uuid)'::regprocedure,
         'f80eff4c311820670f1b71d15c29452d'::text),
        ('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure,
         '8b8cf19c75a21fb898f559ac5d73f422'::text),
        ('public.fn_ca_lock_settlement_lane_global()'::regprocedure,
         '343015440ea5c84ee4ca7ae583c73d30'::text),
        ('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure,
         '3acb4c1d763181905cf5b64287f8f28f'::text),
        ('public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure,
         '006d78a441e65d000d1d78929649bb44'::text),
        /* 20260910063559: takeover remains explicit and heartbeat source stays
           byte-identical while the request hook is composed below. */
        ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
         'd1b5100c2b9f92bec5fd1680b0b4f230'::text),
        ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure,
         '5e6c99545e07c21efcb50e5cb3441c14'::text),
        /* 20260910064701: the tournament hand/close fences are already
           heartbeat-compatible. The cash hand and add-on table fences remain
           the two authenticated inputs for #6. */
        ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
         '457ad8f1e1528ad205f7bd43488f3e14'::text),
        ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'::regprocedure,
         '8ab94f005d1dcc695c7094eec3fd279d'::text),
        ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)'::regprocedure,
         '4abef1a7ccd6d56c2523fe6cb02396b6'::text)
    ) expected(function_oid,source_md5)
    JOIN pg_proc p ON p.oid=expected.function_oid
   WHERE md5(p.prosrc) IS DISTINCT FROM expected.source_md5;
  IF v_bad<>0 THEN
    RAISE EXCEPTION
      'Stage-B contraction overwrote % current production function postimages',
      v_bad USING ERRCODE='55000';
  END IF;

  -- Every runtime authority replaced by this boundary must still enter the
  -- scoped lane exactly once. A direct G-only acquisition no longer excludes
  -- accepted hands after 20260910035435 and is therefore never an acceptable
  -- compatibility fallback.
  SELECT string_agg(expected.function_oid::text,', '
                    ORDER BY expected.function_oid::text)
    INTO v_unplanned
    FROM (
      VALUES
        ('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'::text),
        ('public.fn_spin_expire_unfilled(integer)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_global()'::text),
        ('public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_global()'::text),
        ('public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_global()'::text),
        ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_global()'::text),
        ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure,
         'public.fn_ca_lock_settlement_lane_global()'::text),
        ('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
         'public.fn_ca_share_settlement_lane_for_table(p_table_id)'::text),
        ('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure,
         'public.fn_ca_share_settlement_lane_for_table(p_table_id)'::text)
    ) expected(function_oid,needle)
    JOIN pg_proc p ON p.oid=expected.function_oid
   WHERE (
           length(p.prosrc)-length(replace(p.prosrc,expected.needle,''))
         )/length(expected.needle)<>1
      OR p.prosrc LIKE '%PERFORM pg_advisory_xact_lock(%ca:tournament-terminal-settlement:v1%'
      OR p.prosrc LIKE '%PERFORM pg_advisory_xact_lock_shared(%ca:tournament-terminal-settlement:v1%';
  IF v_unplanned IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage-B runtime functions lost their scoped settlement lane: %',
      v_unplanned USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure
          AND md5(p.prosrc)='f00ad0e9a08496d96f6375cbf6f30678'
          AND octet_length(p.prosrc)=2279
          AND (
                length(p.prosrc)-length(replace(
                  p.prosrc,'PERFORM pg_advisory_xact_lock_shared(',''))
              )/length('PERFORM pg_advisory_xact_lock_shared(')=2
          AND position(
            'fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'
            IN p.prosrc)=0) THEN
    RAISE EXCEPTION
      'tournament move resolver lost its exact shared per-tournament wait'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)'::regprocedure
          AND md5(p.prosrc)='0f491a45693fcf3182719647c5ed7aee'
          AND octet_length(p.prosrc)=1739
          AND (
                length(p.prosrc)-length(replace(
                  p.prosrc,'public.fn_ca_lock_settlement_lane_global()',''))
              )/length('public.fn_ca_lock_settlement_lane_global()')=0
          AND (
                length(p.prosrc)-length(replace(
                  p.prosrc,
                  'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)',
                  ''))
              )/length(
                  'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)')=1
          AND p.prosrc NOT LIKE
            '%p_operation IN (''cancel'',''satellite_finish'',''terminal_finish'')%') THEN
    RAISE EXCEPTION 'per-tournament seat-exit lane dispatch drifted'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)'::regprocedure
          AND (
                length(p.prosrc)-length(replace(
                  p.prosrc,
                  'public.fn_settle_satellite_tournament_pre_money_path_gate(',
                  ''))
              )/length(
                  'public.fn_settle_satellite_tournament_pre_money_path_gate(')=1
          AND position('fn_ca_lock_settlement_lane_global' IN p.prosrc)=0) THEN
    RAISE EXCEPTION 'satellite seat-exit core lost its global-lane money core'
      USING ERRCODE='55000';
  END IF;

  SELECT string_agg(p.oid::regprocedure::text,', '
                    ORDER BY p.oid::regprocedure::text)
    INTO v_unplanned
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prosrc LIKE '%PERFORM pg_advisory_xact_lock(%'
     AND p.prosrc LIKE '%ca:tournament-terminal-settlement:v1%'
     AND p.oid NOT IN (
       'public.fn_ca_lock_settlement_lane_global()'::regprocedure,
       'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure,
       'public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure,
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure);
  IF v_unplanned IS NOT NULL THEN
    RAISE EXCEPTION 'unscoped direct settlement-lane takers survived: %',
      v_unplanned USING ERRCODE='55000';
  END IF;

  IF (SELECT count(*) FROM public.tournament_mutator_scheduler_retirement_receipts
       WHERE migration_version=
         '20260910042112_stage_b_current_postimage_contraction')<>1 THEN
    RAISE EXCEPTION 'scheduler retirement lacks its unique immutable receipt';
  END IF;

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobname IN (
       'ca-eliminate-absent-players','ca-release-broke-seats')
        OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
        OR j.command ILIKE '%fn_ca_release_broke_seats%'
  ) THEN
    RAISE EXCEPTION 'retired tournament mutation schedule survived';
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'felt-aware eliminator is not owner-only';
  END IF;

  IF to_regclass('public.idx_cash_seat_moves_cancelled_player') IS NULL
     OR to_regclass('public.idx_tables_cluster_open') IS NULL
     OR to_regclass('public.idx_tables_cluster_closed_status_drift') IS NULL
     OR to_regclass('public.idx_tournaments_updated_at') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname='public'
          AND p.tablename='tournaments'
          AND p.policyname='poker_arena_tournament_access'
          AND p.roles=ARRAY['authenticated']::name[]
          AND p.qual=
            '(((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN ( SELECT c.id' ||
            E'\n   FROM clubs c' ||
            E'\n  WHERE fn_poker_can_read_games(c.id))))'
     ) THEN
    RAISE EXCEPTION '20260910034411 policy/index postimage was not preserved';
  END IF;

  IF public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'maintenance entry freeze expired before Stage-B commit'
      USING ERRCODE='55006';
  END IF;
END;
$verify_current_postimage_contraction$;

DO $prove_move_receipt_preimage_preserved$
DECLARE
  v_expected_count bigint;
  v_expected_fingerprint text;
  v_current_count bigint;
  v_current_fingerprint text;
BEGIN
  SELECT p.receipt_count,p.receipt_fingerprint
    INTO STRICT v_expected_count,v_expected_fingerprint
    FROM pg_temp.stage_b_contraction_move_receipt_preimage p;
  SELECT count(*)::bigint,
         encode(extensions.digest(COALESCE(
           string_agg(
             encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex'),''
             ORDER BY r.request_id),''
         ),'sha256'),'hex')
    INTO v_current_count,v_current_fingerprint
    FROM public.tournament_seat_move_receipts r;
  IF v_current_count IS DISTINCT FROM v_expected_count
     OR v_current_fingerprint IS DISTINCT FROM v_expected_fingerprint
     OR EXISTS (SELECT 1 FROM public.tournament_seat_exit_authorizations) THEN
    RAISE EXCEPTION
      'Stage-B contraction changed an immutable seat-move receipt preimage'
      USING ERRCODE='55000';
  END IF;
END;
$prove_move_receipt_preimage_preserved$;

-- The already-deployed occupancy adoption retired every unbound application
-- cashout. Prove this broad historical composition preserved both the exact
-- Diamond-aware primitive body and the one service-callable occupancy door.
DO $verify_cashout_occupancy_authority_preserved$
DECLARE
  v_core oid:=to_regprocedure(
    'public.atomic_seat_cashout_locked_pre_tournament_guard(uuid,uuid,integer,text)');
  v_wrapper oid:=to_regprocedure(
    'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)');
  v_occupancy oid:=to_regprocedure(
    'public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)');
  v_postgres oid:='postgres'::regrole;
  v_service_role oid:='service_role'::regrole;
BEGIN
  IF v_core IS NULL OR v_wrapper IS NULL OR v_occupancy IS NULL THEN
    RAISE EXCEPTION
      'Stage-B cashout composition lost the primitive or occupancy service door';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=v_core
          AND md5(p.prosrc)='f0e1b852a56808d39a48e3a27603333d'
          AND p.proowner=v_postgres AND p.prosecdef AND NOT p.proretset
          AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=4 AND p.pronargdefaults=2
          AND p.proconfig=ARRAY[
            'search_path=public, pg_temp','statement_timeout=30s']::text[]
          AND position('public.fn_poker_diamond_cashout(' IN p.prosrc)>0
          AND position('cashout:occupancy:' IN p.prosrc)>0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=v_wrapper
          AND md5(p.prosrc)='08924758c5e10e72c38dba11d7d4c758'
          AND p.proowner=v_postgres AND p.prosecdef AND NOT p.proretset
          AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=4 AND p.pronargdefaults=2
          AND p.proconfig=ARRAY[
            'search_path=public, pg_temp','statement_timeout=30s']::text[]
          AND position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
                       IN p.prosrc)>0
          AND position('atomic_seat_cashout_locked_pre_tournament_guard'
                       IN p.prosrc)>0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=v_occupancy
          AND md5(p.prosrc)='1f7683406ca4d3d0ddce0e92ee8ef5e6'
          AND p.proowner=v_postgres AND p.prosecdef AND NOT p.proretset
          AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=5 AND p.pronargdefaults=1
          AND p.proconfig=ARRAY[
            'search_path=public, pg_temp','statement_timeout=30s']::text[]
          AND position('CASHOUT_OCCUPANCY_REQUIRED' IN p.prosrc)>0
          AND position('public.atomic_seat_cashout_locked(' IN p.prosrc)>0) THEN
    RAISE EXCEPTION
      'Stage-B cashout composition changed an exact cashout body or catalog contract';
  END IF;

  IF EXISTS (
       SELECT 1 FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid IN (v_core,v_wrapper)
        GROUP BY p.oid,p.proowner
       HAVING count(*) FILTER (WHERE a.privilege_type='EXECUTE')<>1
          OR count(*) FILTER (
               WHERE a.privilege_type='EXECUTE'
                 AND a.grantor=p.proowner AND a.grantee=p.proowner
                 AND NOT a.is_grantable)<>1)
     OR EXISTS (
       SELECT 1 FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_occupancy
        GROUP BY p.oid,p.proowner
       HAVING count(*) FILTER (WHERE a.privilege_type='EXECUTE')<>2
          OR count(*) FILTER (
               WHERE a.privilege_type='EXECUTE'
                 AND a.grantor=p.proowner AND a.grantee=p.proowner
                 AND NOT a.is_grantable)<>1
          OR count(*) FILTER (
               WHERE a.privilege_type='EXECUTE'
                 AND a.grantor=p.proowner AND a.grantee=v_service_role
                 AND NOT a.is_grantable)<>1) THEN
    RAISE EXCEPTION
      'Stage-B cashout composition reopened an unbound cashout or lost the occupancy service door';
  END IF;
END;
$verify_cashout_occupancy_authority_preserved$;

COMMENT ON FUNCTION public.fn_ca_eliminate_absent_tournament_players(
  integer,integer,boolean) IS
  'Owner-only felt-aware forensic implementation retained for exact production postimage parity. No API grant, scheduler, detector, or runtime caller exists.';

DO $verify_stage_b_171924_mutable_sources_carried$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure(
          'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)')
          AND md5(p.prosrc)='16ea7acbbf76613a0a1193dff18f1330'
          AND octet_length(p.prosrc)=32778)
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure(
          'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)')
          AND md5(p.prosrc)='b4937067d9bf337e1466095b9e1d5424'
          AND octet_length(p.prosrc)=7848)
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure(
          'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)')
          AND md5(p.prosrc)='ebabbaf0456d80335aaa2e04471d0ab6'
          AND octet_length(p.prosrc)=21367)
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure(
          'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)')
          AND md5(p.prosrc)='2c21c56c6a9d4a2f8ee79082bd4fef57'
          AND octet_length(p.prosrc)=12717) THEN
    RAISE EXCEPTION
      'Stage-B failed to carry an exact 171924 mutable implementation source'
      USING ERRCODE='55000';
  END IF;
END;
$verify_stage_b_171924_mutable_sources_carried$;

SELECT pg_temp.assert_stage_b_phase_three_125453_postimage();
SELECT pg_temp.assert_stage_b_current_live_tail_174349_postimage();

COMMIT;
