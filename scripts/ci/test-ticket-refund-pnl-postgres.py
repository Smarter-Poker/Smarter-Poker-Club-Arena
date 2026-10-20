"""Actual original-flow consumer, all 146 retained direct-award ticket refunds.

Disposable PG17 only. Empty cash/late/restoration helpers are unrelated branch
controls, not a full PNL proof. Installer separately loads all 40 actual bound
function definitions, proving exact source/ACL guards without admissions.
"""
import json, os, pathlib, subprocess, tempfile, shutil
ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures'
PRE = json.loads((FIX / 'ticket-refund-pnl-preimages.json').read_text())
M = ROOT / 'supabase/migrations/20261020155211_ticket_refund_pnl_requires_its_original_admission_and_award.sql'
PG = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = pathlib.Path(os.environ['ACCOUNTING_FIXTURE_PARENT'])
work = pathlib.Path(tempfile.mkdtemp(prefix='ticket-pnl-', dir=parent))
sock = work / 's'; sock.mkdir()
port = os.environ.get('TICKET_PNL_PORT','55563')
started = False
env = dict(os.environ, LC_ALL='C', LANG='C')
def run(args, text=None):
    r = subprocess.run(args, input=text, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode: raise AssertionError((r.stdout+r.stderr)[-6000:])
    return r.stdout
def sql(s, error=None):
    r = subprocess.run([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h',str(sock),'-p',port,'-d','postgres'],input='SET check_function_bodies=off;'+s,text=True,capture_output=True,env=env,timeout=45)
    if error:
        assert r.returncode and error in r.stderr, r.stdout+r.stderr
    else:
        assert not r.returncode,(r.stdout+r.stderr)[-6000:]
    return r.stdout.strip()
def lit(v): return "'" + json.dumps(v,separators=(',',':')).replace("'","''") + "'::jsonb"
def insert(table, row):
    return 'INSERT INTO public.'+table+' SELECT * FROM jsonb_populate_record(NULL::public.'+table+','+lit(row)+');'
consumer = "public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-19 07:00Z')"
empty = """
CREATE OR REPLACE FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) RETURNS TABLE(club_id uuid,user_id uuid,delta numeric) LANGUAGE sql AS 'SELECT NULL::uuid,NULL::uuid,NULL::numeric WHERE false';
CREATE OR REPLACE FUNCTION public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
"""
for name in ['original_restoration_cash_returns','original_erased_cash_discharge_returns']:
    empty += "CREATE OR REPLACE FUNCTION smarter_private."+name+"(p_union_id uuid,p_start timestamptz,p_end timestamptz) RETURNS TABLE(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean) LANGUAGE sql AS 'SELECT NULL::uuid,NULL::uuid,NULL::uuid,0::numeric,0::numeric,NULL::text,false WHERE false';"
try:
    run([str(PG/'initdb'),'-D',str(work/'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    run([str(PG/'pg_ctl'),'-D',str(work/'data'),'-l',str(work/'server.log'),'-o','-k '+str(sock)+' -p '+port+" -h '' -c shared_buffers=16MB -c max_wal_size=64MB",'-w','start'])
    started=True
    setup='CREATE SCHEMA smarter_private; SET check_function_bodies=off;'
    setup+='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
    for t in PRE['schemas']: setup+='CREATE TABLE public.'+t['relname']+'('+t['columns']+');'
    for f in PRE['source40']+PRE['connected']: setup+=f['definition']+';'
    setup+=';'.join('REVOKE ALL ON FUNCTION '+f['signature']+' FROM PUBLIC,anon,authenticated,service_role' for f in PRE['source40']+PRE['connected'])+';'
    setup+='GRANT EXECUTE ON FUNCTION public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz) TO service_role;'
    guard=next(f['definition'] for f in PRE['definitions'] if f['proname']=='original_inventory_proof_sources_match')
    setup+=guard+';REVOKE ALL ON FUNCTION smarter_private.original_inventory_proof_sources_match() FROM PUBLIC,anon,authenticated,service_role;'
    sql(setup)
    assert sql('SELECT smarter_private.original_inventory_proof_sources_match()')=='t'
    migration=M.read_text()
    sql('GRANT EXECUTE ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) TO anon;')
    sql(migration,'ticket_refund_original_source_metadata_changed')
    sql('REVOKE EXECUTE ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) FROM anon;')
    sql(migration.replace('COMMIT;','ROLLBACK;'))
    assert sql("SELECT md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))")=='09745f78c6cc2ae57f403419020fd1ab'
    sql(migration)
    hashes=sql("SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.oid IN('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure,'public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure)")
    print('POSTIMAGE',hashes)
    assert sql('SELECT smarter_private.original_inventory_proof_sources_match()')=='t'
    sql(migration,'preimage_changed')
    assert sql("SELECT bool_and(p.proowner='postgres'::regrole AND p.proacl::text='{postgres=X/postgres}') FROM pg_proc p WHERE p.oid IN('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure)")=='t'
    window_candidate=sql("SELECT pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure)")
    candidate=sql("SELECT pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)")
    sql(empty+(FIX/'ticket-refund-pnl-cents.sql').read_text())
    assert sql('SELECT smarter_private.original_inventory_proof_sources_match()')=='f'
    sql(migration,'preimage_changed')
    # Source guard failure cannot bless an installer, even on the exact old body.
    old=next(f['definition'] for f in PRE['definitions'] if f['proname']=='fn_union_pnl_original_flow_evidence')
    sql(old+';'+guard+';'+';'.join(f['definition'] for f in PRE['connected'])+';')
    sql(migration,'preimage_changed')
    data='';seen=set()
    for row in PRE['lineages']:
        for key,table in [('entitlement','tournament_refund_entitlements'),('ticket','tournament_tickets'),('admission','chip_ledger'),('award','tournament_satellite_awards'),('settlement','tournament_satellite_settlements'),('payout','tournament_payouts'),('issue','chip_ledger'),('issue_tx','chip_transactions')]:
            obj=row[key];identity=(table,json.dumps(obj,sort_keys=True))
            assert obj is not None
            if identity not in seen: data+=insert(table,obj);seen.add(identity)
    for row in PRE['originals']:
        data+=insert('tournament_refund_tranches',row['tranche'])+insert('union_pnl_original_flows',row['original'])
    sql(data)
    assert sql('SELECT count(*) FROM '+consumer+" WHERE kind='unsupported' AND NOT valid")=='146'
    sql(candidate+';'+window_candidate+';')
    assert sql('SELECT count(*)||\':\'||sum(cashouts)||\':\'||sum(buyins) FROM '+consumer+" WHERE valid AND kind='tournament_return'")=='146:2920:0'
    assert sql('SELECT count(*) FROM '+consumer)=='146'
    assert sql("SELECT bool_and(f.valid AND f.kind='tournament_return' AND f.club_id=e.refund_wallet_club_id AND f.user_id=e.user_id AND f.cashouts=e.gross AND f.buyins=0) FROM "+consumer+' f JOIN tournament_refund_entitlements e ON f.ledger_id IN(SELECT credit_ledger_id FROM tournament_refund_tranches tr WHERE tr.entitlement_id=e.id)')=='t'
    window="smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-13 15:00Z','2026-10-13 17:00Z')"
    assert sql('SELECT count(*) FROM '+window+' WHERE valid')=='146'
    assert sql('SELECT count(*) FROM (SELECT * FROM '+consumer+' EXCEPT SELECT * FROM '+window+') q')=='0'
    before=sql("SELECT md5(string_agg(n||':'||v,'|' ORDER BY n)) FROM ("+' UNION ALL '.join("SELECT '"+t['relname']+"' n,COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text v FROM public."+t['relname']+" x" for t in PRE['schemas'])+") z")
    print('PASS actual consumer old fails146; candidate and bounded window prove146/2920 exact owners, no extras, zero buyins')
    e=PRE['lineages'][0]['entitlement'];a=PRE['lineages'][0]['award'];o=PRE['originals'][0]['original'];eid=e['id'];tid=e['source_ticket_id'];lid=e['source_ledger_id'];qid=o['ledger_id']
    faults={
      'holder':f"UPDATE tournament_tickets SET holder_id=gen_random_uuid() WHERE id='{tid}'",
      'ticket_state':f"UPDATE tournament_tickets SET status='issued' WHERE id='{tid}'",
      'ticket_amount':f"UPDATE tournament_tickets SET value=value+.01 WHERE id='{tid}'",
      'ticket_source':f"UPDATE tournament_tickets SET source_satellite_id=gen_random_uuid() WHERE id='{tid}'",
      'admission_amount':f"UPDATE chip_ledger SET amount=amount+.01 WHERE id='{lid}'",
      'admission_state':f"UPDATE chip_ledger SET status='reversed' WHERE id='{lid}'",
      'registration_identity':f"UPDATE tournament_refund_entitlements SET registration_id=gen_random_uuid() WHERE id='{eid}'",
      'admission_metadata':f"UPDATE chip_ledger SET metadata=metadata-'ticket_id' WHERE id='{lid}'",
      'issue_missing':f"DELETE FROM chip_ledger WHERE id='{PRE['lineages'][0]['issue']['id']}'",
      'issue_reporting_duplicate':insert('chip_transactions',PRE['lineages'][0]['issue_tx']),
      'entitlement_duplicate':insert('tournament_refund_entitlements',e),
      'tranche_duplicate':insert('tournament_refund_tranches',PRE['originals'][0]['tranche']),
      'refund_amount':f"UPDATE union_pnl_original_flows SET ledger_snapshot=jsonb_set(ledger_snapshot,'{{amount}}','20.01') WHERE ledger_id='{qid}'",
      'refund_and_ticket':f"INSERT INTO tournament_tickets(id,source_refund_entitlement_id) VALUES(gen_random_uuid(),'{eid}')",
      'award_wallet_duplicate':f"INSERT INTO wallet_credit_idempotency(key)VALUES('{a['idempotency_key']}')",
      'payer_identity':f"UPDATE tournament_refund_entitlements SET refund_wallet_club_id=gen_random_uuid() WHERE id='{eid}'",
    }
    for label,mutation in faults.items():
        result=sql('BEGIN;'+mutation+';SELECT count(*) FROM '+consumer+f" WHERE ledger_id='{qid}' AND valid;ROLLBACK;")
        assert result=='0',(label,result)
        assert sql('BEGIN;'+mutation+';SELECT count(*) FROM '+window+f" WHERE ledger_id='{qid}' AND valid;ROLLBACK;")=='0',label
    print('PASS',len(faults),'identity/amount/source/state/duplicate/disposition/metadata faults fail closed')
    assert sql('SELECT count(*) FROM '+consumer+' WHERE valid')=='146'
    after=sql("SELECT md5(string_agg(n||':'||v,'|' ORDER BY n)) FROM ("+' UNION ALL '.join("SELECT '"+t['relname']+"' n,COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text v FROM public."+t['relname']+" x" for t in PRE['schemas'])+") z")
    assert before==after
    print('PASS rollback/install/replay/ACL/source40 false controls; all original fixture table digests preserved')
finally:
    if started: subprocess.run([str(PG/'pg_ctl'),'-D',str(work/'data'),'-m','immediate','stop'],capture_output=True,env=env)
    shutil.rmtree(work)
