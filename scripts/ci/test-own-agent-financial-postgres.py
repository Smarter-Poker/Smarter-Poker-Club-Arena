#!/usr/bin/env python3
"""Native PostgreSQL proof for own-playing-agent interpretation and typed R3.
Actual changed owners, original R2/R3, append-only audit and phase capability
run on synthetic sources. Original paid receipts and producer replay remain
legacy. Full-week source prerequisites and fleet certificate/clock are explicit
isolation boundaries; this suite does not certify production or fleet parking.
"""
import argparse, re, json, hashlib, importlib.util, os, shutil, socket, subprocess, sys, tempfile
from contextlib import contextmanager
from pathlib import Path

P=argparse.ArgumentParser()
P.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
P.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')))
P.add_argument('--scratch-root',type=Path,default=Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir())))
P.add_argument('--output',type=Path,default=None)
P.add_argument('--pause-source-root',type=Path,default=None)
P.add_argument('--document-source-root',type=Path,default=None)
P.add_argument('--candidate-migration',type=Path,default=None)
P.add_argument('--compile-fragments',action='store_true',help='Emit new owner body identities for migration generation; not whole-installer qualification')
A=P.parse_args()
if A.candidate_migration is None:A.candidate_migration=A.repo/'supabase/migrations/20261028184531_own_playing_agent_earnings_keep_typed_wallet_receipts.sql'
R=A.repo; F=R/'scripts/ci/fixtures/commission-agent-wallet'; BASE=R/'tests/fixtures/weekly-close-scale'; DR=R/'scripts/ci/fixtures/deleted-weekly-routing'
MIG=next((R/'supabase/migrations').glob('20261022164439_*.sql'))
# Record every actual repository source/fixture read, including reads inside
# the shared document loader. Scratch outputs and interpreter files are excluded.
source_inputs={};source_roots=[R.resolve(),(A.pause_source_root or R).resolve(),(A.document_source_root or R).resolve()]
original_read_text=Path.read_text;original_read_bytes=Path.read_bytes
def record_source(path):
    path=path.resolve()
    for root in source_roots:
        if path.is_relative_to(root):
            relative=path.relative_to(root)
            if relative.parts[0]in('.owned-scratch','.owned-npm-cache','node_modules'):return
            key=str(relative);digest=hashlib.sha256(original_read_bytes(path)).hexdigest()
            assert key not in source_inputs or source_inputs[key]==digest,('conflicting input source roots',key)
            source_inputs[key]=digest;return
def source_text(path,*args,**kwargs):
    value=original_read_text(path,*args,**kwargs);record_source(path);return value
def source_bytes(path,*args,**kwargs):
    value=original_read_bytes(path,*args,**kwargs);record_source(path);return value
Path.read_text=source_text;Path.read_bytes=source_bytes
E={k:v for k,v in os.environ.items() if not k.startswith('PG')};E.update(LC_ALL='C',LANG='C',PGTZ='UTC')
os.environ.update(LC_ALL='C',LANG='C')
A.scratch_root.mkdir(parents=True,exist_ok=True)
W=Path(tempfile.mkdtemp(prefix='caw-',dir=A.scratch_root));D=W/'data';started=False;results=[]
with socket.socket() as sk: sk.bind(('127.0.0.1',0)); port=str(sk.getsockname()[1])
def cmd(a): return subprocess.run(list(map(str,a)),env=E,text=True,capture_output=True,check=True,timeout=120)
def q(sql,check=True):
    with tempfile.TemporaryFile(mode='w+',dir=W) as f:
        f.write(sql); f.seek(0)
        r=subprocess.run([str(A.pg_bin/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=f,capture_output=True,timeout=300)
    if check and r.returncode: raise RuntimeError(r.stderr[-6000:])
    return r
@contextmanager
def held_lock(namespace,key):
    process=subprocess.Popen([str(A.pg_bin/'psql'),'-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        process.stdin.write("BEGIN;SET LOCAL test.own_namespace='"+namespace+"';SELECT pg_advisory_xact_lock(hashtextextended("+key+",0));SELECT 'LOCK_READY';\n");process.stdin.flush()
        while True:
            line=process.stdout.readline()
            if line.strip()=='LOCK_READY':break
            if not line and process.poll()is not None:raise RuntimeError('native lock holder exited:'+process.stderr.read())
        yield
    finally:
        if process.poll()is None:
            process.stdin.write('ROLLBACK;\n\\q\n');process.stdin.flush()
            process.communicate(timeout=10)
def load(p): q('SET check_function_bodies=off;\n'+Path(p).read_text().rstrip()+';\n')
R2="public.fn_settle_accounting_commission_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
R2V3=R2.replace('commission_stage(','commission_stage_v3(')
R3="public.fn_settle_accounting_rakeback_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
def bal(who,col='chip_balance'):
    t='club_members' if col=='chip_balance' else 'agents'
    return f"(SELECT {col} FROM public.{t} WHERE club_id=caw_u('club') AND user_id=caw_u('{who}'))"
BANK="(SELECT chip_treasury FROM public.clubs WHERE id=caw_u('club'))"
def case(name,sql,refusal=None):
    before=q('SELECT caw_money();').stdout.strip()
    r=q('BEGIN;\nSELECT caw_seed('+('true' if 'deleted' in name else 'false')+');\nCREATE TEMP TABLE caw_open AS SELECT caw_balances() b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM public.chip_ledger;\n'+sql+
        ('\nSELECT caw_assert_conserved((SELECT b FROM caw_open));\nSET CONSTRAINTS ALL IMMEDIATE;' if not refusal else '')+'\nROLLBACK;\n',check=False)
    if refusal: assert r.returncode and refusal in r.stderr,(name,r.stdout[-2000:],r.stderr[-4000:])
    else: assert r.returncode==0,(name,r.stdout[-2000:],r.stderr[-6000:])
    assert q('SELECT caw_money();').stdout.strip()==before,(name,'rolled-back case changed financial rows')
    results.append({'case':name,'passed':True,'expected_refusal':refusal})
    print('PASS',name,flush=True)
try:
    assert '17.' in cmd([A.pg_bin/'postgres','--version']).stdout,'PostgreSQL 17 required'
    cmd([A.pg_bin/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    cmd([A.pg_bin/'pg_ctl','-D',D,'-l',W/'server.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off"]);started=True
    load(BASE/'prelude.sql')
    document_root=A.document_source_root or R
    document_dir=document_root/'scripts/qualification/approved-agent-adjustment'
    # Install the current canonical document tables instead of the older
    # weekly-scale copies. No document business owner is substituted.
    excluded={'accounting_invoice_counters','accounting_invoice_deliveries','settlement_invoices','unions','rake_records'}
    schema=(BASE/'schema-tables.sql').read_text().splitlines()
    schema=[line for line in schema if not any(line.startswith('CREATE TABLE public.'+n+'(')or line.startswith('ALTER TABLE public.'+n+' ')or(' ON public.'+n+' ')in line for n in excluded)and not line.startswith('CREATE SEQUENCE IF NOT EXISTS public.hand_id_seq')]
    q('\n'.join(schema))
    # Synthetic club codes are identifiers, not an exercised business owner.
    # Keep the real uniqueness constraint while eliminating random collisions.
    q("CREATE SEQUENCE native_club_codes START 10000 MAXVALUE 99999 NO CYCLE;ALTER TABLE clubs ALTER COLUMN club_id SET DEFAULT nextval('native_club_codes');")
    # Identical PRNG states must not collide in this isolated fixture. These
    # rows roll back; later financial cases retain every original assertion.
    q("BEGIN;SELECT setseed(0.25);INSERT INTO clubs(name)VALUES('Fixture identity A');SELECT setseed(0.25);INSERT INTO clubs(name)VALUES('Fixture identity B');ROLLBACK;")
    platform=(DR/'platform-boundaries.sql').read_text().replace('fn_active_maintenance_release_boundary() RETURNS uuid','fn_active_maintenance_release_boundary() RETURNS timestamptz').replace('SELECT boundary FROM public.dr_controls','SELECT NULL::timestamptz')
    q('SET check_function_bodies=off;'+platform)
    spec=importlib.util.spec_from_file_location('own_actual_documents',document_dir/'document_pipeline.py');document_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(document_module)
    q("ALTER TABLE agents ADD COLUMN role text DEFAULT 'agent',ADD COLUMN status text DEFAULT 'active';ALTER TABLE profiles ADD COLUMN username text;CREATE TABLE engine_maintenance_break(enforce_freeze boolean,announced_at timestamptz,phase text,break_started_at timestamptz,break_ends_at timestamptz);")
    document_owners=document_module.install(lambda text:q(text).stdout.strip(),document_root,document_dir/'fixtures')

    q("DROP FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz);")
    for n in ['fn_caller_is_engine','fn_union_week_start','fn_lock_rakeback_payer_clubs','fn_resolve_accounting_routing_scope','fn_agent_commission_rollup_recompute']: load(BASE/'preimage'/f'{n}.sql')
    for n in ['fn_guard_membership_lifecycle_write','fn_block_browser_balance_writes','fn_club_members_ledger_writer','fn_ca_declare_ledger','fn_ca_chip_ledger_enrich','fn_calculate_cash_rakeback_periods','fn_rakeback_split_write']: load(DR/f'{n}.sql')
    load(F/'schema.sql')
    pre=json.loads((F/'live-preimages-20261022.json').read_text())
    for row in pre:
        q('SET check_function_bodies=off;'+row['definition']+';')
        got=q(f"SELECT md5(pg_get_functiondef('{row['signature']}'::regprocedure));").stdout.strip()
        assert got==row['md5'],('live preimage did not load byte-exact',row['signature'],got)
        q(f"REVOKE ALL ON FUNCTION {row['signature']} FROM PUBLIC,anon,authenticated,service_role;"+(f"GRANT EXECUTE ON FUNCTION {row['signature']} TO service_role;" if row['acl'] and 'service_role=X' in row['acl'] else ''))
    load(F/'triggers.sql');load(DR/'ledger-enrichment-wiring.sql');load(DR/'authority-and-triggers.sql');load(F/'seed.sql')

    q('SET check_function_bodies=off;'+MIG.read_text())
    # Original discharge annotations are empty on this synthetic board; use
    # their actual tables and functions, not a fabricated success response.
    original=(R/'supabase/migrations/20261027034254_existing_player_transfers_discharge_the_same_week_once.sql').read_text()
    section=original[original.index('CREATE TABLE smarter_private.existing_rakeback_transfer_instructions'):original.index('CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(')]
    q("CREATE FUNCTION fn_accounting_agreement_history_immutable()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'accounting_agreement_history_immutable';END$$;")
    q('SET check_function_bodies=off;'+section)
    authorities=json.loads((R/'scripts/qualification/own-agent-v1/original-owners.json').read_text())
    for row in authorities:
        if row['signature'].split('(')[0].split('.')[-1]in ['fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_settle_accounting_rakeback_stage','split_rakeback_payout_complete']:
            q('SET check_function_bodies=off;'+row['definition']+';')
    # Current receipt cache remains a pure original payer read in isolation.
    # Its cache optimization is independently qualified by the maintained suite.
    q("CREATE FUNCTION smarter_private.deleted_reserve_certificate_payers(bigint)RETURNS TABLE(payer_kind text,payer_user uuid,payer_entity uuid,owed numeric)LANGUAGE sql AS $$SELECT*FROM smarter_private.rakeback_certificate_payers($1)$$;")
    case('actual-current-r2-r3-before-v1','SELECT '+R2+';SELECT '+R3+';'+
      f"SELECT caw_assert({bal('P1')}=9 AND {bal('P2')}=4 AND {bal('P3')}=5 AND {bal('P4')}=10,'all original destinations');"+
      f"SELECT caw_assert(({R2})->>'duplicate'='true'AND({R3})->>'duplicate'='true','original replay');")

    # Three independent original scopes yield the six full R2/R3 headers.
    q("CREATE OR REPLACE FUNCTION caw_u(label text)RETURNS uuid LANGUAGE sql STABLE AS $$SELECT md5('commission-agent-wallet:'||coalesce(current_setting('test.own_namespace',true),'')||':'||label)::uuid$$;ALTER FUNCTION caw_alloc(text,text,numeric,text,uuid)STABLE;")
    seed=q("SELECT pg_get_functiondef('caw_seed(boolean)'::regprocedure)").stdout.strip()
    seed=seed.replace("VALUES(true,'2026-08-01');","VALUES(true,'2026-08-01')ON CONFLICT DO NOTHING;")
    seed=seed.replace("c,'Owner rules native',","c,'Owner rules native '||coalesce(current_setting('test.own_namespace',true),''),")
    seed=seed.replace("t WHERE (t->>'amount')::numeric>0;","t WHERE s.club_id=c AND (t->>'amount')::numeric>0;")
    q(seed)
    for namespace in ['old1','old2','old3']:
        q("BEGIN;SET LOCAL test.own_namespace='"+namespace+"';SELECT caw_seed();SELECT "+R2+";SELECT "+R3+";SET CONSTRAINTS ALL IMMEDIATE;COMMIT;")
    q("""CREATE FUNCTION own_paid_proof()RETURNS jsonb LANGUAGE sql STABLE AS $$
    WITH p AS(SELECT x.*FROM rakeback_periods x WHERE period_start='2026-10-05'AND status='paid'),pp AS(SELECT x.*FROM rakeback_period_payouts x JOIN p ON p.id=x.rakeback_period_id),
    rows AS(SELECT'period'k,p.id::text id,md5(p::text)h FROM p UNION ALL SELECT'payout',x.id::text,md5(x::text)FROM pp x
    UNION ALL SELECT'transfer',ROW(t.payout_id,t.payer_kind,t.payer_entity_id)::text,md5(t::text)FROM accounting_rakeback_payer_transfers t JOIN pp ON pp.id=t.payout_id
    UNION ALL SELECT'commission',x.id::text,md5(x::text)FROM agent_commission_settlements x WHERE period_start='2026-10-05 07:00Z'
    UNION ALL SELECT'round',ROW(r.scope_kind,r.scope_id,r.round_no)::text,md5(r::text)FROM accounting_routed_settlement_runs r WHERE period_start='2026-10-05 07:00Z')
    SELECT jsonb_object_agg(k,v)FROM(SELECT k,jsonb_build_object('count',count(*),'md5',md5(string_agg(h,''ORDER BY id,h)))v FROM rows GROUP BY k)x $$;
    CREATE TABLE own_original_paid AS SELECT own_paid_proof()five,(SELECT jsonb_agg(to_jsonb(r)ORDER BY scope_kind,scope_id,round_no)FROM accounting_routed_settlement_runs r)six,
     (SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_rakeback_period_calculations c)certs,
     (SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_cash_rake_sources c)sources;
    SELECT caw_assert((SELECT jsonb_array_length(six)=6 FROM own_original_paid),'six exact original headers');
    """)
    # Compose the protected original phase owner before typed R2/R3. Its
    # actual private capability is exercised below, not bypassed by a GUC.
    phase_root=A.pause_source_root or R
    for version,name in [('20260907044041','fn_union_prev_week_start'),('20260914110557','fn_union_accounting_run_at')]:
        text=next((R/'supabase/migrations').glob(version+'_*')).read_text();start=text.index('CREATE OR REPLACE FUNCTION public.'+name+'(');end=text.index('$function$;',start)+len('$function$;');q(text[start:end])
    q("CREATE PUBLICATION supabase_realtime;CREATE TABLE engine_table_leases(table_id uuid PRIMARY KEY,instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY,instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);")
    for row in json.loads((phase_root/'scripts/ci/fixtures/weekly-payout-owned-phase/owner-authority.json').read_text()):
        sig=row['signature'];q('SET check_function_bodies=off;'+row['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'if any(x.startswith('service_role=X')for x in row['acl'])else''))
    q('SET check_function_bodies=off;'+next((phase_root/'supabase/migrations').glob('20261028162126_*')).read_text())
    for patch in json.loads((R/'scripts/qualification/own-agent-v1/pause-owner-patches.json').read_text()):
        assert q("SELECT md5(pg_get_functiondef('"+patch['signature']+"'::regprocedure))").stdout.strip()==patch['postimage']
    # Install the source candidate over those real paid receipts.
    q("""CREATE TABLE accounting_agreement_history(id bigint PRIMARY KEY,entity_type text,entity_key text,club_id uuid,subject_user_id uuid,observed_at timestamptz,transaction_id bigint,after_terms jsonb);
    CREATE TABLE accounting_cash_atomic_contract_admissions(source_id uuid PRIMARY KEY,admitted_contract jsonb,admitted_at timestamptz);
    CREATE TABLE accounting_cash_funding_contract_admissions(source_id uuid PRIMARY KEY,funding_club_id uuid,admitted_contract jsonb,admitted_at timestamptz);
    CREATE VIEW accounting_effective_cash_rake_sources AS SELECT*FROM accounting_cash_rake_sources;
    CREATE TABLE ca_ledger_maintenance_kinds(kind text PRIMARY KEY,note text,severity text);
    CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs()RETURNS TABLE(club_id uuid,cutoff_at timestamptz)LANGUAGE sql AS $$SELECT NULL::uuid,NULL::timestamptz WHERE false$$;
    """)
    q("CREATE TABLE ca_declared_money_triggers(table_name text NOT NULL,trigger_name text NOT NULL,declared_at timestamptz NOT NULL DEFAULT now(),note text,PRIMARY KEY(table_name,trigger_name))")
    H=R/'supabase/accounting/own-agent-v1'
    for row in authorities:
        if row['signature'].split('(')[0]in ['fn_accounting_agent_terms_at','fn_accounting_terms_at','fn_post_accounting_commission_source']:
            q('SET check_function_bodies=off;'+row['definition']+';')
    changed_names={'fn_accounting_earning_contract','fn_calculate_cash_rakeback_periods','fn_rakeback_split_check','fn_rakeback_split_write','fn_prepare_accounting_week','fn_accounting_tournament_commission_source_guard','fn_accounting_union_earned_plan_sets','fn_accounting_union_earned_plan_window','fn_ca_rakeback_payout_leg_is_documented','ca_player_stats_financial_report','fn_ca_settlement_correctness_check'}
    for row in authorities:
        if row['signature'].split('(')[0].split('.')[-1]in changed_names:
            sig=row['signature'];grants=''
            for acl in row['acl']or[]:
                role=acl.split('=')[0]
                if role!='postgres'and'X'in acl.split('=')[1].split('/')[0]:grants+='GRANT EXECUTE ON FUNCTION '+sig+' TO '+role+';'
            q('SET check_function_bodies=off;'+row['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'+grants)
    # Current source views and their original ACLs precede the whole installer.
    for view in json.loads((R/'scripts/qualification/own-agent-v1/original-views.json').read_text()):
        q('CREATE OR REPLACE VIEW public.'+view['name']+' AS '+view['definition'].rstrip().rstrip(';')+';REVOKE ALL ON public.'+view['name']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT SELECT ON public.'+view['name']+' TO service_role;'if any(x.startswith('service_role=')for x in view['acl'])else''))
    q("CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text,updated_at timestamptz DEFAULT now(),declared_ref text,declared_at timestamptz);CREATE TABLE ca_guard_def_history(id bigserial PRIMARY KEY,proname text,def_hash text,def_text text,captured_at timestamptz DEFAULT now(),UNIQUE(proname,def_hash));")
    for row in json.loads((R/'scripts/ci/fixtures/historical-rakeback-guard-declaration-preimages.json').read_text()):q('SET check_function_bodies=off;'+row['definition']+';')
    q("SELECT fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check','native original owner');INSERT INTO supabase_migrations.schema_migrations(version)VALUES('20261028162126');UPDATE dr_controls SET generation='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20';")
    if not A.compile_fragments:
        candidate=A.candidate_migration.read_text()
        # Every injected installer fault must roll the entire DDL transaction
        # back over original paid books, including a post-DDL failure.
        for fault,broken,error in [
            ('missing-phase-history',candidate.replace("version='20261028162126'","version='00000000000000'",1),'own_agent_owned_phase_dependency_missing'),
            ('wrong-original-generation',candidate.replace('original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20','original-inventory-245-v1:invalid',1),'own_agent_original_inventory_authority_changed'),
            ('changed-original-owner',candidate.replace('62c444b0953cced8a4f3144fc86af51b','00000000000000000000000000000000',1),'own_agent_owner_preimage_changed'),
            ('post-DDL-hash-failure',candidate.replace(json.loads((R/'scripts/qualification/own-agent-v1/source-binding.json').read_text())['postimages'][0]['md5'],'00000000000000000000000000000000'),'own_agent_owner_postimage_changed'),
        ]:
            before=q('SELECT caw_money();').stdout.strip()
            failed=q('SET check_function_bodies=off;'+broken,check=False)
            assert failed.returncode and error in failed.stderr,(fault,failed.stderr[-3000:])
            assert q("SELECT to_regclass('public.accounting_rakeback_wallet_contracts')IS NULL").stdout.strip()=='t'
            assert q('SELECT caw_money();').stdout.strip()==before
            results.append({'case':'whole-installer-rollback-'+fault,'passed':True,'expected_refusal':error})
        q('SET check_function_bodies=off;'+candidate)
        proof=next(x.split(': ',1)[1]for x in candidate.splitlines()if x.startswith('-- @live-proof: '))
        assert q('SELECT '+proof).stdout.strip()=='t'
        replay=q('SET check_function_bodies=off;'+candidate,check=False)
        assert replay.returncode and 'own_agent_owner_preimage_changed'in replay.stderr
        results.append({'case':'whole-original-phase-bound-typed-installer-and-live-proof-metadata-and-replay-refusal','passed':True})
    else:
        for name in ['earning-contract','destination-contract','unpaid-interpretation','effective-views','typed-receipts','fn_accounting_tournament_commission_source_guard','fn_accounting_union_earned_plan_sets','fn_accounting_union_earned_plan_window','fn_calculate_cash_rakeback_periods','fn_rakeback_split_check','fn_rakeback_split_write','fn_prepare_accounting_week','fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_settle_accounting_rakeback_stage','deferred-proof','ca_player_stats_financial_report','fn_ca_settlement_correctness_check','weekly_payout_prepare_due']:
            q('SET check_function_bodies=off;'+(H/(name+'.sql')).read_text().rstrip()+';')
        q("UPDATE smarter_private.weekly_payout_phase_configuration SET cutover_period_end='2026-10-12 07:00Z';")
    for namespace in ['old1','old2','old3']:
        q("BEGIN;SET LOCAL test.own_namespace='"+namespace+"';SELECT caw_assert((smarter_private.prepare_own_agent_interpretation(NULL,caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z'))->>'legacy_paid'='true','original R0 paid book stays legacy');SELECT caw_assert(("+R2+")->>'duplicate'='true'AND("+R3+")->>'duplicate'='true','v1 installer preserves original replay');SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;")
    q("""SELECT caw_assert((SELECT five=own_paid_proof()AND six=(SELECT jsonb_agg(to_jsonb(r)ORDER BY scope_kind,scope_id,round_no)FROM accounting_routed_settlement_runs r)AND certs=(SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_rakeback_period_calculations c)AND sources=(SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_cash_rake_sources c)FROM own_original_paid),'all five full hashes/six headers/raw source/certificates unchanged');
    SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_own_agent_interpretations)AND NOT EXISTS(SELECT FROM accounting_own_agent_preparation_versions)AND NOT EXISTS(SELECT FROM accounting_rakeback_wallet_transfers),'no paid book upgraded or delta minted');""")
    results.append({'case':'candidate-preserves-three-original-paid-books-five-hashes-six-headers-raw-certificates-and-replay','passed':True})

    # The actual append-only owner records each replaced pending journal row.
    for row in json.loads((R/'scripts/ci/fixtures/unpaid-atomic-cash-contract-columns.json').read_text()):
        if row['table_name']=='ca_ledger_mutation_log':q('CREATE TABLE '+row['table_name']+'('+row['columns']+')')
    for row in json.loads((R/'scripts/ci/fixtures/unpaid-atomic-cash-contract-dependencies.json').read_text())['definitions']:
        if row['signature']=='fn_ca_journal_append_only()':q('SET check_function_bodies=off;'+row['definition']+';')
    q(next(row['definition']for row in authorities if row['signature']=='fn_accounting_agreement_history_immutable()')+';')
    q("CREATE TRIGGER own_commission_append_only BEFORE UPDATE OR DELETE ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only();CREATE TRIGGER own_cash_immutable BEFORE UPDATE OR DELETE ON accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();CREATE TRIGGER own_fee_immutable BEFORE UPDATE OR DELETE ON accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();")
    # Native source admission uses actual history, cash disposition/attribution
    # plan, source guard and commission posting. Only unrelated full-week
    # source-evidence/launch prerequisites remain controlled in isolation.
    q("""ALTER TABLE agents ADD COLUMN parent_agent_id uuid,ADD COLUMN commission_rate numeric,ADD COLUMN player_rakeback_rate numeric,ADD COLUMN lifetime_rake_generated numeric DEFAULT 0,ADD COLUMN weekly_rake_generated numeric DEFAULT 0,ADD COLUMN last_active_at timestamptz;
    CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,computed_at timestamptz DEFAULT now());
    CREATE TABLE accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,certified_at timestamptz DEFAULT now());
    CREATE TABLE accounting_recompute_split_parts(club_id uuid,period_start date,period_end date,kind text,part int,value jsonb);
    CREATE TABLE accounting_period_recompute_requests(id uuid DEFAULT gen_random_uuid(),club_id uuid,period_start date,period_end date,status text DEFAULT 'pending',reason text,last_result jsonb DEFAULT '{}',last_requested_at timestamptz DEFAULT now(),UNIQUE(club_id,period_start,period_end));
    CREATE TABLE union_wallet_transactions(id uuid,union_id uuid,amount numeric,created_at timestamptz,wallet text,direction text,tx_type text);
    CREATE FUNCTION fn_ca_launch_rakeback_period_waived(uuid)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION fn_accounting_clubs_scope_digest()RETURNS text LANGUAGE sql AS $$SELECT 'native-controlled-fullperiod-prerequisite'$$;
    CREATE FUNCTION fn_accounting_commit_horizon()RETURNS timestamptz LANGUAGE sql AS $$SELECT now()$$;
    CREATE FUNCTION fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{"status":"ready"}'::jsonb$$;
    CREATE FUNCTION fn_cash_period_evidence_since(uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)RETURNS TABLE(o_evidence bigint,o_incomplete bigint,o_drifted bigint,o_settled_records bigint,o_settled_evidence bigint,o_settled_incomplete bigint,o_settled_drifted bigint)LANGUAGE sql AS $$SELECT 0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint$$;
    """)
    for row in authorities:
        if row['signature'].split('(')[0]in ['fn_accounting_cash_commission_plan','fn_accounting_cash_commission_source_guard']:
            q('SET check_function_bodies=off;'+row['definition']+';')
        if row['signature'].split('(')[0]=='fn_accounting_earning_contract':
            q(row['definition'].replace('public.fn_accounting_earning_contract(','public.own_original_earning_contract(')+';')
    q("CREATE TRIGGER own_cash_commission_source_guard BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_commission_source_guard();")
    fee_owner=(R/'supabase/migrations/20260927155651_held_tournament_fees_are_recognized_on_the_owner_host_club_b.sql').read_text()
    q('SET check_function_bodies=off;'+fee_owner[fee_owner.index('CREATE FUNCTION public.fn_accounting_tournament_owner_basis_terms_at'):fee_owner.index('REVOKE ALL ON FUNCTION public.fn_accounting_tournament_owner_basis_terms_at')])
    q(next(row['definition']for row in authorities if row['signature'].startswith('fn_accounting_tournament_source_terms_at('))+';')
    payer_source=(R/'supabase/migrations/20261019213557_weekly_rakeback_preserves_every_historical_payer_share.sql').read_text()
    q(payer_source[payer_source.index('CREATE FUNCTION smarter_private.record_rakeback_payer_contracts()'):payer_source.index('REVOKE ALL ON FUNCTION smarter_private.record_rakeback_payer_contracts()')])
    q('CREATE TRIGGER accounting_rakeback_payer_contracts_at_calculation AFTER INSERT ON accounting_rakeback_period_calculations FOR EACH ROW EXECUTE FUNCTION smarter_private.record_rakeback_payer_contracts();')
    q(next(row['definition']for row in authorities if row['signature'].startswith('fn_accounting_tournament_fee_net_plan('))+';')
    q('CREATE TRIGGER own_fee_commission_source_guard BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_commission_source_guard();')
    load(R/'scripts/ci/fixtures/own-agent-v1/playing-source.sql')
    # Reuse the maintained canonical approved-settler and real BUSINESS/AGENT
    # synchronization owner. Approval input is synthetic; the canonical helper
    # itself, its exact payload and replay are executed unchanged.
    money=json.loads((R/'scripts/qualification/approved-agent-adjustment/fixtures/money-component-owners.json').read_text())
    manual=next(t for t in money['tables']if t['name']=='ca_manual_adjustments')
    cols=','.join('"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in manual['columns'])
    q('CREATE TABLE ca_manual_adjustments('+cols+');')
    for c in manual['constraints']or[]:
        if not c['definition'].startswith(('FOREIGN KEY','TRIGGER')):q('ALTER TABLE ca_manual_adjustments ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
    q("ALTER TABLE agents ADD COLUMN business_balance numeric DEFAULT 0,ADD COLUMN player_wallet_balance numeric DEFAULT 0,ADD COLUMN player_balance numeric DEFAULT 0,ADD COLUMN promo_balance numeric DEFAULT 0;UPDATE agents SET business_balance=agent_wallet_balance,role=coalesce(role,'agent'),status=coalesce(status,'active');")
    agent_table=next(t for t in money['tables']if t['name']=='agents')
    sync=next(t for t in agent_table['execution']if t['signature'].startswith('sync_agent_wallet_columns('))
    q('SET check_function_bodies=off;'+sync['definition']+';'+sync['trigger']+';')
    helper_source=(R/'supabase/migrations/20261028153553_approved_agent_adjustments_settle_once_from_the_club_bank.sql').read_text()
    q(helper_source[helper_source.index('CREATE OR REPLACE FUNCTION public.fn_ca_settle_approved_agent_adjustment'):helper_source.index('REVOKE ALL ON FUNCTION public.fn_ca_settle_approved_agent_adjustment')])
    followup=next((document_root/'supabase/migrations').glob('20261028183252_*')).read_text();q(followup)
    earned=next((document_root/'supabase/migrations').glob('20261028193243_*')).read_text();q(earned[:earned.index('DO $audit$')]+'COMMIT;')
    assert q("SELECT md5(pg_get_functiondef('fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))").stdout.strip()=='d94aa86c87d179e8134b938e406b926a'
    correction_call="fn_ca_settle_approved_agent_adjustment(caw_u('correction'),caw_u('club'),jsonb_build_object('club_id',caw_u('club'),'approved_adjustment',(SELECT to_jsonb(a)-'status'FROM ca_manual_adjustments a WHERE id=caw_u('correction'))))"
    before=q('SELECT caw_money();').stdout.strip()
    q("BEGIN;SET LOCAL test.own_namespace='old1';CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM chip_ledger;INSERT INTO ca_manual_adjustments(id,actor,approver,reason,amount,target_kind,target_id,status,approved_at,actor_label,approver_label)VALUES(caw_u('correction'),'00000000-0000-0000-0000-00000000c1a9','2d1cd6c3-5700-4af9-a271-d4863fdab20d','Synthetic approved original own-agent shortfall correction',6.43,'agent_wallet',caw_u('A'),'approved','2026-09-16','Automated standing approval authorship','Original platform approval');SELECT "+correction_call+";SELECT caw_assert(("+correction_call+")->>'replayed'='true','canonical correction itself exactly once');SELECT caw_assert((smarter_private.prepare_own_agent_interpretation(NULL,caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z'))->>'legacy_paid'='true','manual correction does not reopen original R0');SELECT caw_assert(("+R2+")->>'duplicate'='true'AND("+R3+")->>'duplicate'='true','v1 never mints corrected own-agent delta again');SELECT caw_assert((SELECT five=own_paid_proof()FROM own_original_paid),'all5 original receipts after canonical correction and original replay');SELECT caw_assert_conserved((SELECT b FROM caw_open));SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;")
    assert q('SELECT caw_money();').stdout.strip()==before
    results.append({'case':'canonical-approved-manual-correction-present-original-paid-R0-R2-R3-never-mint-delta-again','passed':True})
    # Controlled original phase certificate/clock only: fleet parking is
    # independently qualified by its maintained engine/protocol suite.
    q("""UPDATE smarter_private.weekly_payout_phase_configuration SET cutover_period_end='2026-10-26 07:00Z';
    CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_clock()RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$SELECT public.fn_union_accounting_run_at('2026-10-26 07:00Z')+interval '1 second'$$;
    CREATE FUNCTION own_pause_round(n int)RETURNS void LANGUAGE plpgsql AS $$DECLARE due timestamptz:=fn_union_accounting_run_at('2026-10-26 07:00Z');BEGIN
     INSERT INTO weekly_accounting_payout_pauses(run_id,period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan,phase,acknowledged_at)
     VALUES(caw_u('pause-run'),'2026-10-19 07:00Z','2026-10-26 07:00Z',due-interval '2 minutes',due,due+interval '240 seconds',due+interval '5 minutes',jsonb_build_array(jsonb_build_object('kind','club','id',caw_u('club'),'period_start','2026-10-19T07:00:00Z','period_end','2026-10-26T07:00:00Z')),'paying',due-interval '1 minute')ON CONFLICT(period_start,period_end)DO NOTHING;
     INSERT INTO smarter_private.weekly_payout_owned_transactions(backend_pid,transaction_id,run_id,scope_kind,scope_id,period_start,period_end,round_no)VALUES(pg_backend_pid(),txid_current(),caw_u('pause-run'),'club',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z',n)ON CONFLICT(backend_pid,transaction_id)DO UPDATE SET round_no=excluded.round_no;
    END $$;
    """)
    deadline=(R/'supabase/migrations/20260928164258_a_weekly_close_proves_each_book_once_and_never_holds_a_long_.sql').read_text();start=deadline.index('CREATE FUNCTION public.fn_weekly_accounting_deadline_check()');end=deadline.index('$function$;',start)+len('$function$;');q(deadline[start:end])
    prep="smarter_private.prepare_own_agent_interpretation(NULL,caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z')"
    calc="fn_rakeback_split_write(caw_u('club'),'2026-10-19','2026-10-25',ARRAY[caw_u('A')])"
    nr2=R2.replace('2026-10-05','2026-10-19').replace('2026-10-12','2026-10-26')
    nr3=R3.replace('2026-10-05','2026-10-19').replace('2026-10-12','2026-10-26')
    legacy_write=next(row['definition']for row in authorities if row['signature'].startswith('fn_rakeback_split_write(')).rstrip()+';'
    candidate_write=(H/'fn_rakeback_split_write.sql').read_text().rstrip()+';'
    q("BEGIN;SET LOCAL test.own_namespace='new-playing';SELECT own_playing_seed();CREATE TEMP TABLE own_raw_before AS SELECT md5(jsonb_agg(to_jsonb(s)ORDER BY id)::text)h FROM accounting_cash_rake_sources s;CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM chip_ledger;"
      +"SELECT caw_assert((SELECT count(*)=0 FROM agent_commissions WHERE user_id=caw_u('A')),'old producer omitted the playing agent');"
      +legacy_write+";SELECT "+calc+";CREATE TEMP TABLE own_unpaid_cert_before AS SELECT id,md5(to_jsonb(c)::text)h FROM accounting_rakeback_period_calculations c WHERE c.club_id=caw_u('club');"+candidate_write+";INSERT INTO accounting_close_partials VALUES('earned_plan_window',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','{\"original_unpaid_stamp\":true}');INSERT INTO accounting_close_certificates VALUES('earned_plan',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z','{\"original_unpaid_stamp\":true}');INSERT INTO accounting_recompute_split_parts VALUES(caw_u('club'),'2026-10-19','2026-10-25','original',0,'{\"original_unpaid_stamp\":true}');"
      +"SELECT caw_assert(("+prep+")->>'ready'='true','original bounded R0 admits old unpaid source');"
      +"SELECT caw_assert((SELECT count(*)=1 FROM accounting_own_agent_interpretations),'one genuine versioned source interpretation');"
      +"SELECT caw_assert((SELECT count(*)=2 FROM jsonb_array_elements((SELECT original_commissions FROM accounting_own_agent_interpretations))),'original two pending commissions preserved');"
      +"SELECT caw_assert((SELECT jsonb_agg(old_row ORDER BY old_row->>'id')FROM ca_ledger_mutation_log WHERE source_table='agent_commissions'AND operation='DELETE')=(SELECT original_commissions FROM accounting_own_agent_interpretations),'actual append-only journal preserved exact old rows');"
      +"SELECT caw_assert((SELECT md5(jsonb_agg(to_jsonb(s)ORDER BY id)::text)=(SELECT h FROM own_raw_before)FROM accounting_cash_rake_sources s),'raw source full rows unchanged');"
      +"SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_close_partials WHERE union_id=caw_u('club'))AND NOT EXISTS(SELECT FROM accounting_close_certificates WHERE union_id=caw_u('club'))AND NOT EXISTS(SELECT FROM accounting_recompute_split_parts WHERE club_id=caw_u('club')),'genuine original unpaid cache invalidation');SELECT caw_assert((SELECT jsonb_array_length(original_partials)=1 AND jsonb_array_length(original_certificates)=1 FROM accounting_own_agent_preparation_versions),'versioned original proof hashes retained');SELECT "+calc+";SELECT caw_assert(NOT EXISTS(SELECT FROM own_unpaid_cert_before o LEFT JOIN accounting_rakeback_period_calculations c ON c.id=o.id WHERE c.id IS NULL OR md5(to_jsonb(c)::text)<>o.h),'original unpaid certificate appended, never rewritten');SELECT caw_assert((SELECT rakeback_amount=1.40 FROM rakeback_periods WHERE club_id=caw_u('club')AND user_id=caw_u('A')),'owner70 intact and own ordinary earnings not duplicated in PLAYER');"
      +"SELECT own_pause_round(2);SELECT "+nr2+";SELECT own_pause_round(3);SELECT "+nr3+";SET CONSTRAINTS ALL IMMEDIATE;DELETE FROM smarter_private.weekly_payout_owned_transactions;UPDATE weekly_accounting_payout_pauses SET phase='released';"
      +f"SELECT caw_assert({bal('A')}=1000.70 AND {bal('A','agent_wallet_balance')}=30.70 AND {bal('S','agent_wallet_balance')}=14 AND {BANK}=954.60,'independently fixed full R2/R3 balances');"
      +"SELECT caw_assert((SELECT count(*)=2 AND sum(amount)=1.40 AND count(DISTINCT destination_kind)=2 FROM accounting_rakeback_wallet_transfers),'same payer two destination receipts');"
      +"SELECT caw_assert((SELECT bool_and(smarter_private.rakeback_wallet_payout_complete(p.id,c.id))FROM rakeback_period_payouts p JOIN accounting_rakeback_period_calculations c ON c.id=(SELECT max(z.id)FROM accounting_rakeback_period_calculations z WHERE z.period_id=p.rakeback_period_id) WHERE p.club_id=caw_u('club')),'typed deferred full proof');"
      +"SELECT caw_assert(("+nr2+")->>'duplicate'='true'AND("+nr3+")->>'duplicate'='true','new typed replay exactly once');SELECT caw_assert_conserved((SELECT b FROM caw_open));ROLLBACK;")
    q("BEGIN;SET LOCAL test.own_namespace='new-playing-fee';SELECT own_playing_seed(true);CREATE TEMP TABLE own_raw_before AS SELECT md5(jsonb_agg(to_jsonb(s)ORDER BY id)::text)h FROM accounting_cash_rake_sources s;CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM chip_ledger;"
      +"SELECT caw_assert((SELECT count(*)=0 FROM agent_commissions WHERE user_id=caw_u('A')),'old producer omitted the playing agent');"
      +legacy_write+";SELECT "+calc+";CREATE TEMP TABLE own_unpaid_cert_before AS SELECT id,md5(to_jsonb(c)::text)h FROM accounting_rakeback_period_calculations c WHERE c.club_id=caw_u('club');"+candidate_write+";INSERT INTO accounting_close_partials VALUES('earned_plan_window',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','{\"original_unpaid_stamp\":true}');INSERT INTO accounting_close_certificates VALUES('earned_plan',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z','{\"original_unpaid_stamp\":true}');INSERT INTO accounting_recompute_split_parts VALUES(caw_u('club'),'2026-10-19','2026-10-25','original',0,'{\"original_unpaid_stamp\":true}');"
      +"SELECT caw_assert(("+prep+")->>'ready'='true','original bounded R0 admits old unpaid source');"
      +"SELECT caw_assert((SELECT count(*)=1 FROM accounting_own_agent_interpretations),'one genuine versioned source interpretation');"
      +"SELECT caw_assert((SELECT count(*)=2 FROM jsonb_array_elements((SELECT original_commissions FROM accounting_own_agent_interpretations))),'original two pending commissions preserved');"
      +"SELECT caw_assert((SELECT jsonb_agg(old_row ORDER BY old_row->>'id')FROM ca_ledger_mutation_log WHERE source_table='agent_commissions'AND operation='DELETE')=(SELECT original_commissions FROM accounting_own_agent_interpretations),'actual append-only journal preserved exact old rows');"
      +"SELECT caw_assert((SELECT md5(jsonb_agg(to_jsonb(s)ORDER BY id)::text)=(SELECT h FROM own_raw_before)FROM accounting_cash_rake_sources s),'raw source full rows unchanged');"
      +"SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_close_partials WHERE union_id=caw_u('club'))AND NOT EXISTS(SELECT FROM accounting_close_certificates WHERE union_id=caw_u('club'))AND NOT EXISTS(SELECT FROM accounting_recompute_split_parts WHERE club_id=caw_u('club')),'genuine original unpaid cache invalidation');SELECT caw_assert((SELECT jsonb_array_length(original_partials)=1 AND jsonb_array_length(original_certificates)=1 FROM accounting_own_agent_preparation_versions),'versioned original proof hashes retained');SELECT "+calc+";SELECT caw_assert(NOT EXISTS(SELECT FROM own_unpaid_cert_before o LEFT JOIN accounting_rakeback_period_calculations c ON c.id=o.id WHERE c.id IS NULL OR md5(to_jsonb(c)::text)<>o.h),'original unpaid certificate appended, never rewritten');SELECT caw_assert((SELECT rakeback_amount=1.40 FROM rakeback_periods WHERE club_id=caw_u('club')AND user_id=caw_u('A')),'owner70 intact and own ordinary earnings not duplicated in PLAYER');"
      +"SELECT own_pause_round(2);SELECT "+nr2+";SELECT own_pause_round(3);SELECT "+nr3+";SET CONSTRAINTS ALL IMMEDIATE;DELETE FROM smarter_private.weekly_payout_owned_transactions;UPDATE weekly_accounting_payout_pauses SET phase='released';"
      +f"SELECT caw_assert({bal('A')}=1000.70 AND {bal('A','agent_wallet_balance')}=30.70 AND {bal('S','agent_wallet_balance')}=14 AND {BANK}=954.60,'independently fixed full R2/R3 balances');"
      +"SELECT caw_assert((SELECT count(*)=2 AND sum(amount)=1.40 AND count(DISTINCT destination_kind)=2 FROM accounting_rakeback_wallet_transfers),'same payer two destination receipts');"
      +"SELECT caw_assert((SELECT bool_and(smarter_private.rakeback_wallet_payout_complete(p.id,c.id))FROM rakeback_period_payouts p JOIN accounting_rakeback_period_calculations c ON c.id=(SELECT max(z.id)FROM accounting_rakeback_period_calculations z WHERE z.period_id=p.rakeback_period_id) WHERE p.club_id=caw_u('club')),'typed deferred full proof');"
      +"SELECT caw_assert(("+nr2+")->>'duplicate'='true'AND("+nr3+")->>'duplicate'='true','new typed replay exactly once');SELECT caw_assert_conserved((SELECT b FROM caw_open));ROLLBACK;")
    q("BEGIN;SET LOCAL test.own_namespace='new-playing-suspended';SELECT own_playing_seed();UPDATE agents SET status='suspended'WHERE user_id=caw_u('A');CREATE TEMP TABLE own_raw_before AS SELECT md5(jsonb_agg(to_jsonb(s)ORDER BY id)::text)h FROM accounting_cash_rake_sources s;CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM chip_ledger;"
      +"SELECT caw_assert((SELECT count(*)=0 FROM agent_commissions WHERE user_id=caw_u('A')),'old producer omitted the playing agent');"
      +legacy_write+";SELECT "+calc+";CREATE TEMP TABLE own_unpaid_cert_before AS SELECT id,md5(to_jsonb(c)::text)h FROM accounting_rakeback_period_calculations c WHERE c.club_id=caw_u('club');"+candidate_write+";INSERT INTO accounting_close_partials VALUES('earned_plan_window',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','{\"original_unpaid_stamp\":true}');INSERT INTO accounting_close_certificates VALUES('earned_plan',caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z','{\"original_unpaid_stamp\":true}');INSERT INTO accounting_recompute_split_parts VALUES(caw_u('club'),'2026-10-19','2026-10-25','original',0,'{\"original_unpaid_stamp\":true}');"
      +"SELECT caw_assert(("+prep+")->>'ready'='true','original bounded R0 admits old unpaid source');"
      +"SELECT caw_assert((SELECT count(*)=1 FROM accounting_own_agent_interpretations),'one genuine versioned source interpretation');"
      +"SELECT caw_assert((SELECT count(*)=2 FROM jsonb_array_elements((SELECT original_commissions FROM accounting_own_agent_interpretations))),'original two pending commissions preserved');"
      +"SELECT caw_assert((SELECT jsonb_agg(old_row ORDER BY old_row->>'id')FROM ca_ledger_mutation_log WHERE source_table='agent_commissions'AND operation='DELETE')=(SELECT original_commissions FROM accounting_own_agent_interpretations),'actual append-only journal preserved exact old rows');"
      +"SELECT caw_assert((SELECT md5(jsonb_agg(to_jsonb(s)ORDER BY id)::text)=(SELECT h FROM own_raw_before)FROM accounting_cash_rake_sources s),'raw source full rows unchanged');"
      +"SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_close_partials WHERE union_id=caw_u('club'))AND NOT EXISTS(SELECT FROM accounting_close_certificates WHERE union_id=caw_u('club'))AND NOT EXISTS(SELECT FROM accounting_recompute_split_parts WHERE club_id=caw_u('club')),'genuine original unpaid cache invalidation');SELECT caw_assert((SELECT jsonb_array_length(original_partials)=1 AND jsonb_array_length(original_certificates)=1 FROM accounting_own_agent_preparation_versions),'versioned original proof hashes retained');SELECT "+calc+";SELECT caw_assert(NOT EXISTS(SELECT FROM own_unpaid_cert_before o LEFT JOIN accounting_rakeback_period_calculations c ON c.id=o.id WHERE c.id IS NULL OR md5(to_jsonb(c)::text)<>o.h),'original unpaid certificate appended, never rewritten');SELECT caw_assert((SELECT rakeback_amount=1.40 FROM rakeback_periods WHERE club_id=caw_u('club')AND user_id=caw_u('A')),'owner70 intact and own ordinary earnings not duplicated in PLAYER');"
      +"SELECT own_pause_round(2);SELECT "+nr2+";SELECT own_pause_round(3);SELECT "+nr3+";SET CONSTRAINTS ALL IMMEDIATE;DELETE FROM smarter_private.weekly_payout_owned_transactions;UPDATE weekly_accounting_payout_pauses SET phase='released';"
      +f"SELECT caw_assert({bal('A')}=1000.70 AND {bal('A','agent_wallet_balance')}=30.70 AND {bal('S','agent_wallet_balance')}=14 AND {BANK}=954.60,'independently fixed full R2/R3 balances');"
      +"SELECT caw_assert((SELECT count(*)=2 AND sum(amount)=1.40 AND count(DISTINCT destination_kind)=2 FROM accounting_rakeback_wallet_transfers),'same payer two destination receipts');"
      +"SELECT caw_assert((SELECT bool_and(smarter_private.rakeback_wallet_payout_complete(p.id,c.id))FROM rakeback_period_payouts p JOIN accounting_rakeback_period_calculations c ON c.id=(SELECT max(z.id)FROM accounting_rakeback_period_calculations z WHERE z.period_id=p.rakeback_period_id) WHERE p.club_id=caw_u('club')),'typed deferred full proof');"
      +"SELECT caw_assert(("+nr2+")->>'duplicate'='true'AND("+nr3+")->>'duplicate'='true','new typed replay exactly once');SELECT caw_assert((SELECT status='suspended'AND agent_wallet_balance=business_balance FROM agents WHERE user_id=caw_u('A')),'suspended historical earner credited with unchanged suspension and BUSINESS alias');SELECT caw_assert_conserved((SELECT b FROM caw_open));ROLLBACK;")
    results.append({'case':'historically-active-currently-suspended-own-agent-credited-and-status-preserved','passed':True})
    results.extend([{'case':'actual-old-unpaid-cash-R0-full-R2-R3-same-payer-two-wallet-legs','passed':True},{'case':'actual-old-unpaid-recognized-fee-R0-full-R2-R3-same-payer-two-wallet-legs','passed':True}])
    # Earlier producer boundary: a truly legacy-paid own0 source must retain
    # its raw capture receipt even though the new producer derives own tiers.
    for row in authorities:
        if row['signature'].split('(')[0]in ['fn_accrue_cash_hand_commissions','fn_capture_accounting_tournament_fee','fn_stamp_accounting_tournament_fee','fn_recognize_accounting_tournament_fees']:
            q('SET check_function_bodies=off;'+row['definition']+';')
    recognition_lock=(R/'supabase/migrations/20260929031311_an_accrual_shares_the_weekly_lane_the_close_owns_it.sql').read_text();start=recognition_lock.index('CREATE OR REPLACE FUNCTION public.fn_lock_accounting_tournament_recognition_week(');end=recognition_lock.index('CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(',start);q('SET check_function_bodies=off;'+recognition_lock[start:end])
    q('CREATE TABLE IF NOT EXISTS tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,is_private boolean DEFAULT true);')
    patches=json.loads((R/'scripts/qualification/own-agent-v1/pause-owner-patches.json').read_text())
    original_stages='';current_stages=''
    for patch in patches:
        name=patch['signature'].split('(')[0].split('.')[-1]
        definition=next(row['definition']for row in authorities if row['signature'].split('(')[0].split('.')[-1]==name)
        for pair in patch['replacements']:assert definition.count(pair['old'])==1;definition=definition.replace(pair['old'],pair['new'])
        original_stages+=definition.rstrip()+';'
        current_stages+=(H/(name+'.sql')).read_text().rstrip()+';'
    for fee in [False,True]:
        replay=("fn_stamp_accounting_tournament_fee(caw_u('own-record-3'))"if fee else"fn_accrue_cash_hand_commissions(caw_u('own-hand-3'))")
        recognition="SELECT caw_assert((fn_recognize_accounting_tournament_fees(caw_u('event'),transaction_timestamp(),caw_u('club'),NULL,caw_u('fee-bank')))->>'replayed'='true','unchanged original recognition replay');"if fee else''
        q("BEGIN;SET LOCAL test.own_namespace='legacy-producer-"+str(fee)+"';SELECT own_playing_seed("+('true'if fee else'false')+");"+legacy_write+original_stages+'SELECT '+calc+";SELECT own_pause_round(2);SELECT "+nr2+";SELECT own_pause_round(3);SELECT "+nr3+";SET CONSTRAINTS ALL IMMEDIATE;DELETE FROM smarter_private.weekly_payout_owned_transactions;UPDATE weekly_accounting_payout_pauses SET phase='released';CREATE TEMP TABLE legacy_capture_snapshot AS SELECT caw_money()money,(SELECT jsonb_agg(to_jsonb(s)ORDER BY id)FROM accounting_cash_rake_sources s)cash,(SELECT jsonb_agg(to_jsonb(s)ORDER BY id)FROM accounting_tournament_fee_sources s)fee,(SELECT jsonb_agg(to_jsonb(b)ORDER BY rake_record_id)FROM accounting_cash_accrual_batches b)batches,(SELECT jsonb_agg(to_jsonb(r)ORDER BY tournament_id)FROM accounting_tournament_fee_recognitions r)recognitions;"+candidate_write+current_stages+"SELECT caw_assert(("+replay+")->>"+("'replayed'"if fee else"'duplicate'")+"='true','unchanged original captured legacy own0 receipt');"+recognition+"SELECT caw_assert(("+prep+")->>'legacy_paid'='true','paid own0 never reinterpreted');SELECT caw_assert(("+nr2+")->>'duplicate'='true'AND("+nr3+")->>'duplicate'='true','legacy money replay after producer replay');SELECT caw_assert((SELECT money=caw_money()AND cash IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(s)ORDER BY id)FROM accounting_cash_rake_sources s)AND fee IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(s)ORDER BY id)FROM accounting_tournament_fee_sources s)AND batches IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(b)ORDER BY rake_record_id)FROM accounting_cash_accrual_batches b)AND recognitions IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(r)ORDER BY tournament_id)FROM accounting_tournament_fee_recognitions r)FROM legacy_capture_snapshot),'all original producer and paid rows unchanged');SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_own_agent_interpretations),'no paid own-agent delta admission');ROLLBACK;")
        results.append({'case':('fee-capture-and-recognition'if fee else'cash-capture-and-attribution')+'-paid-legacy-own0-replay-before-new-construction','passed':True})
    def refusal(name,body,error,fee=False):
        before=q('SELECT caw_money();').stdout.strip()
        r=q("BEGIN;SET LOCAL test.own_namespace='fault-"+name+"';SELECT own_playing_seed("+('true'if fee else'false')+");"+body+'ROLLBACK;',check=False)
        assert r.returncode and error in r.stderr,(name,r.stdout[-1000:],r.stderr[-5000:])
        assert q('SELECT caw_money();').stdout.strip()==before,(name,'financial rollback changed original board')
        assert q('SELECT count(*)FROM accounting_own_agent_interpretations').stdout.strip()=='0'
        assert q('SELECT count(*)FROM accounting_own_agent_preparation_versions').stdout.strip()=='0'
        assert q('SELECT count(*)FROM accounting_own_agent_source_reviews').stdout.strip()=='0'
        results.append({'case':name,'passed':True,'expected_refusal':error})
    # Real separate PostgreSQL transactions hold each new private lock. A
    # refusal aborts original R0 atomically, retaining no invalidation/version.
    scope_key="'club-accounting:'||caw_u('club')||':'||extract(epoch FROM'2026-10-19 07:00Z'::timestamptz)||':'||extract(epoch FROM'2026-10-26 07:00Z'::timestamptz)"
    with held_lock('fault-try-scope-busy',scope_key):refusal('try-scope-busy','SELECT '+prep+';','own_agent_interpretation_scope_busy')
    with held_lock('fault-try-period-busy',"'accounting_rakeback_period:'||caw_u('club')||':2026-10-19'"):refusal('try-period-busy','SELECT '+prep+';','own_agent_interpretation_period_busy')
    refusal('r2-before-owning-R0','SELECT '+nr2+';','own_agent_source_interpretation_required_before_payment')
    refusal('r3-before-owning-R0','SELECT '+nr3+';','own_agent_source_interpretation_required_before_payment')
    refusal('partial-paid-round-prevents-reinterpretation',"INSERT INTO accounting_routed_settlement_runs(standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)VALUES(caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z',2,'synthetic-already-paid','{}');SELECT "+prep+';','own_agent_interpretation_week_already_paid')
    refusal('settled-original-commission-never-reposted',"UPDATE agent_commissions SET settled_at=now()WHERE source_id=caw_u('own-source-3');SELECT "+prep+';','own_agent_interpretation_original_commissions_changed')
    refusal('wrong-original-commission-refuses',"SET LOCAL app.ledger_maintenance='own-agent-interpretation:native-fault';UPDATE agent_commissions SET amount=amount+.01 WHERE source_id=caw_u('own-source-3');SET LOCAL app.ledger_maintenance='';SELECT "+prep+';','own_agent_interpretation_original_commissions_changed')
    refusal('fee-recognition-fingerprint-changed',"UPDATE accounting_tournament_fee_recognitions SET source_fingerprint='synthetic-changed';SELECT "+prep+';','own_agent_interpretation_fee_capture_changed',True)
    for state in ['frozen','missing']:
        mutate="UPDATE agents SET status='frozen'WHERE user_id=caw_u('A');"if state=='frozen'else"DELETE FROM agents WHERE user_id=caw_u('A');"
        refusal('current-own-agent-'+state,'SELECT '+prep+';'+mutate+'SELECT own_pause_round(2);SELECT '+nr2+';','own_agent_current_destination_unavailable')
    refusal('actual-owned-round-required-after-R0','SELECT '+prep+';SELECT '+nr2+';','weekly_payout_original_owned_phase_required')
    refusal('prepaid-bank-funding-shortfall','SELECT '+prep+";UPDATE clubs SET chip_treasury=1 WHERE id=caw_u('club');SELECT own_pause_round(2);SELECT "+nr2+';','routed_commission_club_funding_shortfall')
    for role in ['anon','authenticated','service_role']:
        r=q('BEGIN;SET LOCAL ROLE '+role+";SELECT smarter_private.admit_own_agent_source('cash_rake_accrual',NULL);ROLLBACK;",check=False)
        assert r.returncode and 'permission denied'in r.stderr
        results.append({'case':role+'-cannot-invoke-private-interpretation','passed':True})
    # Exercise the real public owning R0 entry and its bounded partial return.
    # The unchanged source-refusal queue is a ready prerequisite in this fixture.
    q("CREATE FUNCTION fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{\"status\":\"ready\",\"count\":0,\"sources\":[]}'::jsonb$$;")
    q("BEGIN;SET LOCAL test.own_namespace='public-R0';SELECT own_playing_seed(false,256);CREATE TEMP TABLE before_public_r0 AS SELECT caw_balances()b;CREATE TEMP TABLE public_r0_result AS SELECT fn_prepare_accounting_week(NULL,caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z')r;SELECT caw_assert((SELECT r->>'success'='false'AND r#>>'{problems,0,reason}'='own_agent_source_interpretation_in_progress'FROM public_r0_result),'actual original public R0 reports bounded progress');SELECT caw_assert((SELECT count(*)=256 FROM accounting_own_agent_interpretations),'full bounded batch committed to original interpretation owner');SELECT caw_assert(caw_balances()=(SELECT b FROM before_public_r0),'R0 changes no bank or wallet');SELECT caw_assert(("+prep+")->>'ready'='true','next original bounded call sees completed interpretation');ROLLBACK;")
    results.append({'case':'actual-public-owning-R0-entry-bounded256-source-admission-no-money-and-resumable-progress','passed':True})
    # Count actual historical interpretation calls in a large mixed population.
    # Instrumentation is rolled back; original historical body is called intact.
    interpretation=q("SELECT pg_get_functiondef('smarter_private.own_agent_interpreted_contract(jsonb,uuid,uuid,numeric,uuid,timestamptz)'::regprocedure)").stdout.strip()
    instrument=interpretation.replace('smarter_private.own_agent_interpreted_contract(', 'smarter_private.native_original_interpreted_contract(',1)+";CREATE OR REPLACE FUNCTION smarter_private.own_agent_interpreted_contract(p_contract jsonb,p_club uuid,p_player uuid,p_rake numeric,p_union uuid,p_terms timestamptz)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN PERFORM nextval('public.own_interpret_calls');RETURN smarter_private.native_original_interpreted_contract($1,$2,$3,$4,$5,$6);END$$;"
    selection=(H/'unpaid-interpretation.sql').read_text().split('FOR item IN ',1)[1].split(' LOOP',1)[0]
    for parameter,value in {'p_union':'NULL::uuid','p_club':"caw_u('club')",'p_from':"'2026-10-19 07:00Z'::timestamptz",'p_to':"'2026-10-26 07:00Z'::timestamptz",'p_limit':'256'}.items():selection=re.sub(r'\b'+parameter+r'\b',value,selection)
    counted=q("BEGIN;SET LOCAL test.own_namespace='mixed-capacity';SELECT own_playing_seed(false,1024,true);CREATE SEQUENCE own_interpret_calls;"+instrument+"CREATE TEMP TABLE capacity_batches(step int,result jsonb,historical_calls int);CREATE TEMP TABLE capacity_before AS SELECT caw_balances()b;"+
      'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+selection+";SELECT caw_assert((SELECT NOT is_called FROM own_interpret_calls),'ID selection never invokes historical constructors before LIMIT');"+
      "DO $capacity$DECLARE i int;b bigint;a bigint;r jsonb;BEGIN FOR i IN 1..6 LOOP SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO b FROM own_interpret_calls;r:=smarter_private.prepare_own_agent_interpretation(NULL,caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z',256);SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO a FROM own_interpret_calls;PERFORM caw_assert(a-b=(r->>'reviewed')::int AND a-b<=256,'at most256 actual historical calls per original R0 request');INSERT INTO capacity_batches VALUES(i,r,a-b);END LOOP;END $capacity$;"+
      "SELECT caw_assert((SELECT count(*)=1025 FROM accounting_own_agent_source_reviews),'every mixed source reviewed once');SELECT caw_assert((SELECT count(*)=512 FROM accounting_own_agent_source_reviews WHERE outcome='admitted'),'all eligible own-agent sources admitted');SELECT caw_assert((SELECT count(*)=513 FROM accounting_own_agent_source_reviews WHERE outcome='unchanged'),'all unchanged promotion-gap sources advance');SELECT caw_assert((SELECT historical_calls=0 AND result->>'ready'='true'AND result->>'reviewed'='0'FROM capacity_batches WHERE step=6),'completed request performs no repeated historical calls');SELECT caw_assert(caw_balances()=(SELECT b FROM capacity_before),'reviewing moves no money');SELECT jsonb_agg(to_jsonb(c)ORDER BY step)FROM capacity_batches c;ROLLBACK;").stdout
    if A.output:A.output.with_name(A.output.stem+'-capacity.log').write_text(counted)
    results.append({'case':'large-mixed-original-R0-selection-has-zero-history-calls-then-at-most256-per-request-and-durable-progress','passed':True,'sources_reviewed':1025,'admitted':512,'unchanged':513,'maximum_historical_calls_per_request':256})
    # Run the actual original preparation caller and original R0 transition.
    # Scope discovery/calendar and unrelated downstream calculation are the
    # explicit controlled boundaries; no progress result is fabricated.
    begin_owner=next(r for r in json.loads((R/'scripts/ci/fixtures/weekly-fee-preparation/original-owners.json').read_text())if r['signature']=='fn_weekly_accounting_attempt_begin(boolean)')
    q(begin_owner['definition']+';')
    end_source=(R/'supabase/migrations/20260928211132_a_union_close_proves_its_pnl_evidence_once_and_fast.sql').read_text();end_at=end_source.index('CREATE OR REPLACE FUNCTION public.fn_weekly_accounting_attempt_end(');q(end_source[end_at:end_source.index('$function$;',end_at)+len('$function$;')])
    # Parse the original union-only branch against its actual read owners;
    # it is not entered by this controlled standalone preparation case.
    for row in json.loads((R/'scripts/ci/fixtures/inventory-proof-lifetime-sources.json').read_text())['functions']:
        if row['signature']=='public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)':q('SET check_function_bodies=off;'+row['definition']+';')
    for row in json.loads((R/'scripts/ci/fixtures/weekly-fee-preparation/original-owners.json').read_text()):
        if row['signature']=='fn_accounting_close_windows(timestamp with time zone,timestamp with time zone)':q('SET check_function_bodies=off;'+row['definition']+';')
    lifetime=(R/'supabase/migrations/20261016123337_the_weekly_close_proofs_outlive_the_close.sql').read_text();at=lifetime.index('CREATE OR REPLACE FUNCTION public.fn_accounting_close_proof_lifetime()');q(lifetime[at:lifetime.index('$function$;',at)+len('$function$;')])
    prep_definition=q("SELECT pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)").stdout.strip()
    prep_count=prep_definition.replace('public.fn_prepare_accounting_week(', 'public.native_original_prepare_week(',1)+";CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN PERFORM nextval('public.preparation_calls');RETURN public.native_original_prepare_week(p_union_id,p_club_id,p_from,p_to);END$$;"
    preparation_boundaries="""
    SET LOCAL statement_timeout='240s';SET LOCAL app.weekly_accounting_chunked='on';
    CREATE SEQUENCE preparation_calls;
    CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_clock()RETURNS timestamptz LANGUAGE sql VOLATILE AS $$SELECT clock_timestamp()$$;
    CREATE OR REPLACE FUNCTION public.fn_union_accounting_run_at(p_period_end timestamptz)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT transaction_timestamp()+interval '1 hour'$$;
    CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_scope_plan(p_end timestamptz,p_now timestamptz)RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT jsonb_build_array(jsonb_build_object('kind','club','id',caw_u('club'),'period_start','2026-10-19 07:00Z'::timestamptz,'period_end','2026-10-26 07:00Z'::timestamptz))$$;
    CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)RETURNS TABLE(club_id uuid)LANGUAGE sql AS $$SELECT NULL::uuid WHERE false$$;
    CREATE OR REPLACE FUNCTION public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    """
    q("BEGIN;SET LOCAL test.own_namespace='connected-precompute';SELECT own_playing_seed(false,1024,true);CREATE TEMP TABLE preparation_before AS SELECT caw_balances()b;"+preparation_boundaries+prep_count+
      "CREATE TEMP TABLE connected_result AS SELECT smarter_private.weekly_payout_prepare_due()r;DO $$BEGIN RAISE NOTICE 'CONNECTED_RESULT:%',(SELECT r FROM connected_result);END$$;SELECT caw_assert((SELECT r->>'stage'='weekly_payout_prepared'FROM connected_result),'original precompute completes multiple own-agent pages in same request');SELECT caw_assert((SELECT last_value>1 FROM preparation_calls),'original caller consumed ready false progress without another tick');SELECT caw_assert((SELECT count(*)=1025 FROM accounting_own_agent_source_reviews),'connected original caller reviewed complete mixed population');SELECT caw_assert(caw_balances()=(SELECT b FROM preparation_before),'precompute moves no money');SELECT caw_assert(coalesce(current_setting('app.weekly_accounting_preparation_deadline',true),'')='','preparation deadline context restored');ROLLBACK;")
    results.append({'case':'actual-original-precompute-consumes-over256-mixed-source-progress-in-one-bounded-request','passed':True,'sources_reviewed':1025})
    # Expiry before a source starts must preserve the selected work for the
    # next request without false ready or even a preparation-version rewrite.
    q("BEGIN;SET LOCAL test.own_namespace='expired-source-budget';SELECT own_playing_seed();SELECT set_config('app.weekly_accounting_preparation_deadline',(clock_timestamp()-interval '1 second')::text,true);CREATE TEMP TABLE stopped AS SELECT "+prep+"r;SELECT caw_assert((SELECT r->>'ready'='false'AND r->>'reviewed'='0'AND r->>'budget_exhausted'='true'FROM stopped),'expired original physical budget stops before source work');SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_own_agent_source_reviews)AND NOT EXISTS(SELECT FROM accounting_own_agent_interpretations)AND NOT EXISTS(SELECT FROM accounting_own_agent_preparation_versions),'expired budget admits and invalidates nothing');ROLLBACK;")
    results.append({'case':'original-physical-preparation-deadline-stops-before-source-mutation-without-false-ready','passed':True})
    slow_instrument=instrument.replace("PERFORM nextval('public.own_interpret_calls');", "PERFORM nextval('public.own_interpret_calls');PERFORM pg_sleep(0.2);")
    q("BEGIN;SET LOCAL test.own_namespace='partial-source-budget';SELECT own_playing_seed(false,256);CREATE SEQUENCE own_interpret_calls;"+slow_instrument+"SELECT set_config('app.weekly_accounting_preparation_deadline',(clock_timestamp()+interval '3 seconds')::text,true);CREATE TEMP TABLE partial_budget AS SELECT "+prep+"r;SELECT caw_assert((SELECT r->>'ready'='false'AND r->>'budget_exhausted'='true'AND(r->>'reviewed')::int>0 AND(r->>'reviewed')::int<256 FROM partial_budget),'physical deadline retains positive partial source progress');SELECT caw_assert((SELECT count(*)=(SELECT(r->>'reviewed')::int FROM partial_budget)FROM accounting_own_agent_source_reviews),'partial progress is durable immutable review evidence');"+interpretation+";SELECT set_config('app.weekly_accounting_preparation_deadline','',true);SELECT caw_assert(("+prep+")->>'ready'='true','next original request resumes remaining source IDs');SELECT caw_assert((SELECT count(*)=256 FROM accounting_own_agent_source_reviews),'no review lost or repeated after partial budget');ROLLBACK;")
    results.append({'case':'physical-budget-retains-positive-partial-review-and-next-original-request-resumes','passed':True})
    # A source refusal remains the original single refusal. It is never
    # transformed into the one progress result the new caller may continue.
    q("BEGIN;SET LOCAL test.own_namespace='precompute-refusal';SELECT own_playing_seed();"+preparation_boundaries+prep_count+"CREATE OR REPLACE FUNCTION fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{\"status\":\"blocked\",\"count\":1,\"sources\":[\"synthetic-refusal\"]}'::jsonb$$;CREATE TEMP TABLE refused AS SELECT smarter_private.weekly_payout_prepare_due()r;SELECT caw_assert((SELECT r#>>'{problems,0,preparation,problems,0,reason}'='cash_source_refusals_pending'FROM refused),'original refusal preserved');SELECT caw_assert((SELECT last_value=1 FROM preparation_calls),'no generic refusal retry');SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_own_agent_source_reviews),'refusal reviews no source');ROLLBACK;")
    results.append({'case':'original-precompute-refusal-is-returned-once-without-general-retry','passed':True})
    # The existing three genuinely settled original books are reused. All
    # fixture hydration and owner replacement is contained in one rollback.
    replay_fixture=R/'scripts/ci/fixtures/standalone-paid-scope-replay'
    replay_helper=replay_fixture/'native_regression.py'
    replay_ns={'__file__':str(replay_helper)}
    exec(compile(replay_helper.read_text(),str(replay_helper),'exec'),replay_ns)
    results.extend(replay_ns['run'](q,R,replay_fixture)['cases'])
    changed=['fn_accounting_earning_contract','fn_calculate_cash_rakeback_periods','fn_rakeback_split_check','fn_rakeback_split_write','fn_prepare_accounting_week','fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_settle_accounting_rakeback_stage','fn_accounting_tournament_commission_source_guard','fn_accounting_union_earned_plan_sets','fn_accounting_union_earned_plan_window','fn_ca_rakeback_payout_leg_is_documented','ca_player_stats_financial_report','fn_ca_settlement_correctness_check','own_agent_destination_contract','rakeback_wallet_plan','record_rakeback_wallet_contracts','rakeback_certificate_wallets','rakeback_wallet_payout_complete','own_agent_interpreted_contract','admit_own_agent_source','prepare_own_agent_interpretation','assert_own_agent_scope_interpreted','weekly_payout_prepare_due']
    names=','.join("'"+n+"'"for n in changed)
    postimages=json.loads(q("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)-'prosrc')ORDER BY p.proname)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private')AND p.proname IN("+names+")").stdout.strip())
    assert len(postimages)==24
    assert q("SELECT NOT EXISTS(SELECT FROM pg_trigger WHERE tgname='wcs_receipt')AND NOT EXISTS(SELECT FROM social_messages)AND NOT EXISTS(SELECT FROM notifications)").stdout.strip()=='t'
    document_proof={name:q("SELECT md5(pg_get_functiondef('"+name+"'::regprocedure))").stdout.strip()for name in ['fn_accounting_transfer_document_on_insert()','fn_invoice_accounting_ledger_transfer(uuid)','fn_deliver_accounting_invoice(uuid)']}
    assert document_proof=={'fn_accounting_transfer_document_on_insert()':'164aae2fca35c964331ed8aecd225411','fn_invoice_accounting_ledger_transfer(uuid)':'2b9d4a150c45608118ba20b2f90f6aa7','fn_deliver_accounting_invoice(uuid)':'5a76ce1162d43b158e496bf3574c86d3'}
    inputs={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()for root,paths in [(R,list((R/'supabase/accounting/own-agent-v1').glob('*.sql'))+list((R/'scripts/qualification/own-agent-v1').glob('*.json'))+[A.candidate_migration,Path(__file__).resolve(),R/'scripts/ci/fixtures/own-agent-v1/playing-source.sql',R/'supabase/migrations/20261028153553_approved_agent_adjustments_settle_once_from_the_club_bank.sql']),(document_root,[document_dir/'document_pipeline.py']+list((document_dir/'fixtures').glob('*.json'))+list((document_root/'supabase/migrations').glob('20261028183252_*.sql'))+list((document_root/'supabase/migrations').glob('20261028193243_*.sql'))),(A.pause_source_root or R,list(((A.pause_source_root or R)/'supabase/migrations').glob('20261028162126_*.sql')))]for p in paths}
    inputs={**source_inputs,**inputs}
    tracking_spec=importlib.util.spec_from_file_location('credit_tracking_native',R/'scripts/ci/credit_tracking_native.py');tracking_module=importlib.util.module_from_spec(tracking_spec);tracking_spec.loader.exec_module(tracking_module)
    tracking_module.qualify(q,R,results,nr2,nr3,prep,calc)
    inputs={**source_inputs,**inputs,str(Path("scripts/ci/credit_tracking_native.py")):hashlib.sha256((R/"scripts/ci/credit_tracking_native.py").read_bytes()).hexdigest()}
    if A.output:A.output.write_text(json.dumps({'status':'fragment_compiler_passed'if A.compile_fragments else'passed','whole_installer':not A.compile_fragments,'input_sha256':inputs,'actual_document_pipeline':document_proof,'history_only_no_messenger':True,'cases':results,'postimages':postimages},indent=2)+'\n')
    print(json.dumps({'status':'source-and-financial-passed','cases':results}))
finally:
    if started: subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
    shutil.rmtree(W,ignore_errors=True)
    Path.read_text=original_read_text;Path.read_bytes=original_read_bytes
