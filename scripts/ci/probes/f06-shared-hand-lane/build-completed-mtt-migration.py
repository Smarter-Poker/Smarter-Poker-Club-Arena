"""Extend the exact mixed authority; keep existing Spin and active-hand branches."""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MIGRATION = 'supabase/migrations/20260918130733_completed_unaccepted_mtt_snapshots_retain_their_committed_st.sql'
PREDECESSOR = 'supabase/migrations/20260918092117_spin_interrupted_hands_retain_their_prior_committed_stacks.sql'


def paid_checks():
    catalog = json.loads((HERE / 'completed-mtt-paid-preimages.json').read_text())
    checks = []
    for row in catalog['functions']:
        sig = 'public.' + row['signature']
        checks.append(" IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('%s') AND md5(pg_get_functiondef(oid))='%s' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_AUTHORITY_CHANGED'; END IF;" % (sig, row['definition_md5']))
    for row in catalog['triggers']:
        definition = row['definition'].replace("'", "''")
        checks.append(" IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_paid_stack_custody_receipts'::regclass AND tgname='%s' AND tgenabled='O' AND pg_get_triggerdef(oid)='%s') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_BINDING_CHANGED'; END IF;" % (row.get('name', row.get('tgname')), definition))
    columns = json.dumps(catalog['columns']).replace("'", "''")
    constraints = json.dumps(catalog['constraints']).replace("'", "''")
    checks.append(""" IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.tournament_paid_stack_custody_receipts'::regclass
 AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='%s'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='%s'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND NOT k.convalidated)
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_SCHEMA_CHANGED'; END IF;""" % (columns, constraints))
    return '\n'.join(checks)


def render():
    source = (ROOT / PREDECESSOR).read_text()
    if hashlib.sha256(source.encode()).hexdigest() != 'b59e2b0c781a8320c53ca43569093bca70f53ceabeb7585943ec13f59669bd62':
        raise ValueError('Mixed predecessor source changed')
    header, body = source.split('CREATE OR REPLACE FUNCTION public.fn_f06_abort_mixed_unsettled_generation', 1)
    header = header.replace('641225958b8b24426cb222e336e2a5ec', '9a655cf82edac7513824335a4091e3b8')
    header = header.replace('DO $preimages$', (HERE / 'completed-mtt-index-contract.sql').read_text() + '\nDO $preimages$')
    header = header.replace('END $preimages$;', paid_checks() + '\nEND $preimages$;')
    body = 'CREATE OR REPLACE FUNCTION public.fn_f06_abort_mixed_unsettled_generation' + body
    changes = [
        ('v_dispatch smarter_private.f06_hand_dispatch;', 'paid public.tournament_paid_stack_custody_receipts;\n v_dispatch smarter_private.f06_hand_dispatch;'),
        ('AND NOT is_complete FOR UPDATE;\n IF FOUND THEN', """AND NOT is_complete FOR UPDATE;
 IF NOT FOUND AND expected_item#>>'{interruption,kind}'='completed_unaccepted_mtt' THEN
 SELECT * INTO snap FROM public.hand_state_snapshots WHERE id=(expected_item->>'snapshot_id')::uuid FOR UPDATE;
 IF NOT FOUND OR snap.table_id IS DISTINCT FROM h.table_id OR snap.hand_number IS DISTINCT FROM h.hand_number
 OR NOT snap.is_complete THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 IF snap.id IS NOT NULL THEN"""),
        ("RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;\n ELSE", "RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;\n" + (HERE / 'completed-mtt-boundary.sql').read_text().rstrip() + '\n ELSE'),
        ('WHERE id IN(SELECT a.snapshot_id FROM smarter_private.f06_mixed_abort_hands a WHERE a.receipt_id=p_receipt_id);', 'WHERE NOT is_complete AND id IN(SELECT a.snapshot_id FROM smarter_private.f06_mixed_abort_hands a WHERE a.receipt_id=p_receipt_id);'),
    ]
    for old, new in changes:
        if body.count(old) != 1:
            raise ValueError('Exact predecessor boundary changed: ' + old)
        body = body.replace(old, new)
    return ('-- Additive completed-but-unaccepted MTT snapshot boundary. No data or money changes on install.\n'
            '-- Exact paid custody, original snapshot, private-card hashes and financial receipts remain immutable.\n'
            '-- Only the existing mixed disposition changes; original/current writer fences are preserved.\n' + header + body)


if __name__ == '__main__':
    target = ROOT / MIGRATION
    sql = render()
    if '--check' in sys.argv:
        if target.read_text() != sql:
            raise SystemExit('Completed MTT migration differs from exact source composition')
    else:
        target.write_text(sql)
