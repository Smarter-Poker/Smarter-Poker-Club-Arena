"""Qualify Union payment identity and private invoice metadata in isolated PostgreSQL.

Uses captured production functions and relevant native table constraints. Other
invoice categories have refusing fixture boundaries; this is not a qualification
of cashier/correction/credit-capacity behavior or real device delivery.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/union-financial-documents'
MIGRATION = ROOT / 'supabase/migrations/20261009023044_a_union_payment_has_one_receipt_and_each_invoice_has_its_con.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, required=True)
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
PG = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='union-documents-'))
socket = cluster / 's'; socket.mkdir(mode=0o700)
owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
if owner:
    shutil.chown(cluster, 'postgres'); shutil.chown(socket, 'postgres')
PSQL = [PG / 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55829', '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False, 'source_sha256': {}, 'limits': [
    'Native private fixture; no production writes or financial calls.',
    'Relevant tables use captured columns and checks; unrelated profile/club fields and external foreign keys are excluded.',
    'Cashier, correction and credit-capacity contract calls refuse if exercised; those categories are outside this regression.',
    'Real notification rows are verified; provider push transport is covered by independent production readback.'
]}
started = False


def command(args, sql=None, allow_error=False):
    r = subprocess.run([str(x) for x in args], input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode and not allow_error:
        raise RuntimeError(r.stderr)
    return r


def run(sql):
    return command(PSQL, sql).stdout.strip()


def value(sql):
    return json.loads(run(sql))


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def uid(n):
    return f'00000000-0000-4000-8000-{n:012d}'


def quote(x):
    return "'" + str(x).replace("'", "''") + "'"


def actor_sql(actor=1, role='authenticated'):
    subject = uid(actor) if actor is not None else ''
    return f"SET ROLE {role};SET request.jwt.claim.role={quote(role)};SET request.jwt.claim.sub={quote(subject)};"


def payment(operation=301, amount='12.34', club=101, actor=1, method='wire', reference='receipt-A', note='fixture', role='authenticated', legacy=False, union=201):
    args = [quote(uid(union)), quote(uid(club)), amount, quote(method), quote(reference), quote(note)]
    if not legacy:
        args.append('NULL' if operation is None else quote(uid(operation)))
    return actor_sql(actor, role) + 'SELECT public.fn_union_record_presettlement(' + ','.join(args) + ');'


def snapshot():
    return value("SELECT jsonb_build_object('payments',(SELECT count(*) FROM union_presettlements),'invoices',(SELECT count(*) FROM settlement_invoices),'messages',(SELECT count(*) FROM social_messages),'notifications',(SELECT count(*) FROM notifications),'deliveries',(SELECT count(*) FROM accounting_invoice_deliveries),'ledger',(SELECT count(*) FROM chip_ledger))")


def load_function(f):
    run(f['definition'] + ';')
    sig = f['signature']
    run(f'REVOKE ALL ON FUNCTION public.{sig} FROM PUBLIC;')
    acl = f.get('acl') or []
    if isinstance(acl, str): acl = acl.strip('{}').split(',')
    for entry in acl:
        role = entry.split('=')[0]
        if role and role != 'postgres':
            run(f'GRANT EXECUTE ON FUNCTION public.{sig} TO {role};')
    actual = run(f'SELECT md5(pg_get_functiondef({quote("public."+sig)}::regprocedure))')
    check('captured-preimage-' + sig, actual == f['md5'], actual)


def bootstrap():
    run("""CREATE EXTENSION "uuid-ossp"; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
    GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role;
    CREATE TABLE chip_ledger(id uuid PRIMARY KEY,category text,club_id uuid,union_id uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric);
    """)
    minimal = {
        'profiles': {'id','username','avatar_url','is_vip','is_admin'},
        'clubs': {'id','name','owner_id','is_union'},
        'unions': {'id','name','owner_id'},
        'club_members': {'id','club_id','user_id','role','status','is_active','membership_lifecycle_status','chip_balance'},
    }
    for table in json.loads((FIX / 'captured-tables.json').read_text()):
        cols = [c for c in table['columns'] if table['name'] not in minimal or c['name'] in minimal[table['name']]]
        definitions = []
        for c in cols:
            text = quote(c['name']).replace("'", '"') + ' ' + c['type']
            if c['default'] is not None: text += ' DEFAULT ' + c['default']
            if c['notnull']: text += ' NOT NULL'
            definitions.append(text)
        for co in table['constraints'] or []:
            if co['type']=='p' or (co['type'] in ('c','u') and table['name'] not in minimal):
                definitions.append('CONSTRAINT "'+co['name']+'" '+co['definition'])
        run('CREATE TABLE public."'+table['name']+'"('+','.join(definitions)+');')
    run('ALTER TABLE union_presettlements ENABLE ROW LEVEL SECURITY;GRANT SELECT ON union_presettlements TO authenticated,anon;GRANT ALL ON union_presettlements TO service_role;')
    # These branches are parsed by shared readers but never entered by an ordinary
    # receipt. Refuse accidental coverage rather than fake a valid special contract.
    for name in ['fn_accounting_credit_change_contract_v1','fn_cashier_invoice_contract','fn_accounting_correction_contract']:
        run(f"CREATE FUNCTION {name}(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outside_fixture_contract'; END $$;")
    for n in range(1,9):
        run(f"INSERT INTO profiles(id,username) VALUES({quote(uid(n))},'Fixture {n}')")
    for n,own in [(101,2),(102,3),(201,1)]:
        run(f"INSERT INTO clubs(id,name,owner_id,is_union) VALUES({quote(uid(n))},'Fixture Club {n}',{quote(uid(own))},{str(n==201).lower()})")
    run(f"INSERT INTO unions(id,name,owner_id) VALUES({quote(uid(201))},'Fixture Union',{quote(uid(1))});INSERT INTO union_clubs(union_id,club_id) VALUES({quote(uid(201))},{quote(uid(101))}),({quote(uid(201))},{quote(uid(102))});INSERT INTO union_admins(union_id,user_id) VALUES({quote(uid(201))},{quote(uid(7))});")
    for club,actor in [(101,2),(102,3),(201,1)]:
        run(f"INSERT INTO club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status) VALUES({quote(uid(club))},{quote(uid(actor))},'owner','active',true,'active')")
    functions = json.loads((FIX/'captured-functions.json').read_text())
    helpers = json.loads((FIX/'captured-helpers.json').read_text())['functions']
    triggers = json.loads((FIX/'captured-trigger-helpers.json').read_text())
    # SQL functions resolve relation/helper dependencies at definition time.
    ordered = helpers + [f for f in functions if f['signature'].startswith('fn_union_overseer_of_record(')] + [f for f in functions if not f['signature'].startswith('fn_union_overseer_of_record(')] + triggers
    for f in ordered: load_function(f)
    for f in json.loads((FIX/'captured-wrapper.json').read_text()): load_function(f)
    for t in json.loads((FIX/'captured-helpers.json').read_text())['triggers']:
        run(t['definition']+';')
    run('CREATE TRIGGER accounting_message_immutable BEFORE DELETE OR UPDATE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable();')


def ordinary_invoice(n, sender=4, recipient=5):
    # Current source invariant: a recorded weekly period is a real allowed source.
    period = uid(n+1000)
    run(f"INSERT INTO settlement_periods(id,club_id,period_number,year,start_at,end_at,status) VALUES({quote(period)},{quote(uid(101))},40,2026,'2026-09-28T07:00Z','2026-10-05T07:00Z','closed')")
    run(f"INSERT INTO settlement_invoices(id,club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,status) VALUES({quote(uid(n))},{quote(uid(101))},{quote(period)},'agent_to_player','agent',{quote(uid(sender))},'player',{quote(uid(recipient))},12.34,12.34,0,'{{}}','paid')")


try:
    command(owner + [PG/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    command(owner + [PG/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {socket} -p 55829 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=12",'-w','start']); started=True
    bootstrap()
    # Reproduce both real defects against byte-bound live functions.
    old1=value(payment(legacy=True)); old2=value(payment(legacy=True))
    check('baseline-retry-duplicates-payment',old1['success'] and old2['success'] and old1['presettlement_id']!=old2['presettlement_id'] and run('SELECT count(*) FROM union_presettlements')=='2')
    check('baseline-payment-has-no-receipt', snapshot()['invoices']==0)
    check('baseline-nonfinite-amount-is-accepted',value(payment(amount="'NaN'::numeric",legacy=True))['success'])
    run('TRUNCATE union_presettlements;')
    ordinary_invoice(401)
    mismatches=int(run("SELECT count(*) FROM social_messages WHERE media_metadata->>'conversationId' IS DISTINCT FROM conversation_id::text"))
    check('baseline-multi-recipient-message-metadata-is-wrong',mismatches==2,mismatches)
    legacy_messages = run('SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM social_messages m')
    # Apply EXACT candidate once; all following behavior is its real database code.
    run(MIGRATION.read_text())
    check('legacy-messages-not-rewritten',run('SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM social_messages m')==legacy_messages)
    ordinary_invoice(402)
    check('every-new-recipient-has-own-conversation',run(f"SELECT count(*) FROM social_messages m JOIN accounting_invoice_deliveries d ON d.message_id=m.id WHERE d.invoice_id={quote(uid(402))} AND (m.media_metadata->>'conversationId' IS DISTINCT FROM m.conversation_id::text OR m.media_metadata->>'conversation_id' IS DISTINCT FROM m.conversation_id::text)")=='0')
    for reader in ('page','search'):
        conv=run(f"SELECT conversation_id FROM accounting_conversations WHERE recipient_id={quote(uid(5))}")
        query=(f"fn_messenger_message_page({quote(uid(5))},{quote(conv)})" if reader=='page' else f"fn_messenger_search_messages({quote(uid(5))},ARRAY[{quote(conv)}::uuid],'Invoice')")
        rows=value(actor_sql(5)+f"SELECT jsonb_agg(to_jsonb(r)) FROM {query} r")
        check(reader+'-projects-correct-legacy-conversation',len(rows)==2 and all(r['media_metadata']['conversationId']==r['conversation_id'] and r['media_metadata']['conversation_id']==r['conversation_id'] for r in rows),rows)
        refused=command(PSQL,actor_sql(6)+f"SELECT * FROM {query}",True)
        check(reader+'-refuses-other-user',refused.returncode!=0 and 'not_authorised' in refused.stderr,refused.stderr)
    first=value(payment()); replay=value(payment())
    check('one-payment-and-same-replayed-receipt',first['success'] and not first['duplicate'] and replay['success'] and replay['duplicate'] and first['presettlement_id']==replay['presettlement_id'] and first['invoice_id']==replay['invoice_id'] and first['received_at']==replay['received_at'],[first,replay])
    run(f"INSERT INTO unions(id,name,owner_id) VALUES({quote(uid(202))},'Second Union',{quote(uid(1))});INSERT INTO union_clubs(union_id,club_id) VALUES({quote(uid(202))},{quote(uid(102))});")
    before=snapshot()
    check('payment-created-one-source-invoice',before['payments']==1 and before['invoices']==3 and before['ledger']==0,before)
    check('payment-delivered-to-union-owner-admin-and-club-owner-once',run(f"SELECT array_agg(recipient_id::text ORDER BY recipient_id)::text FROM accounting_invoice_deliveries WHERE invoice_id={quote(first['invoice_id'])}")=="{"+','.join(uid(n) for n in (1,2,7))+"}")
    check('legacy-wrapper-refuses-missing-operation',value(payment(legacy=True).replace('public.fn_union_record_presettlement(', 'public.ca_union_record_presettlement('))['success'] is False and snapshot()==before)
    check('payment-is-receipt-not-chip-transfer',value(f"SELECT to_jsonb(i) FROM settlement_invoices i WHERE id={quote(first['invoice_id'])}")['chips_transferred'] is False)
    for key,kwargs in [('union',{'union':202,'club':102}),('amount',{'amount':'22.34'}),('club',{'club':102}),('actor',{'actor':7}),('method',{'method':'cash'}),('reference',{'reference':'changed'}),('note',{'note':'changed'})]:
        result=value(payment(**kwargs)); check('operation-refuses-changed-'+key,result.get('success') is False and snapshot()==before,result)
    for label,sql in [('missing-key',payment(None)),('legacy-call',payment(legacy=True)),('nonmember-club',payment(302,club=999)),('outsider',payment(303,actor=6)),('missing-identity',payment(304,actor=None)),('nan',payment(305,amount="'NaN'::numeric")),('infinity',payment(306,amount="'Infinity'::numeric")),('negative',payment(307,amount='-1')),('fractional-cent',payment(308,amount='1.001')),('amount-over-invoice-precision',payment(308,amount='10000000000'))]:
        result=command(PSQL,sql,True)
        denied=result.returncode!=0 or json.loads(result.stdout).get('success') is False
        check('refuses-'+label,denied and snapshot()==before, result.stderr or result.stdout)
    # A genuine concurrent duplicate and an unknown response both return one row.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pair=list(pool.map(lambda _:value(payment(309)),range(2)))
    check('concurrent-operation-has-one-receipt',all(r['success'] for r in pair) and sorted(r['duplicate'] for r in pair)==[False,True] and len({r['invoice_id'] for r in pair})==1,pair)
    committed=snapshot()
    retry=value(payment(309));check('lost-response-retry-has-no-new-effects',retry['duplicate'] and snapshot()==committed)
    # A failure in notification delivery must abort the owning payment transaction.
    run("CREATE FUNCTION fixture_refuse_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_delivery_unavailable'; END $$;CREATE TRIGGER fixture_refusal BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fixture_refuse_notification();")
    failed=command(PSQL,payment(310),True)
    check('notification-failure-rolls-back-payment-and-invoice',failed.returncode!=0 and 'fixture_delivery_unavailable' in failed.stderr and snapshot()==committed,failed.stderr)
    run('DROP TRIGGER fixture_refusal ON notifications;')
    recovered=value(payment(310));check('same-operation-can-recover-rolled-back-delivery',recovered['success'] and not recovered['duplicate'],recovered)
    for column,expression in [('source_union_presettlement_id','NULL'),('status',"'generated'"),('chips_transferred','true')]:
        attempt=command(PSQL,f"UPDATE settlement_invoices SET {column}={expression} WHERE id={quote(first['invoice_id'])};",True)
        check('issued-payment-receipt-immutable-'+column,attempt.returncode!=0,attempt.stderr)
    for field,expression in [('amount','99.99'),('reference',"'changed'"),('operation_id',quote(uid(999))),('received_at',"received_at+interval '1 day'")]:
        refusal=command(PSQL,f"UPDATE union_presettlements SET {field}={expression} WHERE id={quote(first['presettlement_id'])};",True)
        check('operation-request-immutable-'+field,refusal.returncode!=0 and 'presettlement_operation_is_immutable' in refusal.stderr,refusal.stderr)
    run(f"UPDATE union_presettlements SET applied_settlement_id={quote(uid(901))} WHERE id={quote(first['presettlement_id'])}")
    applied_replay=value(payment())
    check('applied-operation-replays-original-date-and-receipt',applied_replay['duplicate'] and applied_replay['received_at']==first['received_at'] and applied_replay['invoice_id']==first['invoice_id'],applied_replay)
    service=value(payment(311,actor=None,role='service_role'))
    check('explicit-service-without-user-can-record',service['success'] and not service['duplicate'],service)
    check('no-chip-ledger-effects',run('SELECT count(*) FROM chip_ledger')=='0')
    replay_migration=command(PSQL,MIGRATION.read_text(),True)
    check('migration-replay-refused',replay_migration.returncode!=0,replay_migration.stderr)
    results['status']='passed'
except Exception as error:
    results['status']='failed'; results['error']=str(error)
    raise
finally:
    for path in [MIGRATION,pathlib.Path(__file__).resolve(),*FIX.glob('*.json')]:
        if path.exists():results['source_sha256'][str(path.relative_to(ROOT))]=hashlib.sha256(path.read_bytes()).hexdigest()
    if started: command(owner+[PG/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'],allow_error=True)
    (out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
    if results.get('status')=='passed':shutil.rmtree(cluster)
    else:results['failed_cluster']=str(cluster);(out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps({'status':results.get('status'),'checks':len(results['checks']),'output':str(out/'RESULTS.json'),'error':results.get('error')}))
