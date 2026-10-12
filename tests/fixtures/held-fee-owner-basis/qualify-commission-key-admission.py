"""Qualify held-fee admission against PR5676's actual commission club key.

Two private PG17 sessions reproduce the old wait with the real owner and real
rollup trigger. All financial calls and instrumentation roll back. The new
trigger is derived from its protected migration, never a substitute trigger.
"""
import json
import re
import select
import subprocess


def qualify(root, fix, out, cmd, run, schema):
    binding = json.loads((fix / 'source-binding.json').read_text())
    candidate = (root / binding['commission_key_admission_migration']).read_text()
    upstream_path = 'supabase/migrations/20261001000000_the_chip_estate_takes_its_locks_in_one_order.sql'
    upstream = (root / upstream_path).read_text()
    recognition = 'public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'
    rollup = 'public.trg_agent_commission_rollup_insert()'
    owner = 'public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)'
    single = 'public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb)'
    trigger_md5 = 'c7e84377219a39d955783d0feae6642b'
    base = cmd[:cmd.index('-c')]
    call = ("public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),"
        "jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)))")

    def definition(identity):
        return subprocess.check_output(cmd + ['-At', '-c',
            "SELECT pg_get_functiondef('" + identity + "'::regprocedure)"], text=True).rstrip() + '\n'

    original = {identity: definition(identity) for identity in (recognition, rollup, owner, single)}
    # Before installing the required trigger, the candidate must refuse rather
    # than claim compatibility with the older fixture's projection function.
    before_schema = schema()
    path = out / 'commission-key-old-trigger-refused.sql'
    path.write_text(candidate)
    refused = subprocess.run(cmd + ['-f', str(path)], capture_output=True, text=True, timeout=12)
    (out / 'commission-key-old-trigger-refused.log').write_text(refused.stdout + refused.stderr)
    if (refused.returncode == 0 or 'held_fee_commission_key_predecessor_changed' not in refused.stderr
            or schema() != before_schema):
        raise AssertionError('Key admission must refuse the old trigger without schema/ACL changes')

    # Execute only the exact rollup substitution tuple from PR5676. Installing
    # the unrelated upstream wallet/horse/cash changes is outside this scene.
    start = upstream.index("    ('trg_agent_commission_rollup_insert()',")
    end = upstream.index("    ('fn_credit_agent_commissions_batch(jsonb)',", start)
    row = upstream[start:end].strip()
    if not row.endswith('),'):
        raise AssertionError('Upstream commission trigger substitution boundary changed')
    install_trigger = """BEGIN;
DO $native_trigger$
DECLARE spec record;before_definition text;after_definition text;
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
  OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN
  RAISE EXCEPTION 'private_pg17_fixture_required'; END IF;
 SELECT * INTO spec FROM (VALUES
""" + row[:-1] + """
 ) AS pinned(identity,before_md5,after_md5,needle,replacement);
 before_definition:=pg_get_functiondef(('public.'||spec.identity)::regprocedure);
 IF spec.before_md5<>'50cb43eb54b7924b39c25b9816f450a0'
  OR spec.after_md5<>'c7e84377219a39d955783d0feae6642b'
  OR md5(before_definition)<>spec.before_md5
  OR (length(before_definition)-length(replace(before_definition,spec.needle,'')))/length(spec.needle)<>1 THEN
  RAISE EXCEPTION 'upstream_commission_trigger_predecessor_changed'; END IF;
 EXECUTE replace(before_definition,spec.needle,spec.replacement);
 after_definition:=pg_get_functiondef(('public.'||spec.identity)::regprocedure);
 PERFORM held_fee_fixture.assert(md5(after_definition)=spec.after_md5,
  'Commission key fixture uses the exact PR5676 trigger installed in production');
END $native_trigger$;
COMMIT;
"""
    run(install_trigger, 'commission-key-upstream-trigger')
    actual_trigger = definition(rollup)

    def instrument(body, sequence):
        changed, count = re.subn(r'\nBEGIN\n',
            "\nBEGIN\n PERFORM nextval('held_fee_fixture." + sequence + "');\n", body, count=1)
        if count != 1:
            raise AssertionError('Commission key instrumentation boundary changed')
        return changed

    def parsed(label, marker):
        matches = re.findall(r'NOTICE:\s+' + marker + r' (\{[^\n]*\})',
            (out / (label + '.log')).read_text())
        if len(matches) != 1:
            raise AssertionError('Expected one native commission key result: ' + label)
        return json.loads(matches[0])

    def end_actor(actor):
        if actor.poll() is None:
            try:
                return actor.communicate('ROLLBACK;\n', timeout=5)
            except subprocess.TimeoutExpired:
                actor.kill()
                actor.communicate()
                raise AssertionError('Private commission key peer failed to release')
        return actor.communicate(timeout=5)

    def key_actor():
        actor = subprocess.Popen(base + ['-At', '-v', 'VERBOSITY=verbose'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # DO suppresses the void SELECT output: only one readiness line reaches
        # the pipe, so readiness does not depend on TextIO read-ahead buffering.
        actor.stdin.write("BEGIN;SET statement_timeout='5s';SET lock_timeout='0';"
            "DO $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended("
            "'agent-commission:'||(SELECT club_id::text FROM held_fee_fixture.agent),0));END $$;"
            "SELECT 'KEY_READY';\n")
        actor.stdin.flush()
        if (not select.select([actor.stdout], [], [], 7)[0]
                or actor.stdout.readline().strip() != 'KEY_READY'):
            end_actor(actor)
            raise AssertionError('Private peer did not acquire the exact contributor commission key')
        return actor

    observations = {}

    def busy(name):
        actor = key_actor()
        try:
            expected = ("code='57014' AND position('pg_advisory_xact_lock' IN context)>0 "
                "AND position('trg_agent_commission_rollup_insert' IN context)>0"
                if name == 'before' else "code='55000' AND message='held_fee_commission_club_busy' "
                "AND position('fn_recognize_accounting_tournament_fees' IN context)>0")
            sql = ("BEGIN;SET LOCAL statement_timeout='2s';SET LOCAL lock_timeout='0';"
                "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';\n"
                "CREATE SEQUENCE held_fee_fixture.commission_key_attempts;\n"
                + instrument(definition(recognition), 'commission_key_attempts') + ';\n' + """
DO $busy$
DECLARE state jsonb;code text;message text;context text;started timestamptz;elapsed_ms numeric;attempts bigint;
BEGIN
 state:=held_fee_fixture.snapshot();started:=clock_timestamp();
 BEGIN
  PERFORM """ + call + ";\n" + """
 EXCEPTION WHEN query_canceled OR OTHERS THEN
  code:=SQLSTATE;message:=SQLERRM;GET STACKED DIAGNOSTICS context=PG_EXCEPTION_CONTEXT;
 END;
 elapsed_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO attempts FROM held_fee_fixture.commission_key_attempts;
 PERFORM held_fee_fixture.assert(""" + expected + ", 'Commission key " + name + " refuses through the real owner at the expected boundary');\n" + """
 PERFORM held_fee_fixture.assert(state=held_fee_fixture.snapshot(),
  'Commission key refusal leaves all original financial rows unchanged');
 PERFORM held_fee_fixture.assert(attempts=1,
  'Commission key refusal escapes the settlement owner without retrying recognition');
 RAISE NOTICE 'COMMISSION_KEY_RESULT %',jsonb_build_object('sqlstate',code,'message',message,
  'owner_elapsed_ms',elapsed_ms,'recognition_attempts',attempts,'financial_snapshot_unchanged',true,'context',context);
END $busy$;
ROLLBACK;
""")
            label = 'commission-key-' + name + '-busy'
            run(sql, label)
            result = parsed(label, 'COMMISSION_KEY_RESULT')
            if actor.poll() is not None:
                raise AssertionError('Commission key peer exited before the owner refusal')
            # The cash-shaped peer still owns its key. After owner rollback its
            # ordinary relation admission must succeed immediately, with no DML.
            output, error = actor.communicate(
                "LOCK TABLE public.agent_commissions IN ROW EXCLUSIVE MODE NOWAIT;"
                "SELECT 'RELATION_ADMITTED';ROLLBACK;\n", timeout=7)
            (out / (label + '-peer.log')).write_text(output + error)
            if actor.returncode or 'RELATION_ADMITTED' not in output:
                raise AssertionError('Owner refusal retained a commission relation lock: ' + error)
            result['peer_relation_admitted_after_rollback'] = True
            return result
        finally:
            end_actor(actor)

    # Reuse the existing actual-owner financial comparison, including the real
    # row guard, exact agent counters and deferred terminal receipt. Its normal
    # caller scene omits only commission relation admission, then rolls back.
    scene = (fix / 'commission-batch-scene.sql').read_text()
    ordinary_owner, count = re.subn(
        r'(?m)^ LOCK TABLE public\.agent_commissions, public\.player_stats\n'
        r'  IN SHARE ROW EXCLUSIVE MODE NOWAIT;$',
        ' LOCK TABLE public.player_stats\n  IN SHARE ROW EXCLUSIVE MODE NOWAIT;', original[owner])
    if count != 1:
        raise AssertionError('Ordinary owner admission boundary changed')

    def free(name, ordinary=False):
        mode = 'ordinary_fallback' if ordinary else 'profile'
        sql = ("BEGIN;SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';\n"
            "CREATE SEQUENCE held_fee_fixture.commission_rollup_calls;\n"
            + instrument(actual_trigger, 'commission_rollup_calls') + ';\n'
            + (ordinary_owner + ';\n' if ordinary else '')
            + "SELECT set_config('held_fee_fixture.commission_case','" + mode + "',true);\n"
            + "SELECT set_config('held_fee_fixture.commission_rollups','" + ('2' if ordinary else '1') + "',true);\n"
            + scene + '\nROLLBACK;\n')
        label = 'commission-key-' + name + '-' + mode
        run(sql, label)
        return parsed(label, 'COMMISSION_BATCH_RESULT')

    def phase(name):
        expected_recognition = definition(recognition)
        observations[name] = {'busy': busy(name), 'free': free(name), 'ordinary': free(name, True)}
        for identity in (owner, single):
            if definition(identity) != original[identity]:
                raise AssertionError('Key qualification changed an ordinary owner: ' + identity)
        if definition(rollup) != actual_trigger:
            raise AssertionError('Commission trigger instrumentation escaped rollback')
        if definition(recognition) != expected_recognition:
            raise AssertionError('Recognition attempt instrumentation escaped rollback')

    phase('before')
    run(candidate, 'commission-key-install')
    after_recognition = definition(recognition)
    fallback_marker = '\n FOR source IN SELECT * FROM public.accounting_tournament_fee_sources'
    # The candidate's only intended delta is inside the strongly admitted
    # branch. Compare the full ordinary fallback and all following work.
    if fallback_marker not in original[recognition] or fallback_marker not in after_recognition:
        raise AssertionError('Ordinary commission fallback boundary changed')
    if original[recognition].split(fallback_marker, 1)[1] != after_recognition.split(fallback_marker, 1)[1]:
        raise AssertionError('Key admission modified ordinary recognition or downstream work')
    phase('after')
    for kind in ('free', 'ordinary'):
        if observations['before'][kind]['economic'] != observations['after'][kind]['economic']:
            raise AssertionError('Commission key admission changed financial results: ' + kind)
    assertions = sum(len(re.findall(r'NOTICE:\s+PASS ', p.read_text()))
        for p in out.glob('commission-key-*.log'))
    if assertions != 29:
        raise AssertionError('Expected 29 commission key assertions, observed ' + str(assertions))
    evidence = {'status': 'passed', 'assertions': assertions, 'before_after': observations,
        'trigger_definition_md5': trigger_md5, 'trigger_source': upstream_path,
        'trigger_source_pr': 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5676',
        'old_trigger_install_refused_atomically': True, 'ordinary_fallback_unchanged': True,
        'limitations': 'Private PG17 two-session contention at the real contributor club key; '
            'the peer takes no financial actions. This reproduces the blocked half of the '
            'cash-key/owner-relation inversion, not a historical cash batch or a production '
            'deadlock. All financial scenes roll back. Elapsed times are observational.'}
    (out / 'commission-key-admission-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    return evidence
