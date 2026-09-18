-- HELD CURRENT SOURCE / UNRUN. Not an activation instruction.
-- Current finish lane and accounting successors are preserved exactly.
-- The mixed legacy path takes G/B before current finish/seat authority;
-- ordinary modern and sealed replay retain the existing narrow finish lane.
-- Depends on the separately guarded evidence and receipt-lane components.
-- Only the canonical terminal wrapper may dispatch mixed-basis admission.
-- The immutable seal asserts CURRENT retained evidence, never historical
-- immutability or original RNG. Original sequences and places are retained.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
DECLARE required record; actual jsonb;
BEGIN
  IF current_user<>'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR to_regclass('public.ca_spin_mixed_dispatch_v1') IS NOT NULL
     OR to_regclass('public.ca_spin_mixed_basis_v1') IS NOT NULL
     OR to_regclass('public.ca_spin_mixed_completion_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'mixed terminal candidate authority/object preimage differs' USING ERRCODE='55000';
  END IF;
  FOR required IN SELECT * FROM (VALUES
    ('public.fn_settle_tournament_places(uuid,uuid)','c412c8b17186976df139f73a706175f2'),
    ('public.fn_ca_lock_settlement_lane_for_finish(uuid)','76e4c6b5291bab20f0cfc65dd060022b'),
    ('public.fn_ca_settlement_lane_doctrine()','8dd361600c8facb1cbb99b3df853e5b9'),
    ('public.fn_accounting_tournament_terminal_fee_receipt(uuid)','6e446f6d6d19ec8b28b31d124a8c6ac3'),
    ('public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)','d5339cec8b0e00be748c4c15bc3dba83'),
    ('public.fn_complete_tournament_terminal(uuid,uuid,text)','c64e049911fd99c1d784cdb042ca714b'),
    ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','6a45fe9bf30c94f9366ec88f0863087e'),
    ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)','787eb9a718a648ac29753dfc9234f4c3'),
    ('public.fn_ca_share_settlement_lane_for_table(uuid)','409b14ee72ce888d3b26524c52d49a68'),
    ('public.fn_ca_lock_settlement_lane_global()','7c759bb7a639c3124de2607bdbf12577'),
    ('public.settle_hand_atomically(uuid,uuid,jsonb)','64abd1e3234fdabc655647bfb1ad5018'),
    ('public.fn_ca_refund_entitlement_commit_valid()','b2b04340bf3e8c493a67f5b71e75c77f')
  ) pins(signature,full_definition_md5) LOOP
    IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
         WHERE p.oid=to_regprocedure(required.signature)) IS DISTINCT FROM required.full_definition_md5 THEN
      RAISE EXCEPTION 'mixed terminal prerequisite differs: %',required.signature USING ERRCODE='55000';
    END IF;
  END LOOP;
  -- Exact owner/ACL/config are part of the prerequisite, not just body pins.
  FOR required IN SELECT value AS pin FROM jsonb_array_elements($authority$[{"signature":"fn_settle_tournament_places(uuid,uuid)","owner":"postgres","security_definer":true,"config":["search_path=public","statement_timeout=30s"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"c412c8b17186976df139f73a706175f2"},{"signature":"fn_complete_tournament_terminal(uuid,uuid,text)","owner":"postgres","security_definer":true,"config":["search_path=public, pg_temp","statement_timeout=45s"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"c64e049911fd99c1d784cdb042ca714b"},{"signature":"fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)","owner":"postgres","security_definer":true,"config":["search_path=public","statement_timeout=45s"],"acl":"{postgres=X/postgres}","volatility":"v","full_definition_md5":"6a45fe9bf30c94f9366ec88f0863087e"},{"signature":"fn_ca_tournament_terminal_receipt(uuid,uuid)","owner":"postgres","security_definer":true,"config":["search_path=public","statement_timeout=30s"],"acl":"{postgres=X/postgres}","volatility":"s","full_definition_md5":"787eb9a718a648ac29753dfc9234f4c3"},{"signature":"fn_ca_share_settlement_lane_for_table(uuid)","owner":"postgres","security_definer":false,"config":["search_path=public, pg_temp"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"409b14ee72ce888d3b26524c52d49a68"},{"signature":"fn_ca_lock_settlement_lane_global()","owner":"postgres","security_definer":false,"config":["search_path=public, pg_temp"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"7c759bb7a639c3124de2607bdbf12577"},{"signature":"fn_ca_refund_entitlement_commit_valid()","owner":"postgres","security_definer":true,"config":["search_path=public"],"acl":"{postgres=X/postgres}","volatility":"v","full_definition_md5":"b2b04340bf3e8c493a67f5b71e75c77f"},{"signature":"fn_ca_process_hand_post_commit_obligations(uuid)","owner":"postgres","security_definer":true,"config":["search_path=public, extensions, pg_temp"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"8d18dde12765610895b25e297a1f403f"},{"signature":"fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","owner":"postgres","security_definer":true,"config":["search_path=public, extensions, pg_temp"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"8c0acda3b19e958ecd5bbbc07c845afe"},{"signature":"fn_ca_lock_settlement_lane_for_finish(uuid)","owner":"postgres","security_definer":false,"config":["search_path=public, pg_temp"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v","full_definition_md5":"76e4c6b5291bab20f0cfc65dd060022b"},{"signature":"fn_ca_settlement_lane_doctrine()","owner":"postgres","security_definer":true,"config":["search_path=public, pg_temp"],"acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"s","full_definition_md5":"8dd361600c8facb1cbb99b3df853e5b9"},{"signature":"fn_accounting_tournament_terminal_fee_receipt(uuid)","owner":"postgres","security_definer":true,"config":["search_path=public"],"acl":"{postgres=X/postgres}","volatility":"s","full_definition_md5":"6e446f6d6d19ec8b28b31d124a8c6ac3"},{"signature":"fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)","owner":"postgres","security_definer":true,"config":["search_path=public"],"acl":"{postgres=X/postgres}","volatility":"v","full_definition_md5":"d5339cec8b0e00be748c4c15bc3dba83"}]$authority$::jsonb) LOOP
    SELECT jsonb_build_object('signature',required.pin->>'signature','owner',pg_get_userbyid(p.proowner),
      'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text,
      'volatility',p.provolatile::text,'full_definition_md5',md5(pg_get_functiondef(p.oid))) INTO actual
      FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(required.pin->>'signature'));
    IF actual IS DISTINCT FROM required.pin THEN
      RAISE EXCEPTION 'mixed terminal authority differs: %',required.pin->>'signature' USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_serialize_legacy_settlement_receipt_statement()')
       AND p.proowner='postgres'::regrole AND NOT p.prosecdef
       AND md5(p.prosrc)='534850c97847e72075044d8604b0a09d'
       AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
       AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>'postgres'::regrole)) THEN
    RAISE EXCEPTION 'mixed terminal lane handler authority differs' USING ERRCODE='55000';
  END IF;
  IF to_regprocedure('public.fn_ca_spin_mixed_history_shape_v1(jsonb)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid='public.settlement_idempotency_keys'::regclass
         AND t.tgname='aa_serialize_legacy_settlement_receipt_statement'
         AND t.tgenabled='O' AND t.tgtype=62 AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'mixed terminal evidence/receipt barrier missing' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_accepted_tournament_settlement_fact(jsonb)')
      AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='i'
      AND md5(p.prosrc)='0be7ce46c91572336ee97c80e827428d'
      AND (SELECT array_agg(lower(v) ORDER BY n) FROM unnest(p.proconfig) WITH ORDINALITY c(v,n))=ARRAY['search_path=pg_catalog, public, pg_temp','timezone=utc']
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>'postgres'::regrole)) THEN
    RAISE EXCEPTION 'mixed terminal private evidence authority differs: fn_ca_accepted_tournament_settlement_fact(jsonb)' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_spin_mixed_history_shape_v1(jsonb)')
      AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='i'
      AND md5(p.prosrc)='a3ad6ecd2de90c3a4ab2a2a361b9b9da'
      AND (SELECT array_agg(lower(v) ORDER BY n) FROM unnest(p.proconfig) WITH ORDINALITY c(v,n))=ARRAY['search_path=pg_catalog, public, pg_temp','timezone=utc']
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>'postgres'::regrole)) THEN
    RAISE EXCEPTION 'mixed terminal private evidence authority differs: fn_ca_spin_mixed_history_shape_v1(jsonb)' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_spin_mixed_retained_reserve_key_v1(uuid,text,text)')
        AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.provolatile='i'
        AND md5(p.prosrc)='057cf3d695142e81ee11378eed07be1c'
        AND p.proconfig=ARRAY['search_path=pg_catalog']
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>'postgres'::regrole)) THEN
    RAISE EXCEPTION 'mixed retained key predicate authority differs' USING ERRCODE='55000';
  END IF;
  FOR required IN SELECT * FROM (VALUES
    ('tournaments'),('tables'),('tournament_players'),('table_seats'),('hand_history'),
    ('hand_atomic_commits'),('settlement_idempotency_keys'),('tournament_knockout_candidates'),
    ('tournament_refund_entitlements'),('entry_purchase_idempotency_receipts'),('tournament_escrow'),
    ('chip_ledger'),('wallet_transactions'),('spin_draw_receipts'),('spin_reserve_ledger'),
    ('tournament_launch_receipts'),('tournament_entry_close_receipts')
  ) rels(name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.'||required.name)
      AND c.relkind='r' AND c.relowner='postgres'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'mixed terminal source relation authority differs: %',required.name USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_table_privilege('service_role','public.hand_atomic_commits','INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role','public.tournament_knockout_candidates','INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role','public.tournament_refund_entitlements','INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role','public.entry_purchase_idempotency_receipts','INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'mixed terminal canonical source mutation grants differ' USING ERRCODE='55000';
  END IF;
END;
$guard$;

DO $lane_dependency$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
      WHERE p.oid='public.settle_hand_atomically(uuid,uuid,jsonb)'::regprocedure)
      IS DISTINCT FROM '64abd1e3234fdabc655647bfb1ad5018'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid='public.settlement_idempotency_keys'::regclass
         AND t.tgname='aa_serialize_legacy_settlement_receipt_statement'
         AND t.tgenabled='O' AND t.tgtype=62 AND NOT t.tgisinternal
         AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
         AND t.tgqual IS NULL AND t.tgattr::text='')
     OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
           AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure)<>3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.hand_history'::regclass
           AND t.tgname='a00_spin_mixed_history_insert_lane' AND t.tgenabled='O' AND t.tgtype=6
           AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
           AND t.tgqual IS NULL AND t.tgnargs=0 AND NOT t.tgdeferrable AND t.tgattr::text='')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.hand_history'::regclass
           AND t.tgname='a00_spin_mixed_history_identity_update_lane' AND t.tgenabled='O' AND t.tgtype=18
           AND t.tgfoid='public.fn_ca_serialize_legacy_settlement_receipt_statement()'::regprocedure
           AND t.tgqual IS NULL AND t.tgnargs=0 AND NOT t.tgdeferrable
           AND (SELECT array_agg(a.attname::text ORDER BY x.n)
                FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(attnum,n)
                JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.attnum)
               =ARRAY['id','table_id','tournament_id','hand_number','players'])
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid='public.sp_compact_hand_history(integer,integer,integer)'::regprocedure)
          IS DISTINCT FROM '36a41aa4447e199ec8a9f2a5aa1840ec' THEN
    RAISE EXCEPTION 'mixed terminal lane dependency differs' USING ERRCODE='55000';
  END IF;
END;
$lane_dependency$;

DO $accounting_authority$
DECLARE expected jsonb; actual jsonb;
BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($pins$[{"signature":"fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"security_definer":true,"volatility":"s","full_md5":"e56aa8c8280c59e2f0406ea6c504dc4e"},{"signature":"fn_accounting_tournament_fee_fingerprint(rake_records)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"security_definer":false,"volatility":"i","full_md5":"dd55cceba87b1578472171e1c80ba1fb"},{"signature":"fn_settle_tournament_rake(uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=30s"],"security_definer":true,"volatility":"v","full_md5":"0492f5a78bc3c84d54c24fd45549a0be"},{"signature":"fn_union_week_start(timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"security_definer":false,"volatility":"i","full_md5":"103f192a228084dad0e4268c36c82c4b"},{"signature":"fn_accounting_tournament_fee_net_plan(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"security_definer":true,"volatility":"s","full_md5":"d8231a3f9219ecacb5ae68ee3aebe435"},{"signature":"fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"security_definer":true,"volatility":"v","full_md5":"195878da781227b47753a28dbc7bc978"}]$pins$::jsonb) LOOP
  SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(p.proowner),
   'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,'volatility',p.provolatile::text,
   'full_md5',md5(pg_get_functiondef(p.oid))) INTO actual FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.'||(expected->>'signature'));
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'mixed current accounting authority differs: %',expected->>'signature' USING ERRCODE='55000'; END IF;
 END LOOP;
END $accounting_authority$;

-- A receipt is immutable across callers. timestamptz JSON serialization must
-- not depend on the caller's TimeZone; all underlying financial checks remain.
DO $receipt_timezone$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure))<>'787eb9a718a648ac29753dfc9234f4c3' THEN
  RAISE EXCEPTION 'mixed canonical receipt preimage differs' USING ERRCODE='55000'; END IF;
 ALTER FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) SET timezone TO 'UTC';
 IF md5(pg_get_functiondef('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure))<>'4c2278cdd30130a938ef79705b10504b' THEN
  RAISE EXCEPTION 'mixed canonical receipt timezone postimage differs' USING ERRCODE='55000'; END IF;
END $receipt_timezone$;

CREATE TABLE public.ca_spin_mixed_dispatch_v1 (
  tournament_id uuid PRIMARY KEY,
  transaction_id bigint NOT NULL,
  winner_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode='places')
);
CREATE TABLE public.ca_spin_mixed_basis_v1 (
  tournament_id uuid PRIMARY KEY,
  winner_id uuid NOT NULL,
  admitted_transaction_id bigint NOT NULL,
  admitted_at timestamptz NOT NULL,
  policy text NOT NULL CHECK (policy='current-retained-mixed-spin-v1'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  shape jsonb NOT NULL CHECK (shape->'shape_ok'='true'::jsonb),
  paid_evidence jsonb NOT NULL CHECK (jsonb_typeof(paid_evidence)='object')
);
CREATE TABLE public.ca_spin_mixed_completion_v1 (
  tournament_id uuid PRIMARY KEY REFERENCES public.ca_spin_mixed_basis_v1(tournament_id),
  winner_id uuid NOT NULL,
  completed_transaction_id bigint NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.ca_spin_mixed_dispatch_v1 OWNER TO postgres;
ALTER TABLE public.ca_spin_mixed_basis_v1 OWNER TO postgres;
ALTER TABLE public.ca_spin_mixed_completion_v1 OWNER TO postgres;
ALTER TABLE public.ca_spin_mixed_dispatch_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_spin_mixed_basis_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_spin_mixed_completion_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_spin_mixed_dispatch_v1,public.ca_spin_mixed_basis_v1,
  public.ca_spin_mixed_completion_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_spin_mixed_evidence_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog
AS $immutable$
BEGIN
  RAISE EXCEPTION 'mixed-basis admission/completion evidence is immutable' USING ERRCODE='55000';
END;
$immutable$;
CREATE TRIGGER mixed_basis_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.ca_spin_mixed_basis_v1 FOR EACH STATEMENT
 EXECUTE FUNCTION public.fn_ca_spin_mixed_evidence_immutable_v1();
CREATE TRIGGER mixed_completion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.ca_spin_mixed_completion_v1 FOR EACH STATEMENT
 EXECUTE FUNCTION public.fn_ca_spin_mixed_evidence_immutable_v1();

DO $guard$
BEGIN
 IF current_user<>'postgres'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR to_regprocedure('public.fn_ca_spin_mixed_lock_initial_v1(uuid,uuid,text)') IS NOT NULL
 OR to_regclass('public.ca_spin_mixed_basis_v1') IS NULL
 OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_settlement_lane_global()')) IS DISTINCT FROM '7c759bb7a639c3124de2607bdbf12577'
 OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_settlement_lane_for_finish(uuid)')) IS DISTINCT FROM '76e4c6b5291bab20f0cfc65dd060022b'
 THEN RAISE EXCEPTION 'mixed initial lane requires reviewed current finish authority' USING ERRCODE='55000'; END IF;
END $guard$;
CREATE FUNCTION public.fn_ca_spin_mixed_lock_initial_v1(p_id uuid,p_winner uuid,p_mode text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $initial$
DECLARE key bigint;
BEGIN
 -- Classification grants no admission. Full source, seat, funding and outcome
 -- validation remains inside the owning terminal transaction after acquisition.
 IF p_id IS NULL OR p_winner IS NULL OR lower(btrim(p_mode)) IS DISTINCT FROM 'places'
 OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_basis_v1 b WHERE b.tournament_id=p_id)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_id
    AND t.status='RUNNING' AND lower(t.variant)='spin'
    AND (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id)=3
    AND (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id
      AND p.status='eliminated' AND p.position=3 AND p.elimination_sequence IS NULL)=1)
 THEN RETURN false; END IF;
 -- Never upgrade a shared hold or acquire the global lane after data-write locks.
 -- The canonical wrapper must call here immediately after authentication, before
 -- finish/seat authority or writes. GUCs alone are never proof of an owned lock.
 IF current_setting('transaction_isolation')<>'read committed'
 OR coalesce(current_setting('ca.finish_lane_tournament',true),'')<>''
 OR EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory')
 OR EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid()
    AND n.nspname IN ('public','smarter_private','auth')
    AND l.mode IN ('RowShareLock','RowExclusiveLock','ShareUpdateExclusiveLock',
      'ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'))
 THEN RAISE EXCEPTION 'mixed-basis initial admission requires a fresh first-acquisition transaction' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_lock_settlement_lane_global();
 -- The two real exclusive holds are required, even if the helper's routing
 -- changes. A finish-lane GUC or an unrelated advisory key cannot satisfy this.
 FOREACH key IN ARRAY ARRAY[
    hashtextextended('ca:tournament-terminal-settlement:v1',0),
    hashtextextended('ca:hand-settlement-barrier:v1',0)] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid()
     AND l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
     AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND l.classid=((key>>32)&4294967295)::oid
     AND l.objid=(key&4294967295)::oid AND l.objsubid=1) THEN
   RAISE EXCEPTION 'mixed-basis initial admission lacks both exclusive settlement barriers' USING ERRCODE='P0404';
  END IF;
 END LOOP;
 RETURN true;
END $initial$;
ALTER FUNCTION public.fn_ca_spin_mixed_lock_initial_v1(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_lock_initial_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $post$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p
  WHERE p.oid='public.fn_ca_spin_mixed_lock_initial_v1(uuid,uuid,text)'::regprocedure
   AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
   AND md5(p.prosrc)='8ff17974f859ba27dd19c39071f89e8a'
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>'postgres'::regrole)) THEN
  RAISE EXCEPTION 'mixed initial lane private authority differs' USING ERRCODE='55000';
 END IF;
END $post$;

CREATE FUNCTION public.fn_ca_spin_mixed_dispatch_enter_v1(p_id uuid,p_winner uuid,p_mode text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,public,pg_temp
AS $enter$
BEGIN
  -- Ordinary modern completion and all other settlement modes are untouched.
  -- A completed mixed event enters only to verify its existing seal on replay.
  IF p_id IS NULL OR p_winner IS NULL OR lower(btrim(p_mode)) IS DISTINCT FROM 'places' OR NOT (
    EXISTS (SELECT 1 FROM public.ca_spin_mixed_basis_v1 b WHERE b.tournament_id=p_id)
    OR EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=p_id
       AND t.status='RUNNING' AND lower(t.variant)='spin'
       AND (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id)=3
       AND (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id
            AND p.status='eliminated' AND p.position=3 AND p.elimination_sequence IS NULL)=1)
  ) THEN RETURN; END IF;
  INSERT INTO public.ca_spin_mixed_dispatch_v1(tournament_id,transaction_id,winner_id,mode)
    VALUES(p_id,txid_current(),p_winner,'places');
END;
$enter$;

CREATE FUNCTION public.fn_ca_spin_mixed_admit_v1(p_id uuid,p_winner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC'
AS $admit$
DECLARE
  t public.tournaments%ROWTYPE; v_table_id uuid; e record; l record; w record;
  escrow public.tournament_escrow%ROWTYPE; draw public.spin_draw_receipts%ROWTYPE;
  launch public.tournament_launch_receipts%ROWTYPE; closed public.tournament_entry_close_receipts%ROWTYPE;
  contribution public.spin_reserve_ledger%ROWTYPE; draw_leg public.spin_reserve_ledger%ROWTYPE;
  entry_leg public.chip_ledger%ROWTYPE; prize_leg public.chip_ledger%ROWTYPE;
  snapshot jsonb; shape jsonb; paid jsonb; expected_entrants jsonb; pool_id uuid;
  n bigint; gross numeric:=0; first_hand timestamptz; table_name text; final_commit jsonb; final_seat jsonb; live_seats jsonb;
BEGIN
  -- Standalone existing place calls keep the original sequence refusal.
  IF NOT EXISTS (SELECT 1 FROM public.ca_spin_mixed_dispatch_v1 d
      WHERE d.tournament_id=p_id AND d.transaction_id=txid_current()
        AND d.winner_id=p_winner AND d.mode='places') THEN RETURN false; END IF;
  -- Classification can change while the wrapper waits for its finish lane.
  -- Refuse an unsealed mixed admission unless the initial call acquired G/B.
  -- Never upgrade the current shared finish lane after seat/row authority.
  FOR e IN SELECT k FROM unnest(ARRAY[
      hashtextextended('ca:tournament-terminal-settlement:v1',0),
      hashtextextended('ca:hand-settlement-barrier:v1',0)]) keys(k) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_locks lane_lock WHERE lane_lock.pid=pg_backend_pid()
       AND lane_lock.locktype='advisory' AND lane_lock.granted AND lane_lock.mode='ExclusiveLock'
       AND lane_lock.database=(SELECT oid FROM pg_database WHERE datname=current_database())
       AND lane_lock.classid=((e.k>>32)&4294967295)::oid
       AND lane_lock.objid=(e.k&4294967295)::oid AND lane_lock.objsubid=1) THEN
      RAISE EXCEPTION 'mixed-basis admission requires initial exclusive settlement barriers' USING ERRCODE='P0404';
    END IF;
  END LOOP;
  SELECT * INTO STRICT t FROM public.tournaments WHERE id=p_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.ca_spin_mixed_basis_v1 b WHERE b.tournament_id=p_id)
     OR t.status<>'RUNNING' OR lower(t.variant)<>'spin'
     OR t.max_players IS DISTINCT FROM 3 OR t.table_size IS DISTINCT FROM 3
     OR t.is_rebuy IS DISTINCT FROM false OR t.is_reentry IS DISTINCT FROM false
     OR t.add_on_available IS DISTINCT FROM false OR t.bubble_protection IS TRUE
     OR t.prize_pool_finalized IS DISTINCT FROM true OR t.prize_pool IS NULL OR t.prize_pool<=0
     OR t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR t.spin_multiplier IS NULL OR t.spin_multiplier<=0 OR t.spin_multiplier::text IN ('NaN','Infinity','-Infinity')
     OR t.buy_in_amount IS NULL OR t.buy_in_amount<=0 OR t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
     OR t.payout_structure::jsonb IS DISTINCT FROM '[{"place":1,"percentage":100}]'::jsonb THEN
    RAISE EXCEPTION 'mixed-basis ordinary closed three-entrant Spin required' USING ERRCODE='P0404';
  END IF;
  SELECT count(*),min(tb.id::text)::uuid INTO n,v_table_id FROM public.tables tb WHERE tb.tournament_id=p_id;
  IF n<>1 THEN RAISE EXCEPTION 'mixed-basis one original table required' USING ERRCODE='P0404'; END IF;
  PERFORM 1 FROM public.tables tb WHERE tb.id=v_table_id FOR UPDATE;
  PERFORM 1 FROM public.tournament_players p WHERE p.tournament_id=p_id ORDER BY p.id FOR UPDATE;

  -- Lock retained history before atomic rows, the same order used by the
  -- existing history pruner. G/B protects canonical new hand/entry writers;
  -- the receipt statement barrier also protects absent-key direct mutation.
  -- No relation lock, new advisory namespace or caller constraint change.
  FOREACH table_name IN ARRAY ARRAY['hand_history','hand_atomic_commits','settlement_idempotency_keys'] LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I WHERE table_id=$1 LIMIT 10001) bounded',table_name)
      INTO n USING v_table_id;
    IF n>10000 THEN RAISE EXCEPTION 'mixed-basis retained row bound exceeded: %',table_name USING ERRCODE='54000'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.tournament_knockout_candidates k WHERE k.tournament_id=p_id)<>1 THEN
    RAISE EXCEPTION 'mixed-basis one canonical modern knockout required' USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.hand_history h WHERE h.table_id=v_table_id ORDER BY h.id FOR SHARE;
  PERFORM 1 FROM public.hand_atomic_commits c WHERE c.table_id=v_table_id ORDER BY c.hand_number FOR SHARE;
  PERFORM 1 FROM public.settlement_idempotency_keys s WHERE s.table_id=v_table_id ORDER BY s.hand_id FOR SHARE;
  PERFORM 1 FROM public.tournament_knockout_candidates k WHERE k.tournament_id=p_id ORDER BY k.id FOR SHARE;
  SELECT jsonb_build_object('version',1,'tournament',to_jsonb(t),'observed_winner_id',p_winner,
    'tables',(SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id) FROM public.tables tb WHERE tb.id=v_table_id),
    'roster',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.tournament_players p WHERE p.tournament_id=p_id),
    'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.completed_at,s.hand_id),'[]'::jsonb)
       FROM public.settlement_idempotency_keys s WHERE s.table_id=v_table_id),
    'histories',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'table_id',h.table_id,
       'tournament_id',h.tournament_id,'hand_number',h.hand_number,'players',h.players) ORDER BY h.hand_number,h.id),'[]'::jsonb)
       FROM public.hand_history h WHERE h.table_id=v_table_id),
    'commits',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.hand_number),'[]'::jsonb)
       FROM public.hand_atomic_commits c WHERE c.table_id=v_table_id),
    'knockouts',(SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY k.id),'[]'::jsonb)
       FROM public.tournament_knockout_candidates k WHERE k.tournament_id=p_id)) INTO snapshot;
  shape:=public.fn_ca_spin_mixed_history_shape_v1(snapshot);
  IF shape->'shape_ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'mixed-basis retained history refused: %',shape->>'reason' USING ERRCODE='P0404';
  END IF;
  SELECT min((r->>'completed_at')::timestamptz) INTO first_hand FROM jsonb_array_elements(snapshot->'receipts') r;

  -- The final accepted hand binds seat_id and joined_at, with user, table and
  -- stack. occupancy_id is a separate turnover token absent from the retained
  -- request; this check does not infer its historical value.
  PERFORM 1 FROM public.table_seats s WHERE s.table_id=v_table_id AND s.left_at IS NULL ORDER BY s.id FOR UPDATE;
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) INTO live_seats
    FROM public.table_seats s WHERE s.table_id=v_table_id AND s.left_at IS NULL;
  SELECT c INTO STRICT final_commit FROM jsonb_array_elements(snapshot->'commits') c
    WHERE c->'hand_id'=shape#>'{modern_zero,history_hand_id}';
  SELECT q INTO STRICT final_seat FROM jsonb_array_elements(final_commit#>'{stack_result,request,stacks}') q
    WHERE q->>'user_id'=p_winner::text;
  IF jsonb_array_length(live_seats)<>1
     OR (live_seats#>>'{0,user_id}')::uuid IS DISTINCT FROM p_winner
     OR (live_seats#>>'{0,id}')::uuid IS DISTINCT FROM (final_seat->>'seat_id')::uuid
     OR final_seat->>'seat_id' IS NULL OR final_seat->>'seat_joined_at' IS NULL
     OR (live_seats#>>'{0,joined_at}')::timestamptz IS DISTINCT FROM (final_seat->>'seat_joined_at')::timestamptz
     OR (live_seats#>>'{0,stack}')::numeric IS DISTINCT FROM (shape->'final_stacks'->>p_winner::text)::numeric
     OR (live_seats#>>'{0,stack}')::numeric IS DISTINCT FROM (final_seat->>'stack')::numeric
     OR live_seats#>>'{0,status}' IS DISTINCT FROM 'active'
     OR live_seats#>>'{0,terminal_closed_at}' IS NOT NULL THEN
    RAISE EXCEPTION 'mixed-basis final canonical seat generation is not current' USING ERRCODE='P0404';
  END IF;
  snapshot:=snapshot||jsonb_build_object('live_seats',live_seats);
  shape:=public.fn_ca_spin_mixed_history_shape_v1(snapshot);


  -- Exact original paid-entry evidence; NULL registration_id is mandatory
  -- for wallet_charge. Do not invent the historical registration binding.
  IF (SELECT count(*) FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_id)<>3
     OR (SELECT count(*) FROM public.wallet_transactions x WHERE x.related_entity_id=p_id)<>3
     OR (SELECT count(*) FROM public.chip_ledger x WHERE x.tournament_id=p_id)<>5
     OR EXISTS (SELECT 1 FROM public.entry_purchase_idempotency_receipts x
          WHERE x.request->>'tournament_id'=p_id::text OR x.request->>'table_id'=v_table_id::text
             OR x.idempotency_key LIKE 'tourney:'||p_id::text||':%')
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x WHERE x.tournament_id=p_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x WHERE x.tournament_id=p_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements x WHERE x.tournament_id=p_id) THEN
    RAISE EXCEPTION 'mixed-basis entry/paid/attempt scope is not exact' USING ERRCODE='P0404';
  END IF;
  FOR e IN SELECT x.* FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_id ORDER BY x.id FOR SHARE LOOP
    IF e.entitlement_kind<>'wallet_charge' OR e.charge_category<>'tournament_buyin'
       OR e.evidence_kind<>'cutover_wallet_charge' OR e.registration_id IS NOT NULL
       OR e.source_satellite_id IS NOT NULL OR e.source_ticket_id IS NOT NULL
       OR e.escrow_bucket<>'wallet_gross' OR e.gross IS DISTINCT FROM t.buy_in_amount
       OR e.gross<=0 OR e.refund_prize IS DISTINCT FROM e.gross OR e.refund_fee<>0 OR e.refund_bounty<>0
       OR (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=p_id AND p.user_id=e.user_id)<>1
       OR (SELECT count(*) FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_id AND x.user_id=e.user_id)<>1 THEN
      RAISE EXCEPTION 'mixed-basis exact original wallet charge required' USING ERRCODE='P0404';
    END IF;
    SELECT * INTO STRICT l FROM public.chip_ledger x WHERE x.id=e.source_ledger_id FOR SHARE;
    SELECT * INTO STRICT w FROM public.wallet_transactions x
      WHERE x.related_entity_id=p_id AND x.user_id=e.user_id FOR SHARE;
    IF l.tournament_id IS DISTINCT FROM p_id OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
       OR l.from_type<>'player_wallet' OR l.from_entity_id IS DISTINCT FROM e.user_id
       OR l.to_type<>'prize_liability' OR l.to_entity_id IS DISTINCT FROM p_id
       OR l.status<>'posted' OR l.category<>'tournament_buyin' OR l.amount IS DISTINCT FROM e.gross
       OR l.created_at>first_hand OR w.type<>'debit' OR lower(w.category)<>'tournament_buyin'
       OR w.amount IS DISTINCT FROM e.gross OR w.wallet_type IS DISTINCT FROM 'PLAYER'
       OR w.created_at IS NULL OR w.created_at>first_hand OR w.balance_after IS NULL
       OR w.balance_after<0 OR w.balance_after::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'mixed-basis original ledger/reporting debit mismatch' USING ERRCODE='P0404';
    END IF;
    gross:=gross+e.gross;
  END LOOP;
  SELECT * INTO STRICT escrow FROM public.tournament_escrow WHERE tournament_id=p_id FOR UPDATE;
  SELECT * INTO STRICT draw FROM public.spin_draw_receipts WHERE tournament_id=p_id FOR SHARE;
  SELECT * INTO STRICT launch FROM public.tournament_launch_receipts WHERE tournament_id=p_id FOR SHARE;
  SELECT * INTO STRICT closed FROM public.tournament_entry_close_receipts WHERE tournament_id=p_id FOR SHARE;
  IF (SELECT count(*) FROM public.spin_reserve_ledger x WHERE x.tournament_id=p_id)<>2 THEN
    RAISE EXCEPTION 'mixed-basis exact contribution/draw pair required' USING ERRCODE='P0404';
  END IF;
  SELECT * INTO STRICT contribution FROM public.spin_reserve_ledger WHERE tournament_id=p_id AND kind='contribution' FOR SHARE;
  SELECT * INTO STRICT draw_leg FROM public.spin_reserve_ledger WHERE tournament_id=p_id AND kind='jackpot_draw' FOR SHARE;
  SELECT * INTO STRICT entry_leg FROM public.chip_ledger WHERE tournament_id=p_id AND category='spin_entry' FOR SHARE;
  SELECT * INTO STRICT prize_leg FROM public.chip_ledger WHERE tournament_id=p_id AND category='spin_prize' FOR SHARE;
  SELECT jsonb_agg(jsonb_build_object('user_id',p.user_id,'registration_id',p.id) ORDER BY p.user_id)
    INTO expected_entrants FROM public.tournament_players p WHERE p.tournament_id=p_id;
  IF draw.entrants IS DISTINCT FROM expected_entrants OR draw.receipt->'entrants' IS DISTINCT FROM expected_entrants
     OR draw.launch_id IS DISTINCT FROM launch.launch_id OR draw.lease_generation IS DISTINCT FROM launch.lease_generation
     OR launch.completed_at IS NULL OR closed.reprice_completed_at IS NULL
     OR draw.rule_sha256 IS DISTINCT FROM encode(extensions.digest(draw.rule_manifest::text,'sha256'),'hex')
     OR draw.receipt->>'rule_provenance' IS DISTINCT FROM 'legacy_projection'
     OR draw.receipt->'ok' IS DISTINCT FROM 'true'::jsonb
     OR draw.receipt->'rule_manifest' IS DISTINCT FROM draw.rule_manifest
     OR (draw.receipt->>'tournament_id')::uuid IS DISTINCT FROM p_id
     OR (draw.receipt->>'launch_id')::uuid IS DISTINCT FROM launch.launch_id
     OR (draw.receipt->>'prize_pool')::numeric IS DISTINCT FROM t.prize_pool
     OR (draw.receipt->>'starting_chips')::numeric IS DISTINCT FROM t.starting_chips
     OR (draw.receipt->>'multiplier')::numeric IS DISTINCT FROM t.spin_multiplier
     OR closed.final_prize_pool IS DISTINCT FROM t.prize_pool
     OR closed.payout_structure_snapshot IS DISTINCT FROM t.payout_structure::jsonb
     OR contribution.seats IS DISTINCT FROM 3 OR draw_leg.seats IS DISTINCT FROM 3
     OR contribution.buy_in IS DISTINCT FROM t.buy_in_amount OR draw_leg.buy_in IS DISTINCT FROM t.buy_in_amount
     OR contribution.club_id IS DISTINCT FROM draw_leg.club_id
     OR draw_leg.multiplier IS DISTINCT FROM t.spin_multiplier
     OR draw_leg.amount IS DISTINCT FROM -t.prize_pool
     OR contribution.amount<=0 OR contribution.house_rake<0
     OR contribution.amount+contribution.house_rake IS DISTINCT FROM gross
     OR draw_leg.house_rake IS DISTINCT FROM contribution.house_rake
     OR escrow.enforced IS DISTINCT FROM true OR escrow.closed_at IS NOT NULL OR escrow.terminal_closed_at IS NOT NULL
     OR escrow.gross_in IS DISTINCT FROM gross OR escrow.reserve_out IS DISTINCT FROM contribution.amount
     OR escrow.reserve_in IS DISTINCT FROM -draw_leg.amount OR escrow.prize_balance IS DISTINCT FROM t.prize_pool
     OR escrow.fee_entries_in IS DISTINCT FROM contribution.house_rake OR escrow.fee_balance IS DISTINCT FROM contribution.house_rake
     OR escrow.prize_out<>0 OR escrow.fee_out<>0 OR escrow.bounty_out<>0 OR escrow.bounty_in<>0 OR escrow.bounty_balance<>0
     OR escrow.refund_prize<>0 OR escrow.refund_fee<>0 OR escrow.refund_bounty<>0 OR escrow.overlay_in<>0 OR escrow.satellite_in<>0 THEN
    RAISE EXCEPTION 'mixed-basis current draw/entry/escrow evidence disagrees' USING ERRCODE='P0404';
  END IF;
  SELECT p.id INTO STRICT pool_id FROM public.spin_bonus_pools p WHERE p.club_id=contribution.club_id FOR SHARE;
  IF contribution.club_id IS NULL OR pool_id IS NULL
     OR entry_leg.to_entity_id IS DISTINCT FROM pool_id
     OR entry_leg.status<>'posted' OR prize_leg.status<>'posted'
     OR entry_leg.amount IS DISTINCT FROM contribution.amount OR prize_leg.amount IS DISTINCT FROM -draw_leg.amount
     OR entry_leg.from_type<>'prize_liability' OR entry_leg.from_entity_id IS DISTINCT FROM p_id
     OR entry_leg.to_type<>'spin_reserve' OR prize_leg.from_type<>'spin_reserve'
     OR prize_leg.from_entity_id IS DISTINCT FROM entry_leg.to_entity_id
     OR prize_leg.to_type<>'prize_liability' OR prize_leg.to_entity_id IS DISTINCT FROM p_id
     OR entry_leg.club_id IS DISTINCT FROM contribution.club_id OR prize_leg.club_id IS DISTINCT FROM draw_leg.club_id
     OR NOT public.fn_ca_spin_mixed_retained_reserve_key_v1(p_id,'entry',entry_leg.idempotency_key)
     OR NOT public.fn_ca_spin_mixed_retained_reserve_key_v1(p_id,'draw',prize_leg.idempotency_key)
     OR entry_leg.post_to_balance IS DISTINCT FROM contribution.balance_after
     OR prize_leg.post_from_balance IS DISTINCT FROM draw_leg.balance_after
     OR entry_leg.post_to_balance-entry_leg.pre_to_balance IS DISTINCT FROM contribution.amount
     OR prize_leg.pre_from_balance-prize_leg.post_from_balance IS DISTINCT FROM -draw_leg.amount THEN
    RAISE EXCEPTION 'mixed-basis current reserve journal identity disagrees' USING ERRCODE='P0404';
  END IF;
  paid:=jsonb_build_object('entitlements',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_id),
    'ledger',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.chip_ledger x WHERE x.tournament_id=p_id),
    'wallet',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.wallet_transactions x WHERE x.related_entity_id=p_id),
    'escrow',to_jsonb(escrow),'draw',to_jsonb(draw),'launch',to_jsonb(launch),'entry_close',to_jsonb(closed),
    'contribution',to_jsonb(contribution),'reserve_draw',to_jsonb(draw_leg),
    'reserve_pool_identity',jsonb_build_object('id',pool_id,'club_id',contribution.club_id),
    'historical_rng_proven',false,'historical_registration_binding_proven',false);
  INSERT INTO public.ca_spin_mixed_basis_v1
    (tournament_id,winner_id,admitted_transaction_id,admitted_at,policy,snapshot,snapshot_sha256,shape,paid_evidence)
    VALUES(p_id,p_winner,txid_current(),clock_timestamp(),'current-retained-mixed-spin-v1',snapshot,
      encode(extensions.digest(snapshot::text,'sha256'),'hex'),shape,paid);
  RETURN true;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS OR invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'mixed-basis exact source identity/amount is absent or ambiguous' USING ERRCODE='P0404';
END;
$admit$;

CREATE FUNCTION public.fn_ca_spin_mixed_dispatch_finish_v1(p_id uuid,p_winner uuid,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,public,pg_temp
AS $finish$
DECLARE b public.ca_spin_mixed_basis_v1%ROWTYPE; canonical jsonb; prior public.ca_spin_mixed_completion_v1%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ca_spin_mixed_dispatch_v1 d WHERE d.tournament_id=p_id
      AND d.transaction_id=txid_current() AND d.winner_id=p_winner AND d.mode='places') THEN RETURN; END IF;
  SELECT * INTO STRICT b FROM public.ca_spin_mixed_basis_v1 WHERE tournament_id=p_id;
  canonical:=public.fn_ca_tournament_terminal_receipt(p_id,p_winner);
  IF canonical IS DISTINCT FROM p_result OR canonical->'ok' IS DISTINCT FROM 'true'::jsonb
     OR canonical->'fully_settled' IS DISTINCT FROM 'true'::jsonb
     OR canonical->>'status' IS DISTINCT FROM 'COMPLETED'
     OR (canonical->>'winner_id')::uuid IS DISTINCT FROM p_winner OR b.winner_id IS DISTINCT FROM p_winner
     OR (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=p_id)<>3
     OR b.snapshot_sha256 IS DISTINCT FROM encode(extensions.digest(b.snapshot::text,'sha256'),'hex')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(b.snapshot->'roster') original
          LEFT JOIN public.tournament_players p ON p.id=(original->>'id')::uuid AND p.tournament_id=p_id
          WHERE p.id IS NULL OR p.user_id IS DISTINCT FROM (original->>'user_id')::uuid
             OR p.elimination_sequence IS DISTINCT FROM (original->>'elimination_sequence')::bigint
             OR p.chips IS DISTINCT FROM (original->>'chips')::numeric
             OR p.position IS DISTINCT FROM CASE WHEN p.user_id=p_winner THEN 1 ELSE (original->>'position')::integer END
             OR p.status::text IS DISTINCT FROM CASE WHEN p.user_id=p_winner THEN 'winner' ELSE 'eliminated' END) THEN
    RAISE EXCEPTION 'mixed-basis canonical completion/standing preservation failed' USING ERRCODE='P0404';
  END IF;
  SELECT * INTO prior FROM public.ca_spin_mixed_completion_v1 WHERE tournament_id=p_id;
  IF FOUND THEN
    IF prior.winner_id IS DISTINCT FROM p_winner OR prior.receipt IS DISTINCT FROM canonical
       OR prior.receipt_sha256 IS DISTINCT FROM encode(extensions.digest(canonical::text,'sha256'),'hex') THEN
      RAISE EXCEPTION 'mixed-basis replay differs from immutable completion' USING ERRCODE='P0404';
    END IF;
  ELSE
    IF b.admitted_transaction_id IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'mixed-basis unconsumed historical seal cannot authorize completion' USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.ca_spin_mixed_completion_v1 VALUES
      (p_id,p_winner,txid_current(),canonical,encode(extensions.digest(canonical::text,'sha256'),'hex'));
  END IF;
  DELETE FROM public.ca_spin_mixed_dispatch_v1 WHERE tournament_id=p_id AND transaction_id=txid_current();
  IF NOT FOUND THEN RAISE EXCEPTION 'mixed-basis dispatch disappeared' USING ERRCODE='P0404'; END IF;
END;
$finish$;

-- Guarded exact wrapper/settler patch and private ACL closure follow below.

DO $patch$
DECLARE original text; expected text;
BEGIN
  SELECT pg_get_functiondef('public.fn_settle_tournament_places(uuid,uuid)'::regprocedure) INTO original;
  IF md5(original)<>'c412c8b17186976df139f73a706175f2' THEN RAISE EXCEPTION 'mixed terminal preimage raced: fn_settle_tournament_places(uuid,uuid)'; END IF;
  original:=replace(original,$old0$  v_misplaced_busts integer;$old0$,$new0$  v_misplaced_busts integer;
  v_mixed_basis boolean := false;$new0$);
  original:=replace(original,$old1$  ELSE
    -- Recorded finish positions$old1$,$new1$  ELSE
    IF EXISTS (SELECT 1 FROM public.tournament_players p
        WHERE p.tournament_id=p_tournament_id AND p.status='eliminated'
          AND p.elimination_sequence IS NULL) THEN
      v_mixed_basis:=public.fn_ca_spin_mixed_admit_v1(p_tournament_id,p_observed_winner_id);
    END IF;
    -- Recorded finish positions$new1$);
  original:=replace(original,$old2$    -- Final numeric positions are derived from the transition witness, not$old2$,$new2$    IF NOT v_mixed_basis THEN
    -- Final numeric positions are derived from the transition witness, not$new2$);
  original:=replace(original,$old3$  END IF;

  -- Derive the single pool-funded bubble promise$old3$,$new3$    END IF; -- Existing sequence/chronology path above is unchanged for ordinary cases.
  END IF;

  -- Derive the single pool-funded bubble promise$new3$);
  IF md5(original)<>'dcf5b042d3ba2f806d513e20a32ac0c1' THEN RAISE EXCEPTION 'mixed terminal patch shape differs: fn_settle_tournament_places(uuid,uuid)'; END IF;
  EXECUTE original;
  IF md5(pg_get_functiondef('public.fn_settle_tournament_places(uuid,uuid)'::regprocedure))<>'dcf5b042d3ba2f806d513e20a32ac0c1' THEN RAISE EXCEPTION 'mixed terminal installed postimage differs: fn_settle_tournament_places(uuid,uuid)'; END IF;
  SELECT pg_get_functiondef('public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure) INTO original;
  IF md5(original)<>'c64e049911fd99c1d784cdb042ca714b' THEN RAISE EXCEPTION 'mixed terminal preimage raced: fn_complete_tournament_terminal(uuid,uuid,text)'; END IF;
  original:=replace(original,$initial_old$  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);$initial_old$,$initial_new$  PERFORM public.fn_ca_spin_mixed_lock_initial_v1(p_tournament_id,p_observed_winner_id,p_settlement_mode);
  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);$initial_new$);
  original:=replace(original,$old0$  BEGIN
    v_result:=$old0$,$new0$  BEGIN
    PERFORM public.fn_ca_spin_mixed_dispatch_enter_v1(p_tournament_id,p_observed_winner_id,p_settlement_mode);
    v_result:=$new0$);
  original:=replace(original,$old1$    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));$old1$,$new1$    PERFORM public.fn_ca_spin_mixed_dispatch_finish_v1(p_tournament_id,p_observed_winner_id,v_result);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));$new1$);
  IF md5(original)<>'95ba3a4298e9bd2f1430cd19e36251af' THEN RAISE EXCEPTION 'mixed terminal patch shape differs: fn_complete_tournament_terminal(uuid,uuid,text)'; END IF;
  EXECUTE original;
  IF md5(pg_get_functiondef('public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure))<>'95ba3a4298e9bd2f1430cd19e36251af' THEN RAISE EXCEPTION 'mixed terminal installed postimage differs: fn_complete_tournament_terminal(uuid,uuid,text)'; END IF;
END;
$patch$;
ALTER FUNCTION public.fn_ca_spin_mixed_evidence_immutable_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_evidence_immutable_v1() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_spin_mixed_dispatch_enter_v1(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_dispatch_enter_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_spin_mixed_admit_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_admit_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_spin_mixed_dispatch_finish_v1(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_spin_mixed_dispatch_finish_v1(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $candidate_postimage$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_ca_spin_mixed_evidence_immutable_v1()','b701e04e1bea82a608a08f9d8d134092',false),
 ('public.fn_ca_spin_mixed_dispatch_enter_v1(uuid,uuid,text)','4d4513b01cbdfa52053d93690bd5c604',true),
 ('public.fn_ca_spin_mixed_admit_v1(uuid,uuid)','f49c8e39f56dfdb7371b71dd0ff805f1',true),
 ('public.fn_ca_spin_mixed_dispatch_finish_v1(uuid,uuid,jsonb)','f73019a42cdb36ef73dd3021481e3d37',true)
 ) funcs(signature,body_md5,secdef) LOOP
   IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature)
       AND p.proowner='postgres'::regrole AND p.prosecdef=r.secdef AND p.provolatile='v'
       AND md5(p.prosrc)=r.body_md5
       AND (SELECT array_agg(lower(v) ORDER BY n) FROM unnest(p.proconfig) WITH ORDINALITY c(v,n))
         =CASE r.signature
           WHEN 'public.fn_ca_spin_mixed_evidence_immutable_v1()' THEN ARRAY['search_path=pg_catalog']
           WHEN 'public.fn_ca_spin_mixed_admit_v1(uuid,uuid)' THEN ARRAY['search_path=pg_catalog, public, pg_temp','timezone=utc']
           ELSE ARRAY['search_path=pg_catalog, public, pg_temp'] END
       AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
         WHERE a.grantee<>'postgres'::regrole)) THEN
     RAISE EXCEPTION 'mixed private function postimage differs: %',r.signature USING ERRCODE='55000';
   END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('ca_spin_mixed_dispatch_v1'),('ca_spin_mixed_basis_v1'),('ca_spin_mixed_completion_v1')) rels(name) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.'||r.name)
       AND c.relkind='r' AND c.relowner='postgres'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity
       AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)
       AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
         WHERE a.grantee<>'postgres'::regrole)) THEN
     RAISE EXCEPTION 'mixed private relation postimage differs: %',r.name USING ERRCODE='55000';
   END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
       AND t.tgfoid='public.fn_ca_spin_mixed_evidence_immutable_v1()'::regprocedure)<>2
    OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
       AND t.tgfoid='public.fn_ca_spin_mixed_evidence_immutable_v1()'::regprocedure
       AND t.tgtype=58 AND t.tgqual IS NULL AND t.tgattr::text='' AND t.tgnargs=0
       AND NOT t.tgdeferrable
       AND ((t.tgrelid='public.ca_spin_mixed_basis_v1'::regclass AND t.tgname='mixed_basis_immutable')
         OR (t.tgrelid='public.ca_spin_mixed_completion_v1'::regclass AND t.tgname='mixed_completion_immutable')))<>2 THEN
   RAISE EXCEPTION 'mixed immutable statement bindings differ' USING ERRCODE='55000';
 END IF;
END;
$candidate_postimage$;
DO $doctrine$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_settlement_lane_doctrine()'::regprocedure) INTO source;
 IF md5(source)<>'8dd361600c8facb1cbb99b3df853e5b9' THEN RAISE EXCEPTION 'mixed initial lane doctrine preimage differs' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old$    'fn_ca_lock_settlement_lane_for_satellite_finish',$old$,$new$    'fn_ca_lock_settlement_lane_for_satellite_finish','fn_ca_spin_mixed_lock_initial_v1',$new$);
 IF md5(source)<>'a9d989c121c9d5066ee90ffefffaa4ee' THEN RAISE EXCEPTION 'mixed initial lane doctrine patch differs' USING ERRCODE='55000'; END IF;
 EXECUTE source;
 IF md5(pg_get_functiondef('public.fn_ca_settlement_lane_doctrine()'::regprocedure))<>'a9d989c121c9d5066ee90ffefffaa4ee' THEN RAISE EXCEPTION 'mixed initial lane doctrine postimage differs' USING ERRCODE='55000'; END IF;
END $doctrine$;
COMMIT;
