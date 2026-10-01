"""Qualify historical fee admission at the real per-player VIP carry lock.

The maintained private PG17 owner scene supplies every financial component.
One peer owns a carry row; it never writes money. All owner calls, missing-row
fixtures and instrumentation roll back. Synthetic existing carry rows remain
in this private fixture so subsequent owner qualification has valid admission.
"""
import json
import re
import select
import subprocess


def qualify(root, fix, out, cmd, run, schema):
    binding = json.loads((fix / 'source-binding.json').read_text())
    candidate = (root / binding['vip_carry_admission_migration']).read_text()
    recognition = 'public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'
    award = 'public.fn_award_vip_credit(uuid,numeric,text,uuid,text)'
    rollup = 'public.trg_agent_commission_rollup_insert()'
    owner = 'public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)'
    single = 'public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb)'
    base = cmd[:cmd.index('-c')]
    call = ("public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),"
        "jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)))")

    def definition(identity):
        return subprocess.check_output(cmd + ['-At', '-c',
            "SELECT pg_get_functiondef('" + identity + "'::regprocedure)"], text=True).rstrip() + '\n'

    original = {identity: definition(identity) for identity in (recognition, award, rollup, owner, single)}
    run("""BEGIN;
SELECT held_fee_fixture.assert(inet_server_addr() IS NULL AND current_database()='postgres'
 AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999
 AND md5(pg_get_functiondef('public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure))='48005212e5690fe916f57c3a4da9bf57'
 AND md5(pg_get_functiondef('public.fn_award_vip_credit(uuid,numeric,text,uuid,text)'::regprocedure))='29b7217ecae30238871d3a6e676e1bf6',
 'VIP carry fixture uses private PG17 and the exact installed recognition and credit writer');
INSERT INTO public.vip_points_carry(user_id,carry)
 SELECT DISTINCT user_id,0 FROM held_fee_fixture.contributors ON CONFLICT(user_id) DO NOTHING;
SELECT held_fee_fixture.assert((SELECT count(*)=24 FROM public.vip_points_carry c
 WHERE EXISTS(SELECT 1 FROM held_fee_fixture.contributors f WHERE f.user_id=c.user_id)),
 'VIP carry fixture supplies existing rows for all24 original contributors');
COMMIT;
""", 'vip-carry-seed')

    def instrument(body, sequence):
        changed, count = re.subn(r'\nBEGIN\n',
            "\nBEGIN\n PERFORM nextval('held_fee_fixture." + sequence + "');\n", body, count=1)
        if count != 1:
            raise AssertionError('VIP carry instrumentation boundary changed')
        return changed

    def parsed(label, marker):
        matches = re.findall(r'NOTICE:\s+' + marker + r' (\{[^\n]*\})',
            (out / (label + '.log')).read_text())
        if len(matches) != 1:
            raise AssertionError('Expected one native VIP carry result: ' + label)
        return json.loads(matches[0])

    def end_actor(actor):
        if actor.poll() is None:
            try:
                return actor.communicate('ROLLBACK;\n', timeout=5)
            except subprocess.TimeoutExpired:
                actor.kill()
                actor.communicate()
                raise AssertionError('Private VIP carry peer failed to release')
        return actor.communicate(timeout=5)

    def carry_actor():
        actor = subprocess.Popen(base + ['-At', '-v', 'VERBOSITY=verbose'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # Choose the final user: the candidate must release earlier acquired
        # carry locks too, not only fail before acquiring its first row.
        actor.stdin.write("BEGIN;SET statement_timeout='5s';SET lock_timeout='0';"
            "DO $$ BEGIN PERFORM 1 FROM public.vip_points_carry WHERE user_id="
            "(SELECT max(user_id::text)::uuid FROM held_fee_fixture.contributors)"
            " FOR NO KEY UPDATE;END $$;SELECT 'CARRY_READY';\n")
        actor.stdin.flush()
        if (not select.select([actor.stdout], [], [], 7)[0]
                or actor.stdout.readline().strip() != 'CARRY_READY'):
            end_actor(actor)
            raise AssertionError('Private peer did not acquire the final contributor carry row')
        return actor

    def refusal(name, missing=False):
        actor = None if missing else carry_actor()
        try:
            expected = ("code='57014' AND position('fn_award_vip_credit' IN context)>0 "
                "AND position('vip_points_carry' IN context)>0" if name == 'before' else
                "code='55000' AND message='held_fee_vip_carry_" +
                ('admission_incomplete' if missing else 'busy') + "' "
                "AND position('fn_recognize_accounting_tournament_fees' IN context)>0")
            sql = ("BEGIN;SET LOCAL statement_timeout='2s';SET LOCAL lock_timeout='0';"
                "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';\n"
                "CREATE SEQUENCE held_fee_fixture.vip_carry_attempts;\n"
                + instrument(definition(recognition), 'vip_carry_attempts') + ';\n'
                + ("DELETE FROM public.vip_points_carry WHERE user_id="
                    "(SELECT max(user_id::text)::uuid FROM held_fee_fixture.contributors);\n" if missing else '')
                + """
DO $refusal$
DECLARE state jsonb;code text;message text;context text;started timestamptz;elapsed_ms numeric;attempts bigint;
BEGIN
 state:=held_fee_fixture.snapshot();started:=clock_timestamp();
 BEGIN
  PERFORM """ + call + ";\n" + """
 EXCEPTION WHEN query_canceled OR OTHERS THEN
  code:=SQLSTATE;message:=SQLERRM;GET STACKED DIAGNOSTICS context=PG_EXCEPTION_CONTEXT;
 END;
 elapsed_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO attempts FROM held_fee_fixture.vip_carry_attempts;
 PERFORM held_fee_fixture.assert(""" + expected + ", 'VIP carry " + name + (' missing' if missing else ' busy')
                + " refuses through the full owner at the expected boundary');\n" + """
 PERFORM held_fee_fixture.assert(state=held_fee_fixture.snapshot(),
  'VIP carry refusal leaves every original financial row unchanged');
 PERFORM held_fee_fixture.assert(attempts=1,
  'VIP carry refusal escapes the payer without retrying recognition');
 RAISE NOTICE 'VIP_CARRY_REFUSAL %',jsonb_build_object('sqlstate',code,'message',message,
  'owner_elapsed_ms',elapsed_ms,'recognition_attempts',attempts,'financial_snapshot_unchanged',true,'context',context);
END $refusal$;
ROLLBACK;
""")
            label = 'vip-carry-' + name + ('-missing' if missing else '-busy')
            run(sql, label)
            result = parsed(label, 'VIP_CARRY_REFUSAL')
            if actor is not None:
                if actor.poll() is not None:
                    raise AssertionError('VIP carry peer exited before the owner refusal')
                # The peer retains its carry lock until after these admissions.
                # No waiting/balance mutation can hide a retained owner lock.
                output, error = actor.communicate("DO $$ BEGIN "
                    "PERFORM 1 FROM public.club_wallets WHERE club_id="
                    "(SELECT club_id FROM public.tournaments WHERE id=held_fee_fixture.event())"
                    " FOR NO KEY UPDATE NOWAIT;"
                    "PERFORM 1 FROM public.union_wallets WHERE union_id=held_fee_fixture.union_id()"
                    " FOR NO KEY UPDATE NOWAIT;"
                    "PERFORM 1 FROM public.vip_points_carry WHERE user_id IN"
                    "(SELECT user_id FROM held_fee_fixture.contributors) ORDER BY user_id"
                    " FOR NO KEY UPDATE NOWAIT;END $$;"
                    "LOCK TABLE public.agent_commissions,public.player_stats IN ROW EXCLUSIVE MODE NOWAIT;"
                    "SELECT 'BANK_CARRY_RELATIONS_RELEASED';ROLLBACK;\n", timeout=7)
                (out / (label + '-peer.log')).write_text(output + error)
                if actor.returncode or 'BANK_CARRY_RELATIONS_RELEASED' not in output:
                    raise AssertionError('VIP refusal retained bank/carry/projection locks: ' + error)
                result['peer_bank_carry_relations_admitted_after_rollback'] = True
            return result
        finally:
            if actor is not None:
                end_actor(actor)

    scene = (fix / 'commission-batch-scene.sql').read_text()
    ordinary_owner, count = re.subn(
        r'(?m)^ LOCK TABLE public\.agent_commissions, public\.player_stats\n'
        r'  IN SHARE ROW EXCLUSIVE MODE NOWAIT;$',
        ' LOCK TABLE public.player_stats\n  IN SHARE ROW EXCLUSIVE MODE NOWAIT;', original[owner])
    if count != 1:
        raise AssertionError('Ordinary owner admission boundary changed')

    vip_seed = """
SET LOCAL session_replication_role=replica;
UPDATE public.vip_points_carry SET carry=0.95 WHERE user_id IN(SELECT user_id FROM held_fee_fixture.contributors);
INSERT INTO public.vip_points(user_id,current_points,lifetime_points)
 SELECT DISTINCT user_id,7,19 FROM held_fee_fixture.contributors
 ON CONFLICT(user_id) DO UPDATE SET current_points=7,lifetime_points=19;
SET LOCAL session_replication_role=origin;
"""
    vip_expected = """
CREATE TEMP TABLE vip_carry_expected ON COMMIT DROP AS
 SELECT f.user_id,sum(f.rake_amount) credit,COALESCE(c.carry,0) opening_carry,
  floor(COALESCE(c.carry,0)+round(sum(f.rake_amount),4))::bigint earned_points
 FROM held_fee_fixture.contributors f LEFT JOIN public.vip_points_carry c ON c.user_id=f.user_id
 GROUP BY f.user_id,c.carry;
"""
    vip_oracle = """
DO $vip_oracle$
DECLARE state jsonb;vip_state jsonb;r jsonb;
BEGIN
 PERFORM held_fee_fixture.assert((SELECT count(*)=24 AND sum(l.credit)=2.70
  AND bool_and(l.credit=e.credit AND l.points=e.earned_points
   AND l.reason='Tournament rake generated' AND l.created_at=transaction_timestamp())
  FROM public.vip_points_ledger l JOIN vip_carry_expected e ON e.user_id=l.user_id
  WHERE l.source_type='tournament_rake' AND l.source_id=held_fee_fixture.event()),
  'VIP ledger awards all24 contributors exact original fee cents and independently computed points');
 PERFORM held_fee_fixture.assert((SELECT count(*)=24 AND bool_and(c.carry=e.opening_carry+e.credit-e.earned_points)
  FROM vip_carry_expected e JOIN public.vip_points_carry c ON c.user_id=e.user_id),
  'VIP carry retains each exact fractional remainder');
 PERFORM held_fee_fixture.assert((SELECT count(*)=24 AND bool_and(p.current_points=7+e.earned_points
  AND p.lifetime_points=19+e.earned_points) FROM vip_carry_expected e JOIN public.vip_points p ON p.user_id=e.user_id),
  'VIP current and lifetime balances increase by each exact earned point count');
 SELECT jsonb_build_object(
  'carry',(SELECT jsonb_agg(to_jsonb(c)-'updated_at' ORDER BY c.user_id)
   FROM public.vip_points_carry c WHERE c.user_id IN(SELECT user_id FROM vip_carry_expected)),
  'points',(SELECT jsonb_agg(to_jsonb(p)-'updated_at' ORDER BY p.user_id)
   FROM public.vip_points p WHERE p.user_id IN(SELECT user_id FROM vip_carry_expected)),
  'ledger',(SELECT jsonb_agg((to_jsonb(l)-'id'-'created_at')||jsonb_build_object('created_in_transaction',l.created_at=transaction_timestamp()) ORDER BY l.user_id)
   FROM public.vip_points_ledger l WHERE l.source_type='tournament_rake' AND l.source_id=held_fee_fixture.event())) INTO vip_state;
 state:=held_fee_fixture.snapshot();
 r:=""" + call + ";\n" + """
 PERFORM held_fee_fixture.assert(r->>'replayed'='true' AND state=held_fee_fixture.snapshot(),
  'VIP owner replay leaves every financial row and credit unchanged');
 RAISE NOTICE 'VIP_CARRY_RESULT %',jsonb_build_object('economic',vip_state,'owner_replay_unchanged',true);
END $vip_oracle$;
"""

    def free(name, ordinary=False):
        mode = 'ordinary_fallback' if ordinary else 'profile'
        sql = ("BEGIN;SET LOCAL statement_timeout='5s';"
            "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';\n"
            "CREATE SEQUENCE held_fee_fixture.commission_rollup_calls;\n"
            + instrument(original[rollup], 'commission_rollup_calls') + ';\n'
            + (ordinary_owner + ';\n' if ordinary else '') + vip_seed
            + ("DELETE FROM public.vip_points_carry WHERE user_id="
                "(SELECT max(user_id::text)::uuid FROM held_fee_fixture.contributors);\n" if ordinary else '')
            + vip_expected
            + "SELECT set_config('held_fee_fixture.commission_case','" + mode + "',true);\n"
            + "SELECT set_config('held_fee_fixture.commission_rollups','" + ('2' if ordinary else '1') + "',true);\n"
            + scene + vip_oracle + '\nROLLBACK;\n')
        label = 'vip-carry-' + name + '-' + mode
        run(sql, label)
        result = parsed(label, 'COMMISSION_BATCH_RESULT')
        result['vip'] = parsed(label, 'VIP_CARRY_RESULT')
        result['ordinary_missing_carry_created_by_canonical_award'] = ordinary
        return result

    observations = {}

    def phase(name):
        expected_recognition = definition(recognition)
        observations[name] = {'busy': refusal(name), 'free': free(name), 'ordinary': free(name, True)}
        if name == 'after':
            observations[name]['missing'] = refusal(name, True)
        for identity in (owner, single, award, rollup):
            if definition(identity) != original[identity]:
                raise AssertionError('VIP qualification changed retained production function: ' + identity)
        if definition(recognition) != expected_recognition:
            raise AssertionError('VIP recognition instrumentation escaped rollback')

    phase('before')
    # Drift refusal is atomic, including function configuration and grants.
    run('ALTER FUNCTION ' + recognition + " SET statement_timeout='31s';", 'vip-carry-predecessor-drift')
    before_schema = schema()
    path = out / 'vip-carry-install-refused.sql'
    path.write_text(candidate)
    refused = subprocess.run(cmd + ['-f', str(path)], capture_output=True, text=True, timeout=12)
    (out / 'vip-carry-install-refused.log').write_text(refused.stdout + refused.stderr)
    if (refused.returncode == 0 or 'held_fee_vip_admission_predecessor_changed' not in refused.stderr
            or schema() != before_schema):
        raise AssertionError('VIP predecessor drift must refuse without schema/ACL changes')
    run(original[recognition] + ';', 'vip-carry-predecessor-restored')
    run(candidate, 'vip-carry-install')
    after_recognition = definition(recognition)
    marker = '\n FOR source IN SELECT * FROM public.accounting_tournament_fee_sources'
    if (marker not in original[recognition] or marker not in after_recognition
            or original[recognition].split(marker, 1)[1] != after_recognition.split(marker, 1)[1]):
        raise AssertionError('VIP admission changed ordinary fallback or canonical VIP/receipt work')
    phase('after')
    for kind in ('free', 'ordinary'):
        old, new = observations['before'][kind], observations['after'][kind]
        if old['economic'] != new['economic'] or old['vip'] != new['vip']:
            raise AssertionError('VIP admission changed native financial results: ' + kind)
    assertions = sum(len(re.findall(r'NOTICE:\s+PASS ', p.read_text()))
        for p in out.glob('vip-carry-*.log'))
    if assertions != 49:
        raise AssertionError('Expected49 VIP carry assertions, observed ' + str(assertions))
    evidence = {'status': 'passed', 'assertions': assertions, 'before_after': observations,
        'canonical_award_definition_md5': '29b7217ecae30238871d3a6e676e1bf6',
        'predecessor_drift_refusal': True, 'ordinary_fallback_unchanged': True,
        'limitations': 'Private PG17 two-session row contention through the actual full owner. '
            'The peer owns one carry row and makes no financial write; this reproduces the '
            'blocked VIP half of the bank/carry inversion, not a complete historical cash hand. '
            'Synthetic preexisting carry and opening points exercise fractional accrual. '
            'All financial scenes roll back. Timings are observations, not a throughput claim.'}
    (out / 'vip-carry-admission-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    return evidence
