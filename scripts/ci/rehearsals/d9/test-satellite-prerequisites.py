"""Execute the exact migration against native dependency drift; require rollback."""
from pathlib import Path
import json
import subprocess

base = Path(__file__).resolve().parent
state = json.loads((base/'cluster.json').read_text())
assert state['database'] == 'd9_satellite_completion_v2'
assert state['cluster'].startswith('/tmp/ca-e2-owned-')
psql = ['/opt/homebrew/opt/postgresql@17/bin/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
        '-h', state['socket'], '-p', str(state['port']), '-U', 'postgres', '-d', state['database']]


def query(sql):
    return json.loads(subprocess.check_output(psql+['-Atc', sql], text=True))


def fingerprint():
    return query("""SELECT jsonb_build_object(
      'functions', (SELECT md5(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,
        pg_get_functiondef(p.oid),p.proowner,p.proacl) ORDER BY p.oid)::text)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='f'),
      'legacy_rows',(SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.tournament_id),
        '[]'::jsonb)::text) FROM public.tournament_legacy_finish_evidence e),
      'satellite_column',EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tournament_legacy_finish_evidence'
        AND column_name='satellite_contract_evidence'))""")


strict = 'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'
wrapper = 'public.fn_settle_satellite_tournament(uuid,uuid)'
definitions = query(f"SELECT jsonb_object_agg(oid::regprocedure::text,pg_get_functiondef(oid)) FROM pg_proc WHERE oid IN ('{strict}'::regprocedure,'{wrapper}'::regprocedure)")
strict_source = definitions[strict.removeprefix('public.')]
wrapper_source = definitions[wrapper.removeprefix('public.')]
cases = [
    ('strict_body', strict_source.replace('AS $function$', 'AS $function$\n-- deliberate native drift'), 'strict receipt authority differs'),
    ('strict_owner', f'ALTER FUNCTION {strict} OWNER TO service_role;', 'strict receipt private metadata differs'),
    ('strict_acl', f'GRANT EXECUTE ON FUNCTION {strict} TO authenticated;', 'strict receipt private metadata differs'),
    ('strict_config', f'ALTER FUNCTION {strict} SET search_path TO public,pg_temp;', 'strict receipt authority differs'),
    ('wrapper_body', wrapper_source.replace('AS $function$', 'AS $function$\n-- deliberate native drift'), 'public settlement wrapper differs'),
    ('wrapper_acl', f'GRANT EXECUTE ON FUNCTION {wrapper} TO authenticated;', 'public settlement metadata differs'),
]
before = fingerprint()
assert before['satellite_column'] is False
receipts = []
for name, mutation, expected in cases:
    # The outer transaction makes the deliberate drift local to this attempted
    # installation. The included migration bytes are unmodified. Its BEGIN is
    # harmlessly nested; ON_ERROR_STOP closes and rolls back on the refusal.
    script = base/(name+'-migration-refusal.sql')
    script.write_text('BEGIN;\n'+mutation+';\n\\i '+str(base/'integration.sql')+'\n')
    result = subprocess.run(psql+['-f', str(script)], text=True, capture_output=True)
    (base/(name+'-migration-refusal.log')).write_text(result.stdout+result.stderr)
    assert result.returncode != 0 and expected in result.stderr, (name, result.stderr)
    after = fingerprint()
    assert after == before, (name, after, before)
    receipts.append({'case': name, 'refused': True, 'unchangedAfterRollback': True, 'reason': expected})
(base/'dependency-refusal-receipt.json').write_text(json.dumps({
    'cases': receipts, 'before': before, 'after': fingerprint(), 'productionWrites': 0}, indent=2)+'\n')
print(json.dumps({'dependencyDriftRefusals': len(receipts), 'rollbackUnchanged': True}))
