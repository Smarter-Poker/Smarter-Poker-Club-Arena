#!/usr/bin/env python3
"""Actions-only retention against exact captured owners in isolated PG17.

No production connection. Reuses the existing native disposal world; omitted
business triggers are outside this actions-only transition and no money moves.
The exact resume, direct replay door, assertion and signed-economic reader run.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import threading
import time
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, lit, sha

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = next((ROOT / 'supabase/migrations').glob('20261028152912_*.sql'))
PREIMAGE = ROOT / 'scripts/ci/fixtures/superseded-action-preimages.json'
TABLE = '9d700000-0000-4000-8000-000000000001'
HAND = '9d700000-0000-4000-8000-000000000002'
GEN = '9d700000-0000-4000-8000-000000000003'
RECEIPT = '9d700000-0000-4000-8000-000000000004'
WITNESS = '9d700000-0000-4000-8000-000000000005'
HUMAN = '9d700000-0000-4000-8000-000000000006'
AUTH = "SET request.jwt.claim.role='service_role'; SET app.smarter_data_actor='service';"
CALL = f"SELECT smarter_private.compact_superseded_horse_actions(ARRAY[{lit(HAND)}::uuid]);"
SEED = f"""
INSERT INTO public.profiles(id,is_horse) VALUES({lit(HUMAN)},true);
INSERT INTO public.tables(id,name,game_type) VALUES({lit(TABLE)},'Native Actions Retention','cash');
INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash,retained_at)
SELECT {lit(HAND)},{lit(TABLE)},1000001,'retired-dealer',{lit(GEN)},r,
 encode(extensions.digest(convert_to(r::text,'UTF8'),'sha256'),'hex'),now()-interval '10 days'
FROM (SELECT jsonb_build_object('p_table_id',{lit(TABLE)},'p_hand_number',1000001,
 'p_instance_id','retired-dealer','p_lease_generation',{lit(GEN)},
 'p_stacks',jsonb_build_array(jsonb_build_object('user_id',{lit(HUMAN)},'stack_before',100,'stack_after',120)),
 'p_units','[{{"amount":20}}]'::jsonb,'p_rake',1,'p_bbj',0,'p_inflow',0,'p_ref','original-ref',
 'p_post_commit_obligations','{{"stats":{{"vpip":true}}}}'::jsonb,
 'p_hand_row',jsonb_build_object('id',{lit(HAND)},'table_id',{lit(TABLE)},'hand_number',1000001,
 'tournament_id',NULL,'has_human',false,'reported',false,'started_at',(now()-interval '10 days')::text,
 'players',jsonb_build_array(jsonb_build_object('userId',{lit(HUMAN)})),
 'actions',(SELECT jsonb_agg(jsonb_build_object('seq',n,'action','call','amount',n,'event_digest',md5(n::text)||md5((n*37)::text)||md5((n*47)::text))) FROM generate_series(1,1500)n),
 'hole_cards','["As","Kh"]'::jsonb,'daily_mission_events','[{{"kept":true}}]'::jsonb))r) q;
INSERT INTO smarter_private.hand_submission_disposals(table_id,hand_number,submission_id,receipt_id,witness_hand_number,reason,expected)
SELECT table_id,hand_number,submission_id,{lit(RECEIPT)},1000002,
 'Native original superseded receipt: later committed hand consumed every original stack; no credit.',
 jsonb_build_object('kind','superseded_retained_submission','table_id',table_id,'tournament_id',NULL,
 'hand_number',hand_number,'submission_id',submission_id,'retained_at',retained_at,
 'dealer_generation',lease_generation,'request_hash',request_hash,'witness_hand_number',1000002,
 'witness_committed_at',now()-interval '9 days','disposed_at',now()-interval '9 days')
FROM smarter_private.hand_submissions;
"""

SUPPLEMENT = """
CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,is_horse boolean);
CREATE TABLE public.hand_history_retention_policy(horse_retention_days integer);
INSERT INTO public.hand_history_retention_policy VALUES(8);
CREATE TABLE public.hand_projection_outbox(hand_id uuid);
CREATE TABLE public.bbj_payouts(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.hand_submission_source_corrections(submission_id uuid);
CREATE TABLE smarter_private.hand_submission_correction_claims(submission_id uuid);
CREATE TABLE smarter_private.retired_cash_hand_qualification(submission_id uuid);
CREATE TABLE smarter_private.retired_cash_hand_custody(submission_id uuid);
CREATE TABLE smarter_private.retirement_original_hand_qualification(submission_id uuid);
CREATE TABLE smarter_private.hand_submission_resume_marks(table_id uuid primary key,settled_through bigint,marked_at timestamptz);
CREATE TABLE smarter_private.horse_retained_stats_basis(hand_id uuid,request_hash text);
-- Denying stand-ins only for the unchanged settled-history retention branch.
-- This fixture qualifies superseded requests, never accepted-history erasure.
CREATE FUNCTION smarter_private.horse_request_payload_disposable(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION smarter_private.horse_cash_retention_accounting_ready(uuid,bigint) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION smarter_private.horse_adaptive_disposal_certificate_matches(uuid,uuid,bigint,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
"""

def run_retention_progress(pg_bin, out):
    # Existing required owner qualifies both transitions; a failed child must
    # prevent the parent passed verdict. Its evidence stays in the same artifact.
    subprocess.run([sys.executable, str(ROOT / 'scripts/ci/test-superseded-retention-progress.py'),
                    '--pg-bin', str(pg_bin), '--evidence', str(out / 'retention-progress')],
                   check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pg-bin', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    out = args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=False)
    socket_parent = Path(os.environ.get('TMPDIR', '/tmp'))
    native = module(ROOT / 'scripts/ci/test-mtt-unlimited.py', 'superseded_native')
    doors = module(ROOT / 'scripts/ci/test-hand-submission-disposal.py', 'superseded_doors')
    if sys.platform == 'darwin' and not str(socket_parent.resolve()).startswith('/Volumes/SmarterWork/agent-work/'):
        raise SystemExit('Native scratch and sockets must use the task-owned external SSD TMPDIR')
    e = native.Execution(ROOT, out, args.pg_bin.resolve(), socket_parent, 180, socket_parent=str(socket_parent))
    checks = []
    threads = []
    def sql(db, query, label, check=True):
        return e.sql(db, query, label=label, check=check)
    def expect(name, condition):
        checks.append({'name': name, 'passed': bool(condition)})
        if not condition:
            raise AssertionError(name)
    def scalar(db, query, label):
        return sql(db, query, label)[1].strip()
    def refused(db, query, label, message):
        code, _, err = sql(db, query, label, False)
        expect(label, code != 0 and message in err)
    try:
        e.start()
        base = e.database()
        e.sql(base, file=ROOT / doors.WORLD, label='actual-disposal-world')
        sql(base, SUPPLEMENT, 'current-read-only-dependency-shapes')
        sql(base, doors.resume_base(ROOT), 'historical-resume-preimage')
        sql(base, doors.snapshot_guard_base(ROOT), 'historical-snapshot-preimage')
        e.sql(base, file=ROOT / doors.MIGRATION, label='recorded-original-disposal')
        capture = json.loads(PREIMAGE.read_text())
        for row in capture['rows']:
            expect('captured digest ' + row['signature'], hashlib.md5(row['definition'].encode()).hexdigest() == row['md5'])
            sql(base, row['definition'] + ';', 'actual-preimage-' + row['signature'].split('(')[0].replace('.', '-'))
            sql(base, 'REVOKE ALL ON FUNCTION ' + row['signature'] + ' FROM PUBLIC,anon,authenticated,service_role;' + ('' if row['signature'].startswith('smarter_private.') else 'GRANT EXECUTE ON FUNCTION ' + row['signature'] + ' TO service_role;'), 'actual-preimage-ACL-' + row['signature'].split('(')[0].replace('.', '-'))
        sql(base, "CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable(); CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();", 'actual-original-submission-trigger-bindings')
        before = e.database(base)
        sql(before, SEED, 'before-original')
        expect('BEFORE disposed old request retains action copy', scalar(before, "SELECT jsonb_array_length(request#>'{p_hand_row,actions}') FROM smarter_private.hand_submissions;", 'before-actions') == '1500')
        refused(before, "UPDATE smarter_private.hand_submissions SET request=request#-'{p_hand_row,actions}';", 'before-immutable-refusal', 'HAND_SUBMISSION_IMMUTABLE')
        e.discard(before)
        for sig in ['smarter_private.assert_retained_hand_submission(jsonb)', 'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)']:
            sql(base, 'REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;', 'exact-source-pin-ACL-' + sig.split('(')[0])
        def pins(db, label):
            return json.loads(scalar(db, "SELECT split_part(pg_get_functiondef('smarter_private.original_hand_correction_sources_match()'::regprocedure),'$sourcepins$',2)::jsonb;", label))
        original_pins = pins(base, 'original26pins')
        def scoped_matcher(db, label):
            # Run the exact installed matcher's comparison over its two changed
            # pins only. The other24 sources are deliberately not invented in
            # this focused native world; their exact pins are compared below.
            body = scalar(db, "SELECT prosrc FROM pg_proc WHERE oid='smarter_private.original_hand_correction_sources_match()'::regprocedure;", label + '-body')
            selected = [x for x in pins(db, label + '-pins') if x['signature'] in ['smarter_private.assert_retained_hand_submission(jsonb)', 'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)']]
            old = body.split('$sourcepins$')[1]
            body = body.replace('count(*)=26', 'count(*)=2').replace('$sourcepins$'+old+'$sourcepins$', '$sourcepins$'+json.dumps(selected)+'$sourcepins$')
            sql(db, "CREATE OR REPLACE FUNCTION smarter_private.test_two_source_pins() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,smarter_private AS $scoped$"+body+"$scoped$;", label + '-actual-comparison')
            return scalar(db, 'SELECT smarter_private.test_two_source_pins();', label + '-answer')
        expect('actual matcher changed2 pins true before', scoped_matcher(base, 'before-scoped-matcher') == 't')
        e.sql(base, file=MIGRATION, label='exact-candidate-migration')
        final_pins = pins(base, 'final26pins')
        unchanged = lambda rows: [x for x in rows if x['signature'] not in ['smarter_private.assert_retained_hand_submission(jsonb)', 'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)']]
        expect('other24 source pins unchanged', unchanged(original_pins) == unchanged(final_pins))
        expect('actual matcher changed2 pins true after', scoped_matcher(base, 'after-scoped-matcher') == 't')
        drift = e.database(base)
        sql(drift, "CREATE OR REPLACE FUNCTION smarter_private.assert_retained_hand_submission(p_request jsonb) RETURNS void LANGUAGE plpgsql AS $$BEGIN RETURN; END$$;", 'actual-source-drift')
        expect('actual matcher source drift refuses', scoped_matcher(drift, 'drift-scoped-matcher') == 'f')
        e.discard(drift)
        code, _, err = e.sql(base, file=MIGRATION, label='migration-replay-refused', check=False)
        expect('migration replay refuses', code != 0 and 'SUPERSEDED_ACTION_RETENTION_ALREADY_INSTALLED' in err)
        after = e.database(base)
        sql(after, SEED, 'after-original')
        def state(db, label):
            return json.loads(scalar(db, f"SELECT jsonb_build_object('identity',to_jsonb(s)-'request','request',s.request,'disposal',(SELECT to_jsonb(d) FROM smarter_private.hand_submission_disposals d WHERE d.submission_id=s.submission_id),'signed_economics',smarter_private.original_inventory_source_ref_md5(jsonb_build_object('kind','signed_economics','id',s.submission_id)),'seats',(SELECT jsonb_agg(to_jsonb(t)) FROM public.table_seats t)) FROM smarter_private.hand_submissions s WHERE submission_id={lit(HAND)};", label))
        initial = state(after, 'original-complete-state')
        stored_before = int(scalar(after, 'SELECT pg_column_size(request) FROM smarter_private.hand_submissions;', 'stored-original-bytes'))
        expect('bounded native compaction changes one', scalar(after, CALL, 'compact-one') == '1')
        final = state(after, 'compacted-complete-state')
        stored_after = json.loads(scalar(after, "SELECT jsonb_build_object('request',pg_column_size(request),'certificates',pg_total_relation_size('smarter_private.superseded_horse_action_certificates')) FROM smarter_private.hand_submissions;", 'stored-compacted-and-certificate-bytes'))
        expect('actual stored request plus entire certificate relation is smaller', stored_after['request'] + stored_after['certificates'] < stored_before)
        e.report['physical_bytes'] = {'original_request':stored_before, 'after':stored_after}
        expected = json.loads(json.dumps(initial))
        del expected['request']['p_hand_row']['actions']
        expect('only actions change; identity, receipt, financial DTO and seats identical', final == expected)
        expect('actions bytes actually removed', len(json.dumps(final['request'])) < len(json.dumps(initial['request'])) / 2)
        expect('one permanent certificate', scalar(after, 'SELECT count(*) FROM smarter_private.superseded_horse_action_certificates;', 'certificate-count') == '1')
        expect('idempotent compaction', scalar(after, CALL, 'repeat-compaction') == '0')
        expect('actual current resume remains closed', json.loads(scalar(after, AUTH + f"SELECT public.fn_ca_resume_hand_submission({lit(TABLE)},'unused','{GEN}');", 'actual-resume')) == {'found': False})
        for name, payload in [('original', initial['request']), ('compacted', final['request'])]:
            refused(after, 'SELECT smarter_private.assert_retained_hand_submission(' + lit(json.dumps(payload)) + '::jsonb);', 'actual-assert-refuses-' + name, 'HAND_SUBMISSION_ACTIONS_RETIRED')
        refused(after, f"SELECT public.fn_ca_commit_hand_submission({lit(HAND)},'retired-dealer',{lit(GEN)});", 'actual-direct-commit-refused-before-monetary-core', 'HAND_SUBMISSION_ACTIONS_RETIRED')
        for name, query in [
            ('restore-actions', 'UPDATE smarter_private.hand_submissions SET request=' + lit(json.dumps(initial['request'])) + '::jsonb;'),
            ('delete', 'DELETE FROM smarter_private.hand_submissions;'),
            ('identity', "UPDATE smarter_private.hand_submissions SET instance_id='changed';"),
            ('truncate', 'TRUNCATE smarter_private.hand_submissions;'),
            ('certificate-update', 'UPDATE smarter_private.superseded_horse_action_certificates SET hand_number=hand_number;'),
            ('certificate-delete', 'DELETE FROM smarter_private.superseded_horse_action_certificates;'),
            ('certificate-truncate', 'TRUNCATE smarter_private.superseded_horse_action_certificates;'),
        ]:
            refused(after, query, name, 'IMMUTABLE')
        for role in ['anon', 'authenticated', 'service_role']:
            refused(after, f'SET ROLE {role};' + CALL, role + '-cannot-call', 'permission denied')
        refused(after, 'SELECT smarter_private.compact_superseded_horse_actions(ARRAY(SELECT gen_random_uuid() FROM generate_series(1,101)));', 'batch-over100', 'SUPERSEDED_ACTION_BATCH_INVALID')
        refused(after, 'SELECT smarter_private.compact_superseded_horse_actions(ARRAY[NULL::uuid]);', 'batch-null-id', 'SUPERSEDED_ACTION_BATCH_INVALID')
        e.discard(after)
        # Seed each refusal before attaching immutable original guards, using a
        # cloned native world only. No test changes authoritative live data.
        for name, mutation in [
            ('current-human', 'UPDATE public.profiles SET is_horse=false;'),
            ('unknown-player', 'DELETE FROM public.profiles;'),
            ('malformed-player', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,players}','[{\"userId\":\"bad\"}]');"),
            ('compressible-nonbeneficial', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,actions}',(SELECT jsonb_agg(jsonb_build_object('action','call','amount',10)) FROM generate_series(1,1500))); UPDATE smarter_private.hand_submissions SET request_hash=encode(extensions.digest(convert_to(request::text,'UTF8'),'sha256'),'hex'); UPDATE smarter_private.hand_submission_disposals SET expected=jsonb_set(expected,'{request_hash}',to_jsonb((SELECT request_hash FROM smarter_private.hand_submissions)));"),
            ('small-nonbeneficial', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,actions}','[{\"action\":\"call\"}]'); UPDATE smarter_private.hand_submissions SET request_hash=encode(extensions.digest(convert_to(request::text,'UTF8'),'sha256'),'hex'); UPDATE smarter_private.hand_submission_disposals SET expected=jsonb_set(expected,'{request_hash}',to_jsonb((SELECT request_hash FROM smarter_private.hand_submissions)));"),
            ('malformed-array', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,players}','{}');"),
            ('human', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,has_human}','true');"),
            ('unknown-human', "UPDATE smarter_private.hand_submissions SET request=request#-'{p_hand_row,has_human}';"),
            ('empty-players', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,players}','[]');"),
            ('null-retained-at', 'ALTER TABLE smarter_private.hand_submissions ALTER COLUMN retained_at DROP NOT NULL; UPDATE smarter_private.hand_submissions SET retained_at=NULL;'),
            ('missing-disposed-at', "UPDATE smarter_private.hand_submission_disposals SET expected=expected-'disposed_at';"),
            ('missing-retained-at', "UPDATE smarter_private.hand_submission_disposals SET expected=expected-'retained_at';"),
            ('missing-witness', "ALTER TABLE smarter_private.hand_submission_disposals ALTER COLUMN witness_hand_number DROP NOT NULL; UPDATE smarter_private.hand_submission_disposals SET witness_hand_number=NULL,expected=expected-'witness_hand_number';"),
            ('unknown-policy', 'UPDATE public.hand_history_retention_policy SET horse_retention_days=NULL;'),
            ('young', 'UPDATE smarter_private.hand_submissions SET retained_at=now();'),
            ('hash-conflict', "UPDATE smarter_private.hand_submissions SET request_hash=repeat('0',64);"),
            ('reported', "UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,reported}','true');"),
            ('no-receipt', 'DELETE FROM smarter_private.hand_submission_disposals;'),
            ('different-disposal', "UPDATE smarter_private.hand_submission_disposals SET expected=jsonb_set(expected,'{kind}','\"request_can_never_apply\"');"),
            ('malformed-date', "UPDATE smarter_private.hand_submission_disposals SET expected=jsonb_set(expected,'{disposed_at}','\"bad\"');"),
            ('no-later-witness', 'UPDATE smarter_private.hand_submission_disposals SET witness_hand_number=hand_number+1,expected=jsonb_set(expected,\'{witness_hand_number}\',to_jsonb(hand_number));'),
            ('history', f'INSERT INTO public.hand_history(table_id,hand_number) VALUES({lit(TABLE)},1000001);'),
            ('accepted-commit', f"INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)VALUES({lit(TABLE)},1000001,{lit(HAND)},repeat('0',64),'{{}}');"),
            ('handoff', f"INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id) VALUES({lit(HAND)},{lit(GEN)},'owner',gen_random_uuid(),repeat('0',64),1);"),
            ('dispatch', f"INSERT INTO smarter_private.hand_submission_dispatch(transaction_id,submission_id,request_hash,instance_id,lease_generation)VALUES(1,{lit(HAND)},repeat('0',64),'owner',{lit(GEN)});"),
            ('active-original-lease', f"INSERT INTO public.engine_table_leases(table_id,instance_id,lease_generation,protocol_version)VALUES({lit(TABLE)},'retired-dealer',{lit(GEN)},2);"),
            ('correction', f'INSERT INTO smarter_private.hand_submission_source_corrections VALUES({lit(HAND)});'),
            ('custody', f'INSERT INTO smarter_private.retired_cash_hand_custody VALUES({lit(HAND)});'),
            ('policy', 'UPDATE public.hand_history_retention_policy SET horse_retention_days=7;'),
            ('frozen', "SET app.test_platform_frozen='true';"),
        ]:
            case = e.database(base)
            # Suppress only cloned fixture immutability while constructing bad
            # preimages; restore it before executing the real candidate.
            normalize = "UPDATE smarter_private.hand_submissions SET request_hash=encode(extensions.digest(convert_to(request::text,'UTF8'),'sha256'),'hex'); UPDATE smarter_private.hand_submission_disposals SET expected=jsonb_set(expected,'{request_hash}',to_jsonb((SELECT request_hash FROM smarter_private.hand_submissions)));" if name != 'hash-conflict' else ''
            sql(case, 'ALTER TABLE smarter_private.hand_submissions DISABLE TRIGGER hand_submission_immutable; ALTER TABLE smarter_private.hand_submission_disposals DISABLE TRIGGER hand_submission_disposal_immutable;' + SEED + mutation + normalize + 'ALTER TABLE smarter_private.hand_submissions ENABLE TRIGGER hand_submission_immutable; ALTER TABLE smarter_private.hand_submission_disposals ENABLE TRIGGER hand_submission_disposal_immutable;', name + '-seed')
            if name == 'compressible-nonbeneficial':
                expect('compressible original passes semantic qualifier before measured-cost rejection', scalar(case, f'SELECT smarter_private.superseded_horse_actions_eligible({lit(HAND)});', 'nonbeneficial-semantically-eligible') == 't')
                cost_before = state(case, 'nonbeneficial-exact-original')
            expect(name + ' preserved', scalar(case, ("SET app.test_platform_frozen='true';" if name=='frozen' else '') + CALL, name + '-call') == '0')
            if name == 'compressible-nonbeneficial':
                expect('cost rejection rolls back every source byte and receipt', state(case, 'nonbeneficial-exact-after') == cost_before)
            expect(name + ' no certificate', scalar(case, 'SELECT count(*) FROM smarter_private.superseded_horse_action_certificates;', name + '-certificate') == '0')
            expect(name + ' action copy retained', scalar(case, "SELECT request#>'{p_hand_row,actions}' IS NOT NULL FROM smarter_private.hand_submissions;", name + '-actions') == 't')
            e.discard(case)
        for owner in ['private', 'public']:
            future = e.database(base)
            sql(future, 'ALTER TABLE smarter_private.hand_submission_disposals DISABLE TRIGGER hand_submission_disposal_immutable;' + SEED + 'DELETE FROM smarter_private.hand_submission_disposals;ALTER TABLE smarter_private.hand_submission_disposals ENABLE TRIGGER hand_submission_disposal_immutable;' + f"INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)VALUES({lit(TABLE)},1000002,{lit(WITNESS)},repeat('0',64),'{{}}',now()-interval '9 days');", owner + '-future-seed')
            initial_future = state(future, owner + '-future-before')
            if owner == 'private':
                answer = scalar(future, f"SELECT smarter_private.hand_submission_dispose_dealt_past({lit(TABLE)},1000001);", 'actual-private-disposal-hook')
                expect('private disposal still returns original receipt count', answer == '1')
            else:
                answer = json.loads(scalar(future, AUTH + f"SELECT public.fn_ca_dispose_superseded_hand_submissions({lit(TABLE)},{lit(RECEIPT)},'Native future disposal proves exact original hand consumed; no chips are credited.',100);", 'actual-public-disposal-hook'))
                expect('public disposal still reports original zero-credit result', answer['disposed'] == 1 and answer['credit'] == 0)
            expect(owner + ' disposal compacts its newly receipted old action copy', scalar(future, "SELECT NOT (request#>'{p_hand_row}') ? 'actions' AND EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates) FROM smarter_private.hand_submissions;", owner + '-future-compaction') == 't')
            final_future = state(future, owner + '-future-after')
            expect(owner + ' disposal preserves financial DTO and original identity', initial_future['identity'] == final_future['identity'] and initial_future['signed_economics'] == final_future['signed_economics'] and initial_future['seats'] == final_future['seats'])
            e.discard(future)
        returned = e.database(base)
        sql(returned, SEED, 'returning-compression-seed')
        sql(returned, 'CREATE TABLE native_request_copy AS SELECT request FROM smarter_private.hand_submissions;', 'returning-compression-copy')
        returning_bytes = int(scalar(returned, "UPDATE native_request_copy SET request=jsonb_set(request,'{p_hand_row,actions}',(SELECT jsonb_agg(jsonb_build_object('action','call','amount',10)) FROM generate_series(1,1500))) RETURNING pg_column_size(request);", 'returning-compression-value'))
        reread_bytes = int(scalar(returned, 'SELECT pg_column_size(request) FROM native_request_copy;', 'returning-compression-readback'))
        e.report['returning_size_comparison'] = {'returning':returning_bytes, 'fresh_stored_read':reread_bytes, 'decision':'production uses fresh stored read'}
        e.discard(returned)
        rolled = e.database(base)
        sql(rolled, SEED, 'rollback-seed')
        sql(rolled, 'BEGIN;' + CALL + 'ROLLBACK;', 'rollback-transition')
        expect('rollback retains actions and removes certificate', scalar(rolled, "SELECT EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE request#>'{p_hand_row,actions}' IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates);", 'rollback-readback') == 't')
        # Two actual PostgreSQL sessions: a held row is skipped, not queued.
        result = []
        def hold():
            result.append(sql(rolled, f'BEGIN;SELECT 1 FROM smarter_private.hand_submissions WHERE submission_id={lit(HAND)} FOR UPDATE;SELECT pg_sleep(1.5);COMMIT;', 'concurrent-row-holder'))
        t = threading.Thread(target=hold)
        threads.append(t)
        t.start()
        until = time.monotonic() + 3
        while scalar(rolled, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%concurrent%' OR wait_event='PgSleep');", 'holder-ready') != 't':
            if time.monotonic() > until:
                raise AssertionError('holder did not start')
            time.sleep(.02)
        expect('locked original skipped', scalar(rolled, CALL, 'concurrent-skiplocked') == '0')
        t.join()
        expect('unlocked original compacts', scalar(rolled, CALL, 'after-row-unlock') == '1')
        e.discard(rolled)
        e.report['candidate_postimages'] = json.loads(scalar(base, "SELECT jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.oid IN('smarter_private.hand_submission_immutable()'::regprocedure,'smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure,'public.fn_ca_commit_hand_submission(uuid,text,uuid)'::regprocedure,'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure,'public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure,'smarter_private.original_hand_correction_sources_match()'::regprocedure,'smarter_private.original_inventory_source_ref_md5(jsonb)'::regprocedure);", 'exact-candidate-postimages'))
        e.discard(base)
        run_retention_progress(args.pg_bin, out)
        e.report['status'] = 'passed'
    except BaseException as exc:
        e.report.update(status='failed', failure=repr(exc))
    finally:
        for t in threads:
            t.join(timeout=5)
        try:
            e.close()
        except BaseException as exc:
            e.report.update(status='failed', cleanup_failure=repr(exc))
        e.report.update(checks=checks, source_sha256={str(x.relative_to(ROOT)): sha(x) for x in [MIGRATION, PREIMAGE, Path(__file__)]}, ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        (out / 'result.json').write_text(json.dumps(e.report, indent=2) + '\n')
        print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup_failure']}))
    return 0 if e.report.get('status') == 'passed' else 1

if __name__ == '__main__':
    sys.exit(main())
