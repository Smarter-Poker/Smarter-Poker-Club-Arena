"""Compare the real held-fee owner before/after batching its commission writes.

Only the private native database is used. Every economic scene, synthetic
profile/agreement/closed period, and trigger instrumentation rolls back. The
candidate itself remains installed for the maintained owner's final checks.
"""
import json
import re
import subprocess


def qualify(root, fix, out, cmd, run, schema):
    binding = json.loads((fix / 'source-binding.json').read_text())
    candidate = (root / binding['commission_batch_migration']).read_text()
    scene = (fix / 'commission-batch-scene.sql').read_text()
    recognition = 'public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'
    rollup = 'public.trg_agent_commission_rollup_insert()'
    single = 'public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb)'
    owner = 'public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)'

    def definition(identity):
        return subprocess.check_output(cmd + ['-At', '-c',
            "SELECT pg_get_functiondef('" + identity + "'::regprocedure)"], text=True).rstrip() + '\n'

    original = {identity: definition(identity) for identity in (recognition, rollup, single, owner)}
    instrumented, count = re.subn(r'\nBEGIN\n',
        "\nBEGIN\n  PERFORM nextval('held_fee_fixture.commission_rollup_calls');\n",
        original[rollup], count=1)
    if count != 1:
        raise AssertionError('Real commission rollup instrumentation boundary changed')
    # Model ordinary callers without changing their economic owner: remove only
    # commission relation admission in this private, rolled-back owner body.
    # The separately required player_stats admission and all other code remain.
    ordinary_owner, count = re.subn(
        r'(?m)^ LOCK TABLE public\.agent_commissions, public\.player_stats\n'
        r'  IN SHARE ROW EXCLUSIVE MODE NOWAIT;$',
        ' LOCK TABLE public.player_stats\n  IN SHARE ROW EXCLUSIVE MODE NOWAIT;',
        original[owner])
    if count != 1:
        raise AssertionError('Private ordinary-caller admission boundary changed')

    observations = {}

    def phase(name):
        observations[name] = {}
        for mode in ('profile', 'retired', 'zero', 'closed_empty_tiers', 'ordinary_fallback'):
            expected = (2 if mode == 'ordinary_fallback' else
                1 if name == 'after' else (0 if mode == 'zero' else 2))
            sql = ("BEGIN;SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';\n"
                "CREATE SEQUENCE held_fee_fixture.commission_rollup_calls;\n" + instrumented + ';\n'
                + (ordinary_owner + ';\n' if mode == 'ordinary_fallback' else '') +
                "SELECT set_config('held_fee_fixture.commission_case','" + mode + "',true);\n"
                "SELECT set_config('held_fee_fixture.commission_rollups','" + str(expected) + "',true);\n"
                + scene + '\nROLLBACK;\n')
            label = 'commission-batch-' + name + '-' + mode
            run(sql, label)
            matches = re.findall(r'NOTICE:\s+COMMISSION_BATCH_RESULT (\{[^\n]*\})',
                (out / (label + '.log')).read_text())
            if len(matches) != 1:
                raise AssertionError('Expected one native commission result: ' + label)
            observations[name][mode] = json.loads(matches[0])
        for identity in (recognition, rollup, single, owner):
            if identity != recognition and definition(identity) != original[identity]:
                raise AssertionError('Scene changed a retained production function: ' + identity)

    phase('before')
    # A deployment must refuse a different predecessor, including function SET
    # options, and leave its schema/ACL untouched. No economic scene is replayed.
    run('ALTER FUNCTION ' + recognition + " SET statement_timeout='31s';",
        'commission-batch-predecessor-drift')
    before_schema = schema()
    path = out / 'commission-batch-install-refused.sql'
    path.write_text(candidate)
    result = subprocess.run(cmd + ['-f', str(path)], capture_output=True, text=True)
    (out / 'commission-batch-install-refused.log').write_text(result.stdout + result.stderr)
    if (result.returncode == 0 or 'tournament commission batch predecessor changed' not in result.stderr
            or schema() != before_schema):
        raise AssertionError('Commission predecessor drift must refuse without schema/ACL changes')
    run(original[recognition] + ';', 'commission-batch-predecessor-restored')
    run(candidate, 'commission-batch-install')
    phase('after')

    for mode in observations['before']:
        old, new = observations['before'][mode], observations['after'][mode]
        if old['economic'] != new['economic']:
            raise AssertionError('Commission batch changed native economics: ' + mode)
        if mode in ('profile', 'retired') and not old['rollup_calls'] > new['rollup_calls'] == 1:
            raise AssertionError('Positive earned tiers did not use one real statement rollup')
        if mode == 'ordinary_fallback' and not old['rollup_calls'] == new['rollup_calls'] == 2:
            raise AssertionError('Ordinary caller changed its per-source commission write path')
    for name in ('before', 'after'):
        if observations[name]['ordinary_fallback']['economic'] != observations[name]['profile']['economic']:
            raise AssertionError('Relation admission changed the earned financial result: ' + name)
    assertions = sum(len(re.findall(r'NOTICE:\s+PASS ', p.read_text()))
        for p in out.glob('commission-batch-*.log'))
    # Three admitted scenes have five assertions each, one refusal has two,
    # and the ordinary fallback has six, on both sides of the migration.
    if assertions != 46:
        raise AssertionError('Expected 46 commission batch assertions, observed ' + str(assertions))
    evidence = {
        'status': 'passed', 'assertions': assertions, 'before_after': observations,
        'predecessor_drift_refusal': True, 'unchanged_single_source_and_real_rollup': True,
        'ordinary_caller_retains_two_per_source_rollups': True,
        'limitations': 'Private native retained 27-source event; synthetic profiles and recorded '
            'agreements. All economic scenes roll back. Timing is observational, with no '
            'performance threshold or production timing claim. Existing owner qualification '
            'continues to cover authorization, replay, immutable sources and full conservation.'}
    (out / 'commission-batch-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    return evidence
