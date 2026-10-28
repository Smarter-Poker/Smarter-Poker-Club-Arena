"""Install captured canonical document owners in an isolated native database only.

No production connection, credential, financial data or substituted document owner.
External FK targets and unreachable cashier/messenger branches are outside this proof.
"""
import json, re, pathlib, hashlib

def install(q, root, fixture):
    packets = [json.loads((fixture / (n + '.json')).read_text()) for n in [
        'correction-document-owners', 'correction-delivery-owner',
        'correction-delivery-closure', 'correction-invoice-triggers',
        'document-launch-closure','document-diamond-category','document-launch-actor-closure','document-connected-trigger-owners','document-freeze-bypass-closure']]
    tables = {t['name']: t for p in packets for t in p.get('relations', [])}
    needed = ['accounting_correction_documents','accounting_cashier_events',
        'accounting_credit_change_documents_v1','accounting_credit_reduction_operations_v1',
        'accounting_invoice_counters','accounting_invoice_deliveries','settlement_invoices',
        'ca_launch_reset_wallet_movements','ca_launch_reset_operations',
        'ca_launch_reset_positions','ca_launch_reset_rows']
    types = {'16':'boolean','20':'bigint','21':'smallint','23':'integer','25':'text',
        '1700':'numeric','1184':'timestamp with time zone','2950':'uuid',
        '2951':'uuid[]','3802':'jsonb','1009':'text[]','1186':'interval','1082':'date'}
    for name in needed:
        t = tables[name]
        cols = []
        for c in t['columns']:
            a = c.get('attribute',c); typ = c.get('type') or c.get('formatted_type') or types[a['atttypid']]
            if typ=='numeric' and a.get('atttypmod',-1)!=-1:
                v=a['atttypmod']-4;typ='numeric(%d,%d)' % (v>>16,v&65535)
            cols.append('"'+a.get('attname',a.get('name'))+'" '+typ+(' DEFAULT '+c['default'] if c.get('default') else '')+(' NOT NULL' if a.get('attnotnull',a.get('notnull')) else ''))
        q('CREATE TABLE public.'+name+'('+','.join(cols)+');')
        for c in t['constraints'] or []:
            if c['definition'].startswith(('PRIMARY KEY','UNIQUE','CHECK')):
                q('ALTER TABLE '+name+' ADD CONSTRAINT "'+c.get('name',(c.get('metadata') or {}).get('conname'))+'" '+c['definition']+';')
    bootstrap=(root/'scripts/ci/fixtures/launch-reset/original-bootstrap.sql').read_text()
    
    q('CREATE SEQUENCE hand_id_seq;')
    for canonical_type in ['unions','union_wallets','engine_maintenance_thaws','rake_records','accounting_tournament_fee_custody_resolutions','accounting_tournament_fee_custody_obligations','tournament_terminal_settlements','accounting_tournament_fee_owner_bases','union_pnl_transaction_frames']:
        declaration=re.search(r'CREATE TABLE public\.'+re.escape(canonical_type)+r' \(.*?\n\)(?:\nWITH \([^;]*\))?;',bootstrap,re.S).group(0)
        assert declaration.count('CREATE TABLE ')==1,canonical_type
        q(declaration)
    owners = {f['signature']:f for p in packets for f in p.get('owners',[])}
    for f in owners.values():
        assert hashlib.md5(f['definition'].encode()).hexdigest()==f['md5'],f['signature']
        q('SET check_function_bodies=off;'+f['definition'])
    for t in ['settlement_invoices','chip_ledger']:
        for z in tables[t]['triggers'] or []:
            n=z.get('name',(z.get('metadata') or {}).get('tgname'))
            if n in ['accounting_transfer_document','accounting_invoice_deliver','accounting_invoice_immutable','trg_weekly_statement_issue_settled','original_union_pnl_flow','zz_tournament_accounting_credit_ledger','zz_ca_funded_return_journal','cancelled_tournament_evidence_is_immutable','terminal_tournament_evidence_is_immutable','satellite_transfer_ledger_is_immutable','aaa_launch_closing_leg','zz_freeze_guard']:
                q(z['definition']+';')
    return owners
