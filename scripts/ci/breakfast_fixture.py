"""Exact observed terminal catalog overlay for isolated Breakfast qualification."""
from pathlib import Path
import hashlib,json,re
from satellite_qualifier_fixture import compose as satellite, module, function_sql
from breakfast_original_witness import DATA, retained, js, literal, sha

def function(row,definition_key='definition'):
 definition=row[definition_key];sig=re.search(r'FUNCTION\s+([^\n]+)\n',definition).group(1)
 # Identity argument names/defaults are taken from the CREATE statement for DDL;
 # use recorded identity signature for ACL statements.
 sig=row.get('signature') or re.search(r'FUNCTION\s+([^\s(]+)\(',definition).group(1)+'()'
 if '.' not in sig.split('(')[0]: sig='public.'+sig
 result=definition.rstrip().rstrip(';')+';\nALTER FUNCTION '+sig+' OWNER TO '+row['owner']+';\nREVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role,postgres;\n'
 for acl in row['acl'] or []:
  grantee,rights=acl.split('=',1);rights=rights.split('/')[0]
  if rights not in ['X','X*']: raise ValueError('unexpected captured function ACL')
  result+='GRANT EXECUTE ON FUNCTION '+sig+' TO '+(grantee or 'PUBLIC')+(' WITH GRANT OPTION' if rights.endswith('*') else '')+';\n'
 return result

def compose(root):
 root=Path(root);base=satellite(root);capture=json.loads((root/DATA/'installed-terminal.json').read_text())['evidence'];schema=json.loads((root/DATA/'terminal-schema.json').read_text())['evidence']
 out=base['sql']+'\n'+base['entry_sql']+'\nBEGIN;\n'
 # Exact observed changes to the already captured real terminal table.
 out+="ALTER TABLE public.tournament_terminal_settlements ADD COLUMN accounting_state text DEFAULT 'legacy'::text NOT NULL, ALTER COLUMN rake_attributed_at DROP NOT NULL, DROP CONSTRAINT tournament_terminal_settlements_receipt_version_check;\n"
 for c in schema['constraints']:
  if c['name'] in {'terminal_rake_attribution_matches_accounting_state','terminal_receipt_version_matches_accounting_state','tournament_terminal_settlements_accounting_state_check'}:
   out+='ALTER TABLE public.tournament_terminal_settlements ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
 cols=[c for c in schema['columns'] if c['relation']=='smarter_private.f06_elimination_dispatch']
 out+='CREATE TABLE smarter_private.f06_elimination_dispatch('+','.join(c['name']+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else '') for c in cols)+');\n'
 for c in schema['constraints']:
  if c['relation']=='smarter_private.f06_elimination_dispatch':out+='ALTER TABLE smarter_private.f06_elimination_dispatch ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
 out+='ALTER TABLE smarter_private.f06_elimination_dispatch OWNER TO postgres; ALTER TABLE smarter_private.f06_elimination_dispatch ENABLE ROW LEVEL SECURITY; REVOKE ALL ON smarter_private.f06_elimination_dispatch FROM PUBLIC,anon,authenticated,service_role;\n'
 selected={'fn_settle_tournament_places(uuid,uuid)','fn_ca_tournament_terminal_receipt(uuid,uuid)','fn_complete_tournament_terminal(uuid,uuid,text)','fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','fn_complete_tournament_entry_reprice(uuid)','fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)','fn_ca_close_tournament_seat_exit_authority(uuid,boolean)','fn_accounting_tournament_terminal_fee_receipt(uuid)'}
 for r in capture['functions']:
  if r['signature'] in selected:out+=function(r)
 g=next(g for g in capture['guards'] if g['name']=='a00_f06_source_seat');out+=function(g,'function')
 # Compose the already protected recorded-fee capture object without executing
 # its production-only historical-backlog installer assertions. The final name
 # and exact unchanged function body are source-bound to both migrations.
 fee_path=root/'supabase/migrations/20260918080939_a_fee_whose_producer_died_can_still_be_attributed.sql'
 fee=fee_path.read_text();a=fee.index('CREATE TABLE public.ca_stranded_fee_reconciliations(')
 b=fee.index('-- 3.',a);fragment=fee[a:b];fragment=fragment[:fragment.rfind('-- ---------------------------------------------------------------------------')]
 fragment+='\nALTER FUNCTION public.fn_ca_reconcile_stranded_tournament_fee(uuid) RENAME TO fn_ca_capture_tournament_fee_from_recorded_evidence;\n'
 out+=fragment+"\nDO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure)<>'dcc3bc8cad78ec0d934a386a20804023' THEN RAISE EXCEPTION 'protected capture source differs'; END IF; END $$;\n"
 # The source-only dependency is already installed. Keep all of its new relation
 # and function postimages, without replaying its live precondition query.
 spin=(root/DATA/'installed-mixed-spin-source.sql').read_text()
 out+=spin[spin.index('CREATE TABLE public.accounting_mixed_cutover_spin_fee_proofs('):spin.rindex('COMMIT;')]
 spin_binding=json.loads((root/DATA/'mixed-spin-tested-binding.json').read_text())
 if hashlib.sha256(spin.encode()).hexdigest()!=spin_binding['supabase/migrations/20260918085836_original_mixed_cutover_spin_fee_proof.sql']:
  raise ValueError('installed mixed-Spin source is not its qualified source')
 spin_functions=json.loads((root/DATA/'mixed-spin-qualified-functions.json').read_text())
 out+="DO $spin$ DECLARE r jsonb; BEGIN FOR r IN SELECT value FROM jsonb_array_elements("+js(spin_functions)+") LOOP IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(r->>'identity')) AND md5(pg_get_functiondef(p.oid))=r->>'definition_md5' AND md5(p.prosrc)=r->>'source_md5' AND pg_get_userbyid(p.proowner)=r->>'owner' AND p.proacl::text IS NOT DISTINCT FROM r->>'acl' AND to_jsonb(p.proconfig) IS NOT DISTINCT FROM r->'config') THEN RAISE EXCEPTION 'installed mixed-Spin dependency differs: %',r->>'identity'; END IF; END LOOP; END $spin$;\n"
 # Only the lease relation is absent from the full maintained foundation.
 # hand_history already exists; the retained complete capture makes that fact
 # explicit without replacing unrelated statistical trigger dependencies.
 extra=json.loads((root/DATA/'hand-history-table-lease-schema.json').read_text())['relations']
 lease=next(r['evidence'] for r in extra if r['relation']=='engine_table_leases')
 out+='CREATE TABLE public.engine_table_leases('+','.join(c['name']+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else '') for c in lease['columns'])+');\n'
 for c in lease['constraints']:
  if not c['validated']:raise ValueError('unqualified lease constraint')
  out+='ALTER TABLE public.engine_table_leases ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
 if lease['triggers']:raise ValueError('new lease trigger dependency')
 # Reconstruct the exact snapshot relation, constraints, indexes and original
 # BEFORE writer guard from the observed installed catalog. Internal FK triggers
 # are supplied by the captured FK, not fabricated by the fixture.
 snap=json.loads((root/DATA/'hand-snapshot-schema.json').read_text())['evidence']
 if any(c['generated'] or c['identity'] for c in snap['columns']):raise ValueError('new snapshot column contract')
 out+='CREATE TABLE public.hand_state_snapshots('+','.join(c['name']+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else '') for c in snap['columns'])+');\n'
 for c in snap['constraints']:
  if not c['validated']:raise ValueError('unvalidated captured snapshot constraint')
  out+='ALTER TABLE public.hand_state_snapshots ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
 for idx in snap['indexes']:
  if not idx['valid'] or not idx['ready']:raise ValueError('unqualified snapshot index')
  if 'hand_state_snapshots_pkey' not in idx['definition']:out+=idx['definition']+';\n'
 pause=json.loads((root/DATA/'installed-pause-relation.json').read_text())
 out+=pause['table_and_immutability_sql']
 for t in snap['triggers']:
  if t['internal']:continue
  out+=function({**t,'signature':t['function'],'definition':t['body']})
  out+=t['definition']+';\n'
  if t['state']!='O':raise ValueError('snapshot trigger unexpectedly disabled')
 cash_read=root/'scripts/ci/fixtures/satellite-qualifiers/entry-club-cancellation-cash-read.sql'
 out+=cash_read.read_text()+'\nCOMMIT;\n'
 # The maintained base predates the captured readiness authority. Compose all
 # original dependency bodies from Union's exact capture before its installer;
 # the migration still checks every original body and ACL itself.
 prerequisites=json.loads((root/DATA/'qualified-fee-custody-preimages.json').read_text())['functions']
 for r in prerequisites:
  if hashlib.md5(r['definition'].encode()).hexdigest()!=r.get('md5',r.get('definition_md5')):
   raise ValueError('captured custody prerequisite body changed: '+r['identity'])
  out+=function({**r,'signature':r['identity'],'acl':r['acl'].strip('{}').split(',')})
 # Install the exact frozen dependency with its real schema, deferred guards
 # and all nine preimage checks. No substitute fee authority or fake earnings.
 custody=(root/DATA/'qualified-fee-custody-source.sql').read_text()
 frozen=json.loads((root/DATA/'qualified-fee-custody-postimages.json').read_text())
 if hashlib.sha256(custody.encode()).hexdigest()!=frozen['migration_sha256']:
  raise ValueError('frozen fee custody dependency changed')
 out+=custody+'\n'
 expected=[{'signature':'public.'+name,'md5':hashlib.md5(body.encode()).hexdigest()} for name,body in frozen['functions'].items()]
 out+='DO $custody$ DECLARE r jsonb; BEGIN FOR r IN SELECT value FROM jsonb_array_elements('+js(expected)+") LOOP IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r->>'signature') AND md5(pg_get_functiondef(p.oid))=r->>'md5' AND pg_get_userbyid(p.proowner)='postgres') THEN RAISE EXCEPTION 'frozen custody postimage differs: %',r->>'signature'; END IF; END LOOP; END $custody$;\n"
 money_guard=json.loads((root/'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json').read_text())
 out+='\n'.join(function_sql(r) for r in money_guard['functions'])+'\nCREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN (\'CREATE FUNCTION\') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();\n'
 inputs=dict(base['source_sha256']);inputs.update({str(p.relative_to(root)):sha(p) for p in [root/DATA/'installed-terminal.json',root/DATA/'terminal-schema.json',root/'scripts/ci/breakfast_fixture.py',fee_path,root/'supabase/migrations/20260918082420_the_capture_authority_is_named_for_what_it_does.sql',root/'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json']})
 inputs[str(cash_read.relative_to(root))]=sha(cash_read)
 return out,inputs

def record_insert(table,rows):
 if not rows:return ''
 if isinstance(rows,dict): rows=[rows]
 # Captured generated values are compared by the verifier, never assigned.
 return "DO $load$ DECLARE cols text; BEGIN SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols FROM pg_attribute WHERE attrelid="+literal(table)+"::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''; EXECUTE 'INSERT INTO "+table+"('||cols||') SELECT '||cols||' FROM jsonb_populate_recordset(NULL::"+table+",$1)' USING "+js(rows)+"; END $load$;\n"

def opening(root):
 c=json.loads((root/DATA/'case.json').read_text());ph=json.loads((root/DATA/'physical.json').read_text())['evidence'];co=json.loads((root/DATA/'conflicts.json').read_text())['evidence'];money=json.loads((root/DATA/'ledger.json').read_text())['evidence']
 out="BEGIN;\nSET LOCAL session_replication_role=replica;\nDO $$ BEGIN IF current_database() !~ '^r46_mtt_isolation_' OR inet_server_addr() IS NOT NULL OR current_user<>'postgres' THEN RAISE EXCEPTION 'private fixture required'; END IF; END $$;\n"
 ids=sorted({p['user_id'] for p in c['players']}|{'2d1cd6c3-5700-4af9-a271-d4863fdab20d','46460000-0000-4000-8000-000000000001'})
 out+='INSERT INTO auth.users(id) VALUES '+','.join('('+literal(i)+')' for i in ids)+' ON CONFLICT(id) DO NOTHING;\n'
 for table in ['users','profiles']:
  out+='INSERT INTO public.'+table+'(id,username) VALUES '+','.join('('+literal(i)+','+literal('breakfast_'+str(n))+')' for n,i in enumerate(ids))+' ON CONFLICT(id) DO NOTHING;\n'
 out+="INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury) VALUES('"+c['club_id']+"',984561,'Private Breakfast qualification','46460000-0000-4000-8000-000000000001',0);\n"
 out+='INSERT INTO public.club_wallets(club_id) VALUES('+literal(c['club_id'])+');\n'
 out+='INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at) VALUES '+','.join('('+literal(c['club_id'])+','+literal(p['user_id'])+",'player','active',0,'2026-09-01T00:00:00Z')" for p in c['players'])+';\n'
 out+=record_insert('public.tournaments',[c['tournament']])+record_insert('public.tables',ph['tables'])+record_insert('public.tournament_players',c['players'])+record_insert('public.table_seats',ph['seats'])
 out+=record_insert('public.tournament_obligations',c['obligations'])+record_insert('public.tournament_payouts',c['payouts'])+record_insert('public.wallet_credit_idempotency',c['wallet_credit_idempotency'])
 out+=record_insert('public.tournament_entry_close_receipts',[c['entry_receipt']])
 # Nested JSON numeric scale participates in the original fee fingerprint.
 # Keep the independently retained PostgreSQL text lossless; ordinary JSON
 # float round-tripping would manufacture a different source identity.
 raw_fees=(root/DATA/'original-fees-lossless.json').read_text()
 if sorted(json.loads(raw_fees)[c['tournament']['id']],key=lambda r:r['id'])!=sorted(c['fee_charges'],key=lambda r:r['id']):
  raise ValueError('independent original fee captures disagree')
 out+='INSERT INTO public.rake_records SELECT r.* FROM jsonb_populate_recordset(NULL::public.rake_records,('+literal(raw_fees)+'::jsonb)->'+literal(c['tournament']['id'])+') r;\n'
 out+="DO $fees$ BEGIN IF (SELECT md5(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id)) FROM public.rake_records r WHERE r.tournament_id='f370585d-40ea-4085-bb8f-c7e8c74f3fb4') IS DISTINCT FROM 'f67bf12ee0b00c954b6f8403de9718fe' THEN RAISE EXCEPTION 'BREAKFAST_ORIGINAL_FEE_FIXTURE_IDENTITY'; END IF; END $fees$;\n"
 out+=record_insert('public.tournament_refund_entitlements',ph['entitlements'])+record_insert('public.hand_state_snapshots',co['active_snapshots'])+record_insert('public.engine_tournament_leases',ph['manager'])
 out+=record_insert('public.tournament_escrow',money['breakfast_escrow'])
 out+=record_insert('public.chip_ledger',json.loads((root/DATA/'full-chip-ledger.json').read_text())['evidence']['ledger'])
 out+=record_insert('public.wallet_transactions',json.loads((root/DATA/'full-wallet-transactions.json').read_text())['evidence']['wallets'])
 out+='SET LOCAL session_replication_role=origin;\nCOMMIT;\n'
 return out
