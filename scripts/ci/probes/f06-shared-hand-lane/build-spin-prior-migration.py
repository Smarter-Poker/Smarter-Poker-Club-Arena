"""Extend only the exact installed mixed disposition, preserving its old ABI."""
from pathlib import Path
import json
import hashlib
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MIGRATION = 'supabase/migrations/20260918092117_spin_interrupted_hands_retain_their_prior_committed_stacks.sql'


def retention_checks():
    source = (HERE / 'spin-prior-retention-prefix.sql').read_text()
    if hashlib.sha256(source.encode()).hexdigest() != '0423ccbfe95f8ef980bc0699ca3ad873648e2dc620b9d1418ab08faf1343af9d':
        raise ValueError('sealed retention prefix changed')
    checks = []
    functions = re.findall(r'CREATE FUNCTION ([^(]+)\((.*?)\)(.*?)AS \$function\$(.*?)\$function\$;', source, re.S)
    if len(functions) != 5:
        raise ValueError('sealed retention function inventory changed')
    for name, args, declaration, body in functions:
        signature = name + ('(jsonb)' if args else '()')
        config = 'search_path=pg_catalog, public, extensions' if name.startswith('public.') else 'search_path=pg_catalog'
        acl = '{postgres=X/postgres,service_role=X/postgres}' if name.startswith('public.') else '{postgres=X/postgres}'
        result = 'jsonb' if name.startswith('public.') else ('void' if 'assert_retained' in name else 'trigger')
        checks.append(" IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('%s') AND md5(p.prosrc)='%s' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='%s' AND to_jsonb(p.proconfig)='%s'::jsonb AND l.lanname='plpgsql' AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f' AND p.pronargdefaults=0 AND p.prorettype='%s'::regtype) THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED: %%','%s'; END IF;" % (signature, hashlib.md5(body.encode()).hexdigest(), acl, json.dumps([config]), result, signature))
    triggers = [
      ('smarter_private.hand_submissions', 'hand_submission_immutable', 'BEFORE DELETE OR UPDATE', 'ROW', 'smarter_private.hand_submission_immutable()'),
      ('smarter_private.hand_submission_dispositions', 'hand_submission_disposition_immutable', 'BEFORE DELETE OR UPDATE', 'ROW', 'smarter_private.hand_submission_immutable()'),
      ('smarter_private.hand_submissions', 'hand_submission_no_truncate', 'BEFORE TRUNCATE', 'STATEMENT', 'smarter_private.hand_submission_immutable()'),
      ('smarter_private.hand_submission_dispositions', 'hand_submission_disposition_no_truncate', 'BEFORE TRUNCATE', 'STATEMENT', 'smarter_private.hand_submission_immutable()'),
      ('smarter_private.f06_hand_permits', 'f06_retained_submission_guard', 'AFTER UPDATE OF state', 'ROW', 'smarter_private.f06_retained_submission_guard()'),
      ('public.hand_state_snapshots', 'hand_submission_snapshot_guard', 'AFTER INSERT OR UPDATE OF is_complete', 'ROW', 'smarter_private.hand_submission_snapshot_guard()'),
      ('smarter_private.f06_no_start_continuations', 'f06_no_start_continuation_immutable', 'BEFORE DELETE OR UPDATE', 'ROW', 'smarter_private.f06_no_start_continuation_immutable()'),
      ('smarter_private.f06_no_start_continuations', 'f06_no_start_continuation_no_truncate', 'BEFORE TRUNCATE', 'STATEMENT', 'smarter_private.f06_no_start_continuation_immutable()'),
    ]
    for table, name, event, each, function in triggers:
        definition = f'CREATE TRIGGER {name} {event} ON {table} FOR EACH {each} EXECUTE FUNCTION {function}'
        checks.append(" IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='%s'::regclass AND tgname='%s' AND tgenabled='O' AND tgfoid=to_regprocedure('%s') AND pg_get_triggerdef(oid)='%s') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %%','%s'; END IF;" % (table, name, function, definition, name))
    tables = {
      'smarter_private.hand_submissions': [
        ['submission_id','uuid',True,None],['table_id','uuid',True,None],['hand_number','bigint',True,None],
        ['instance_id','text',True,None],['lease_generation','uuid',True,None],['request','jsonb',True,None],
        ['request_hash','text',True,None],['retained_at','timestamp with time zone',True,'clock_timestamp()']],
      'smarter_private.hand_submission_dispositions': [
        ['table_id','uuid',True,None],['hand_number','bigint',True,None],['permit_id','uuid',False,None],
        ['disposition','text',True,None],['submission_id','uuid',False,None]],
      'smarter_private.f06_no_start_continuations': [
        ['receipt_id','uuid',True,'gen_random_uuid()'],['break_id','uuid',True,None],['permit_id','uuid',True,None],
        ['tournament_id','uuid',True,None],['table_id','uuid',True,None],['lifecycle','bigint',True,None],
        ['hand_number','bigint',True,None],['original_generation','uuid',True,None],['current_generation','uuid',True,None],
        ['park','jsonb',True,None],['permit','jsonb',True,None],['roster','jsonb',True,None],
        ['prior_committed','jsonb',True,None],['created_at','timestamp with time zone',True,'clock_timestamp()']],
    }
    constraints = {
      'smarter_private.hand_submissions': [
        'PRIMARY KEY (submission_id)','UNIQUE (table_id, hand_number)',
        'CHECK ((hand_number > 0))','CHECK ((length(btrim(instance_id)) > 0))',
        "CHECK ((jsonb_typeof(request) = 'object'::text))", "CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))"],
      'smarter_private.hand_submission_dispositions': [
        'PRIMARY KEY (table_id, hand_number)','UNIQUE (permit_id)','CHECK ((hand_number > 0))',
        "CHECK ((disposition = ANY (ARRAY['retained'::text, 'disposed'::text])))",
        "CHECK (((disposition = 'retained'::text) = (submission_id IS NOT NULL)))"],
      'smarter_private.f06_no_start_continuations': [
        'PRIMARY KEY (receipt_id)','UNIQUE (break_id)','UNIQUE (permit_id)','UNIQUE (table_id, hand_number)'],
    }
    for table, columns in tables.items():
        coljson = json.dumps(columns).replace("'", "''")
        conjson = json.dumps(sorted(constraints[table])).replace("'", "''")
        checks.append(""" IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='%s'::regclass AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='%s'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='%s'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND (NOT k.convalidated OR k.condeferrable))
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED: %%','%s'; END IF;""" % (table, coljson, conjson, table))
    return '\n'.join(checks)


def render():
    original = (HERE / 'mixed-authority.sql').read_text()
    body = re.search(r'CREATE FUNCTION public.fn_f06_abort_mixed_unsettled_generation\([\s\S]*?END \$function\$;', original)[0]
    body = body.replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ', 1)
    changes = [
        ('v_break_id uuid; player_count integer; hu boolean;',
         'v_break_id uuid; player_count integer; hu boolean; historical jsonb; retired_dispatch jsonb;\n v_dispatch smarter_private.f06_hand_dispatch; v_refusal public.financial_alerts;'),
        ("FOR h IN SELECT * FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) ORDER BY permit_id LOOP",
         "FOR h IN SELECT * FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) ORDER BY permit_id LOOP\n retired_dispatch:=NULL;\n SELECT x INTO expected_item FROM jsonb_array_elements(p_expected->'hands') x WHERE x->'permit'->>'permit_id'=h.permit_id::text;"),
        (' OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)\n', ''),
        (" RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;",
         " RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;\n" + (HERE / 'spin-prior-ended-dispatch.sql').read_text().rstrip()),
        ('prior_proof:=NULL;', 'prior_proof:=NULL; historical:=NULL;'),
        ("AND COALESCE((x->>'individualAnteInvested')::numeric,0)=0))",
         "-- Individual MTT antes are already included in dead and total investment.\n AND (COALESCE((x->>'individualAnteInvested')::numeric,0)=0\n OR (event.format_contract IN ('mtt-v1','mtt-v2')\n AND COALESCE((x->>'individualAnteInvested')::numeric,0) BETWEEN 0 AND COALESCE((x->>'deadInvested')::numeric,0)))))"),
        ('prior_proof:=smarter_private.f06_prior_committed_stacks(h.permit_id,expected_item->\'prior\',roster);',
         'prior_proof:=smarter_private.f06_prior_committed_stacks(h.permit_id,expected_item->\'prior\',roster);\n' + (HERE / 'spin-prior-boundary.sql').read_text().rstrip()),
        ("'break_id',v_break_id,'prior',prior_proof));",
         "'break_id',v_break_id,'prior',prior_proof) || CASE WHEN historical IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('interruption',historical) END);"),
        ("OR (NOT hu AND prior_based=1 AND (event.format_contract NOT IN ('mtt-v1','mtt-v2') OR known_started<1))",
         "OR (NOT hu AND prior_based=1 AND event.format_contract<>'spin-v1'\n AND (event.format_contract NOT IN ('mtt-v1','mtt-v2') OR known_started<1))"),
    ]
    for old, new in changes:
        if body.count(old) != 1:
            raise ValueError('exact mixed source changed: ' + old)
        body = body.replace(old, new)
    pins = [
        ('public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)', '641225958b8b24426cb222e336e2a5ec', '{postgres=X/postgres,service_role=X/postgres}'),
        ('smarter_private.f06_prior_committed_stacks(uuid,jsonb,jsonb)', '4f914e43de444919d99229775a2ac2e5', '{postgres=X/postgres}'),
        ('smarter_private.f06_generation_aborted(uuid,uuid)', '3530559a94372866bf3baec006a8fd3c', '{postgres=X/postgres}'),
        ('smarter_private.f06_aborted_hand_guard()', '56c232740eb495dd2e2164159dfe782c', '{postgres=X/postgres}'),
        ('smarter_private.f06_immutable_identity()', '0fe40a0711ef6d196c6883d3b9e8b86f', '{postgres=X/postgres}'),
        ('smarter_private.f06_source_guard()', 'de1b25f96d2c08bf20213c0e194ae261', '{postgres=X/postgres}'),
        ('smarter_private.f06_try_lane(uuid)', '78a3a191b9991b0a3a343db39de335aa', '{postgres=X/postgres}'),
        ('public.fn_stamp_seat_occupancy()', '4d2645a24bd3b88d7ffc51097b37d640', '{postgres=X/postgres}'),
        ('smarter_private.f06_cancelled_preparation_writer_guard()', 'a7467e2cb64bab202a359eed42432299', '{postgres=X/postgres}'),
    ]
    continuation = json.loads((HERE / 'spin-prior-continuation-postimages.json').read_text())
    if hashlib.sha256((HERE / 'spin-prior-continuation-dependency.sql').read_bytes()).hexdigest() != continuation['source_sha256']:
        raise ValueError('sealed continuation dependency changed')
    pins += [(r['signature'], r['full_md5'], r['acl']) for r in continuation['functions']
             if r['signature'] == 'smarter_private.f06_no_start_continuation_immutable()']
    pins += [(r['identity'] if '.' in r['identity'].split('(')[0] else 'public.' + r['identity'],
              r['definition_md5'], r['acl'])
             for r in json.loads((HERE / 'spin-prior-refusal-preimages.json').read_text())]
    checks = '\n'.join(" IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('%s') AND md5(pg_get_functiondef(oid))='%s' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='%s') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %%','%s'; END IF;" % (*p, p[0]) for p in pins)
    return '''-- The interrupted Spin hand keeps the last canonical committed stacks.
-- Completed snapshots and actual refusal records remain intact and are bound
-- into the immutable zero-credit disposition. They never establish no-start.
-- Only the existing mixed RPC changes. No data, money, lease or snapshot is
-- changed by installation. Version reserved by scripts/new-migration.mjs.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: table_seats.zzz_stamp_seat_occupancy because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
SET LOCAL search_path=pg_catalog,public;
DO $preimages$
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
''' + checks + '\n' + retention_checks() + '''
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass
 AND tgname='a00_f06_cancelled_preparation' AND tgenabled='O' AND tgtype=23
 AND tgfoid=to_regprocedure('smarter_private.f06_cancelled_preparation_writer_guard()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
 AND tgname='a00_f06_source_seat' AND tgenabled='O' AND tgtype=31
 AND tgfoid=to_regprocedure('smarter_private.f06_source_guard()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass
 AND tgname='a00_f06_source_roster' AND tgenabled='O' AND tgtype=31
 AND tgfoid=to_regprocedure('smarter_private.f06_source_guard()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_BINDING_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
 AND tgname='zzz_stamp_seat_occupancy' AND tgenabled='O' AND tgtype=23 AND tgqual IS NULL
 AND tgfoid=to_regprocedure('public.fn_stamp_seat_occupancy()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy()')
 OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='occupancy_id'
 WHERE i.indexrelid=to_regclass('public.table_seats_occupancy_id_unique') AND i.indrelid='public.table_seats'::regclass
 AND i.indisvalid AND i.indisready AND i.indisunique AND i.indnkeyatts=1 AND i.indnatts=1
 AND i.indkey::text=a.attnum::text AND i.indpred IS NULL AND i.indexprs IS NULL) THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_OCCUPANCY_CHANGED'; END IF;
END $preimages$;
''' + body + '''
REVOKE ALL ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) TO service_role;
COMMIT;
'''


if __name__ == '__main__':
    target = ROOT / MIGRATION
    sql = render()
    if '--check' in sys.argv:
        if target.read_text() != sql:
            raise SystemExit('Spin prior migration differs from its source-bound composition')
    else:
        target.write_text(sql)
