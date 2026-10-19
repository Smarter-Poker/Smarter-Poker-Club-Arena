"""Qualify pool-custody PNL in the maintained native Lightning settlement chain.

All chips are synthetic in disposable PostgreSQL17. The real physical door,
pool/session owners, actual PNL capture/retention readers and candidate run;
unrelated escrow and original-funding branches are empty fixture controls.
"""
import json, os, pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PRE = ROOT / 'scripts/ci/fixtures/lightning-original-pnl-preimages.json'
M = ROOT / 'supabase/migrations/20261019194126_lightning_original_pool_custody_certifies_its_hand_outcome.sql'
pre = json.loads(PRE.read_text())
schema = ['CREATE SCHEMA IF NOT EXISTS smarter_private;']
for row in pre['schemas']:
    namespace = 'smarter_private' if row['relname'].startswith('horse_cash_') else 'public'
    columns = row['columns'].replace('event_id bigint NOT NULL', 'event_id bigserial NOT NULL')
    schema.append(f"CREATE TABLE {namespace}.{row['relname']}({columns});")
schema += ["""
ALTER TABLE public.union_pnl_transaction_frames ADD PRIMARY KEY(transaction_id);
ALTER TABLE public.union_pnl_cash_outcomes ADD PRIMARY KEY(table_id,hand_number);
ALTER TABLE public.union_pnl_cash_outcome_link_resolutions ADD PRIMARY KEY(table_id,hand_number),
 ADD CONSTRAINT union_pnl_cash_outcome_link_resolutions_roster_source_check
 CHECK ((roster_source = ANY (ARRAY['manifest'::text, 'seat_inventory'::text])));
CREATE INDEX ON public.union_pnl_inventory_events(source_name,row_id,event_id DESC);
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS is_union boolean DEFAULT false;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_private boolean DEFAULT true;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS union_id uuid;
CREATE TABLE IF NOT EXISTS public.cash_participant_funding_receipts(id uuid);
CREATE TABLE IF NOT EXISTS public.cash_funding_application_receipts(id uuid);
CREATE TABLE IF NOT EXISTS public.chip_ledger(id uuid);
CREATE FUNCTION smarter_private.posthand_escrow_certified_evidence(uuid,bigint) RETURNS jsonb
 LANGUAGE sql AS 'SELECT NULL::jsonb';
""", pre['atomic_match']]
schema += [r['definition'] for r in pre['more_prerequisites']]
schema += [r['definition'] for r in pre['prerequisites']]
schema += [r['definition'] for r in pre['consumer_prerequisites']]
schema += [pre['hand_evidence'], pre['settlement']]
for row in pre['link_constraints']:
    if row['conname'] not in ('union_pnl_cash_outcome_link_resolutions_pkey','union_pnl_cash_outcome_link_resolutions_roster_source_check'):
        schema.append(f"ALTER TABLE public.union_pnl_cash_outcome_link_resolutions ADD CONSTRAINT {row['conname']} {row['definition']};")
replay_pre = 'DO $pre$' + M.read_text().split('DO $pre$',1)[1].split('END $pre$;',1)[0] + 'END $pre$;'
live_proofs = '\n'.join("DO $liveproof$ BEGIN IF ("+line.removeprefix('-- @live-proof: ')+") IS NOT TRUE THEN RAISE EXCEPTION 'installed live proof differs';END IF;END $liveproof$;" for line in M.read_text().splitlines() if line.startswith('-- @live-proof: '))
setup = '\n;\n'.join(schema) + ';\n' + f"""
ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS showed boolean;
DO $owner$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres LOGIN SUPERUSER; END IF; END $owner$;
SET SESSION AUTHORIZATION postgres;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY);
CREATE TRIGGER original_table_inventory AFTER INSERT OR UPDATE ON public.tables
 FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE CONSTRAINT TRIGGER original_union_pnl_cash_acceptance AFTER INSERT ON public.hand_atomic_commits
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_capture_accepted_cash();
CREATE TABLE harness.pnl_cases(label text PRIMARY KEY,game uuid,hand_id uuid,request_id uuid,results jsonb,hand_row jsonb,before_stacks text);
CREATE FUNCTION harness.pnl_case(p_label text) RETURNS void LANGUAGE plpgsql AS $body$
DECLARE g uuid;f jsonb;h uuid;ids uuid[];spec jsonb;r jsonb;req uuid:=gen_random_uuid();
BEGIN
 g:=harness.cluster(p_label);
 UPDATE public.tables SET is_private=true,union_id=NULL WHERE cluster_id=g;
 SELECT array_agg(player_id ORDER BY player_id) INTO ids FROM(SELECT player_id FROM lightning_pool_session WHERE cluster_id=g AND exited_at IS NULL ORDER BY player_id LIMIT 4)q;
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 spec:=jsonb_build_object(ids[1]::text,jsonb_build_object('d',.09,'c',.14),ids[2]::text,jsonb_build_object('d',-.14,'c',.14),ids[3]::text,jsonb_build_object('d',0,'c',0,'f','fast'),ids[4]::text,jsonb_build_object('d',0,'c',0,'f','fast'));
 INSERT INTO harness.pnl_cases VALUES(p_label,g,h,req,harness.results(h,spec),jsonb_build_object('pot_size',.28,'big_blind',.04,'small_blind',.02),harness.stacks(g));
END $body$;
SELECT harness.pnl_case('historical');
DO $baseline$ DECLARE c harness.pnl_cases;r jsonb; BEGIN
 SELECT * INTO c FROM harness.pnl_cases WHERE label='historical';
 r:=harness.settle(c.hand_id,c.request_id,c.results,.03,.02,c.hand_row);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'real baseline settlement refused:%',r; END IF;
END $baseline$;
DO $blocked$ BEGIN
 IF NOT EXISTS(SELECT FROM public.union_pnl_cash_outcomes o JOIN public.lightning_hand h ON h.hand_history_id=o.hand_id JOIN harness.pnl_cases c ON c.hand_id=h.hand_id
  WHERE c.label='historical' AND o.game_scope='{{}}'::jsonb AND o.evidence->>'reason'='accepted_cash_provenance_link_missing') THEN RAISE EXCEPTION 'baseline did not reproduce actual missing original pool proof'; END IF;
END $blocked$;
\\echo 'PASS baseline: real Lightning settlement commits the exact blocked original PNL observation'
\\i {M}
BEGIN;
DO $rolled$ DECLARE c record;p jsonb;r jsonb; BEGIN
 SELECT h.* INTO c FROM lightning_hand h JOIN harness.pnl_cases k ON k.hand_id=h.hand_id WHERE k.label='historical';
 p:=public.fn_lightning_original_pnl_proof(c.host_table_id,c.hand_number);
 IF p->>'status'<>'proven' OR p#>>'{{evidence,accepted_rake}}'<>'0.03' THEN RAISE EXCEPTION 'candidate did not prove native originals:%',p; END IF;
 r:=public.fn_lightning_record_original_pnl(c.host_table_id,c.hand_number,md5(p::text));
 IF r->>'status'<>'recorded' THEN RAISE EXCEPTION 'certificate not recorded:%',r; END IF;
END $rolled$;
ROLLBACK;
DO $no_probe_write$ BEGIN IF EXISTS(SELECT FROM union_pnl_cash_outcome_link_resolutions)THEN RAISE EXCEPTION 'rollback left a certificate'; END IF;END $no_probe_write$;
DO $record$ DECLARE c record;p jsonb;r jsonb;again jsonb;original text;saved text; BEGIN
 SELECT h.*,k.game INTO c FROM lightning_hand h JOIN harness.pnl_cases k ON k.hand_id=h.hand_id WHERE k.label='historical';
 SELECT md5(evidence::text)INTO original FROM union_pnl_cash_outcomes WHERE hand_id=c.hand_history_id;
 saved:=harness.stacks(c.game);p:=public.fn_lightning_original_pnl_proof(c.host_table_id,c.hand_number);
 PERFORM set_config('TimeZone','America/Los_Angeles',true);
 IF public.fn_lightning_original_pnl_proof(c.host_table_id,c.hand_number)IS DISTINCT FROM p THEN RAISE EXCEPTION 'proof hash changes with caller timezone';END IF;
 PERFORM set_config('TimeZone','UTC',true);
 BEGIN PERFORM public.fn_lightning_record_original_pnl(c.host_table_id,c.hand_number,NULL); RAISE EXCEPTION 'historical null hash accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'lightning_original_pnl_historical_proof_required' THEN RAISE; END IF; END;
 BEGIN PERFORM public.fn_lightning_record_original_pnl(c.host_table_id,c.hand_number,repeat('0',32)); RAISE EXCEPTION 'wrong hash accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'lightning_original_pnl_proof_refused' THEN RAISE; END IF; END;
 r:=public.fn_lightning_record_original_pnl(c.host_table_id,c.hand_number,md5(p::text));
 again:=public.fn_lightning_record_original_pnl(c.host_table_id,c.hand_number,md5(p::text));
 IF r->>'status'<>'recorded' OR again->>'status'<>'already_recorded' OR harness.stacks(c.game)IS DISTINCT FROM saved
 OR (SELECT md5(evidence::text)FROM union_pnl_cash_outcomes WHERE hand_id=c.hand_history_id)IS DISTINCT FROM original THEN RAISE EXCEPTION 'certificate moved chips, rewrote original or duplicated'; END IF;
 IF (SELECT count(*)FROM union_pnl_cash_outcomes o CROSS JOIN LATERAL public.fn_union_pnl_cash_outcome_link(o)r WHERE o.hand_id=c.hand_history_id)<>1 THEN RAISE EXCEPTION 'actual weekly link consumer did not accept original certificate'; END IF;
END $record$;
DO $faults$ DECLARE c record;p jsonb;f text;target text;sql text;who uuid;sid uuid;csid uuid;passed integer:=0; BEGIN
 SELECT h.* INTO c FROM lightning_hand h JOIN harness.pnl_cases k ON k.hand_id=h.hand_id WHERE k.label='historical';
 SELECT hp.player_id,sl.pool_session_id,ps.cash_player_session_id INTO who,sid,csid
 FROM lightning_hand_player hp JOIN lightning_pool_slot sl ON sl.id=hp.pool_slot_id JOIN lightning_pool_session ps ON ps.id=sl.pool_session_id
 WHERE hp.hand_id=c.hand_id ORDER BY hp.seat LIMIT 1;
 FOREACH f IN ARRAY ARRAY['receipt_hash','request_binding','signed_request','delta','session_player','session_time','nonfinite_session','scope_asset','pending_payload'] LOOP
  CASE f
   WHEN 'receipt_hash' THEN target:='lightning_hand';sql:=format('UPDATE lightning_hand SET settle_receipt=jsonb_set(settle_receipt,ARRAY[''receipt_hash''],to_jsonb(repeat(''0'',64)))WHERE hand_id=%L',c.hand_id);
   WHEN 'request_binding' THEN target:='lightning_hand';sql:=format('UPDATE lightning_hand SET settle_request_hash=repeat(''0'',64)WHERE hand_id=%L',c.hand_id);
   WHEN 'signed_request' THEN target:='cash_hand_provenance_receipts';sql:=format('UPDATE cash_hand_provenance_receipts SET accepted_request=accepted_request||''{{"unexpected_financial_input":1}}''::jsonb WHERE hand_id=%L',c.hand_history_id);
   WHEN 'delta' THEN target:='lightning_hand';sql:=format('UPDATE lightning_hand SET settle_receipt=jsonb_set(settle_receipt,ARRAY[''deltas'',%L],to_jsonb(1::numeric))WHERE hand_id=%L;UPDATE lightning_hand SET settle_receipt=jsonb_set(settle_receipt,ARRAY[''receipt_hash''],to_jsonb(encode(sha256(convert_to((settle_receipt-''receipt_hash'')::text,''UTF8'')),''hex'')))WHERE hand_id=%L',who::text,c.hand_id,c.hand_id);
   WHEN 'session_player' THEN target:='lightning_pool_session';sql:=format('UPDATE lightning_pool_session SET cash_player_session_id=(SELECT id FROM cash_player_session WHERE player_id<>%L LIMIT 1)WHERE id=%L',who,sid);
   WHEN 'session_time' THEN target:='cash_player_session';sql:=format('UPDATE cash_player_session SET opened_at=clock_timestamp()+interval ''1 day'' WHERE id=%L',csid);
   WHEN 'nonfinite_session' THEN target:='cash_player_session';sql:=format('UPDATE cash_player_session SET opened_at=''-infinity'' WHERE id=%L',csid);
   WHEN 'scope_asset' THEN target:='clubs';sql:=format('UPDATE clubs SET asset=''diamonds''WHERE id=(SELECT club_id FROM cash_player_session WHERE id=%L)',csid);
   WHEN 'pending_payload' THEN target:='hand_atomic_commits';sql:=format('UPDATE hand_atomic_commits SET post_commit_payload=NULL WHERE hand_id=%L',c.hand_history_id);
  END CASE;
  BEGIN
   -- Fault injection is confined to this disposable transaction. Production
   -- guards are never disabled, and each fixture mutation is rolled back.
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER',target);EXECUTE sql;
   EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER',target);
   p:=public.fn_lightning_original_pnl_proof(c.host_table_id,c.hand_number);
   IF p->>'status' IS DISTINCT FROM 'refused' THEN RAISE EXCEPTION 'unproven original accepted for %: %',f,p;END IF;
   RAISE EXCEPTION 'fixture rollback' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN passed:=passed+1;
  END;
 END LOOP;
 IF passed<>9 OR public.fn_lightning_original_pnl_proof(c.host_table_id,c.hand_number)->>'status'<>'proven' THEN RAISE EXCEPTION 'negative fixture did not restore exactly'; END IF;
END $faults$;
\\echo 'PASS nine independent missing/conflicting original receipt and custody refusals'
SELECT harness.pnl_case('live');
DO $live$ DECLARE c harness.pnl_cases;r jsonb; BEGIN
 SELECT * INTO c FROM harness.pnl_cases WHERE label='live';
 r:=harness.settle(c.hand_id,c.request_id,c.results,.03,.02,c.hand_row);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'live source refused:%',r; END IF;
END $live$;
DO $live_readback$ DECLARE c record;saved text;r jsonb; BEGIN
 SELECT h.*,k.game,k.request_id input_request_id,k.results,k.hand_row INTO c FROM lightning_hand h JOIN harness.pnl_cases k ON k.hand_id=h.hand_id WHERE k.label='live';
 IF (SELECT count(*)FROM union_pnl_cash_outcome_link_resolutions WHERE hand_id=c.hand_history_id AND roster_source='lightning_pool' AND evidence->>'status'='ready')<>1 THEN RAISE EXCEPTION 'original deferred transition did not retain proof'; END IF;
 IF (SELECT count(*)FROM union_pnl_cash_outcomes o CROSS JOIN LATERAL public.fn_union_pnl_cash_outcome_link(o)r WHERE o.hand_id=c.hand_history_id AND jsonb_array_length(r.evidence->'participants')=4 AND (r.evidence->>'accepted_rake')::numeric=.03 AND(r.evidence->>'accepted_bbj')::numeric=.02)<>1 THEN RAISE EXCEPTION 'live proof did not reach original consumer with all four players and exact fees'; END IF;
 saved:=harness.stacks(c.game);r:=harness.settle(c.hand_id,c.input_request_id,c.results,.03,.02,c.hand_row);
 IF r->>'replay' IS DISTINCT FROM 'true' OR harness.stacks(c.game)IS DISTINCT FROM saved OR(SELECT count(*)FROM union_pnl_cash_outcome_link_resolutions WHERE hand_id=c.hand_history_id)<>1 THEN RAISE EXCEPTION 'native replay changed chips or proof'; END IF;
 IF EXISTS(SELECT FROM pg_proc WHERE proname LIKE 'fn_lightning_%pnl%' AND(proacl::text IS DISTINCT FROM '{{postgres=X/postgres}}' OR NOT prosecdef OR pg_get_userbyid(proowner)<>'postgres'))THEN RAISE EXCEPTION 'private PNL ACL/owner changed';END IF;
END $live_readback$;
SELECT harness.pnl_case('refused_live');
DO $atomic_refusal$ DECLARE c record;r jsonb;saved text; BEGIN
 SELECT h.*,k.game,k.request_id input_request_id,k.results,k.hand_row INTO c FROM lightning_hand h JOIN harness.pnl_cases k ON k.hand_id=h.hand_id WHERE k.label='refused_live';
 saved:=harness.stacks(c.game);
 BEGIN
  -- Remove only synthetic original scope in this subtransaction. The real
  -- settlement must abort whole when its deferred proof cannot be retained.
  DELETE FROM union_pnl_inventory_events WHERE source_name='tables'AND row_id=c.host_table_id;
  r:=harness.settle(c.hand_id,c.input_request_id,c.results,.03,.02,c.hand_row);
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'native fault did not reach deferred proof:%',r;END IF;
  SET CONSTRAINTS original_union_pnl_cash_acceptance,lightning_original_pnl_at_settlement IMMEDIATE;
  RAISE EXCEPTION 'unprovable live hand committed';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'lightning_original_pnl_proof_refused'THEN RAISE;END IF;
 END;
 IF harness.stacks(c.game)IS DISTINCT FROM saved OR EXISTS(SELECT FROM hand_atomic_commits WHERE table_id=c.host_table_id AND hand_number=c.hand_number)
  OR EXISTS(SELECT FROM lightning_hand WHERE hand_id=c.hand_id AND(settled_at IS NOT NULL OR settle_receipt IS NOT NULL))THEN RAISE EXCEPTION 'deferred refusal left a partial monetary hand';END IF;
 r:=harness.settle(c.hand_id,c.input_request_id,c.results,.03,.02,c.hand_row);
 IF r->>'ok' IS DISTINCT FROM 'true'THEN RAISE EXCEPTION 'same original request could not complete after definite rollback:%',r;END IF;
END $atomic_refusal$;
DO $atomic_readback$ BEGIN
 IF (SELECT count(*)FROM union_pnl_cash_outcome_link_resolutions r JOIN lightning_hand h ON h.hand_history_id=r.hand_id JOIN harness.pnl_cases c ON c.hand_id=h.hand_id WHERE c.label='refused_live')<>1 THEN RAISE EXCEPTION 'rolled-back request did not retain exactly one successful proof';END IF;
END $atomic_readback$;
\\echo 'PASS real deferred failure rolls back the whole hand; same original request completes once'
DO $access$ DECLARE role_name text;denied integer:=0; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  EXECUTE format('SET LOCAL ROLE %I',role_name);
  BEGIN PERFORM public.fn_lightning_original_pnl_proof(NULL,NULL);RAISE EXCEPTION 'private reader exposed to %',role_name;
  EXCEPTION WHEN insufficient_privilege THEN denied:=denied+1;END;
  RESET ROLE;
 END LOOP;
 IF denied<>3 THEN RAISE EXCEPTION 'private reader role refusals incomplete';END IF;
END $access$;
DO $reapply$ BEGIN
 BEGIN EXECUTE $pretext${replay_pre}$pretext$;RAISE EXCEPTION 'candidate replay accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'lightning_original_pnl_already_installed'THEN RAISE;END IF;END;
END $reapply$;
{live_proofs}
SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid)))pnl_postimages FROM pg_proc
 WHERE pronamespace='public'::regnamespace AND proname IN('fn_lightning_original_pnl_proof','fn_lightning_record_original_pnl','fn_lightning_original_pnl_at_settlement');
\\echo 'PASS original pool proof, historical hash guard, rollback, no payment, immutable outcome, native live transition and duplicate settlement'
"""
with tempfile.TemporaryDirectory(prefix='lpnl-') as work:
    followup = pathlib.Path(work) / 'followup.sql'
    followup.write_text(setup)
    pg = pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
    socket = os.environ.get('LIGHTNING_ZERO_PAYER_SOCKET')
    if socket:
        command = [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',os.environ['LIGHTNING_ZERO_PAYER_PORT'],'-d','postgres','-f',str(followup)]
        env = os.environ.copy()
    else:
        command = ['bash',str(ROOT/'scripts/dev/test-lightning-phase6-settlement.sh')]
        env = dict(os.environ,LIGHTNING_P6S_FOLLOWUP_SQL=str(followup))
    result = subprocess.run(command,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
    print(result.stdout)
    if result.returncode or 'PASS original pool proof,' not in result.stdout:
        raise SystemExit(result.returncode or 1)
