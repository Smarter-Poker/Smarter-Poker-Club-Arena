#!/usr/bin/env python3
"""Qualify additive deal witness ranking in an exclusively owned native PG17 fixture.

Requires a copy of the retained full_stage1 fixture, never its shared source.
Every scenario, including migration application and replay, rolls back. Reuses
actual phase-three consent, payout, seat, finish and certificate authorities.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = 'supabase/migrations/20260911204238_final_deal_tail_binds_accepted_bust_witness.sql'
TID = '87000000-0000-0000-0000-000000000001'
CASES = ['paid', 'unpaid', 'partial', 'legacy_paid', 'legacy_inverted', 'legacy_open_consent', 'commit_order', 'same_hand', 'same_hand_equal', 'pruned_commit', 'no_candidate', 'rebought_decoy', 'prune_after_payment', 'stale_witness', 'paid_misrank', 'drift_body', 'drift_acl', 'drift_config', 'drift_helper', 'drift_rank_schema']


def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('expected one exact native marker: ' + old[:100])
    return source.replace(old, new, 1)


def module(path):
    spec = importlib.util.spec_from_file_location('native_deal', path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def compose(case):
    final = module(ROOT / 'scripts/ci/rehearse-final-deal-current-terminal.py')
    variant = case if case in ('paid', 'unpaid', 'partial') else 'paid' if case in ('legacy_paid', 'paid_misrank') else 'unpaid'
    sql = final.compose(ROOT, variant)
    migration = re.sub(r'^(BEGIN|COMMIT);$', '', (ROOT / MIGRATION).read_text(), flags=re.M)
    if case == 'legacy_paid':
        sql = once(sql, 'END $settle$;', 'END $settle$;\nCREATE TEMP TABLE legacy_pre_upgrade AS SELECT pg_temp.final_deal_exact_state() AS state;\n' + migration + '\n' + legacy_replay())
        return sql
    if case == 'legacy_inverted':
        if sql.count('generate_series(1,6) g(i)') != 5:
            raise ValueError('native synthetic roster seed changed')
        sql = sql.replace('generate_series(1,6) g(i)', 'generate_series(1,8) g(i)')
        sql = once(sql, 'CREATE FUNCTION pg_temp.deal_assert', (ROOT / 'scripts/ci/probes/final-deal-bust-witness-fixture.sql').read_text() + '\nCREATE FUNCTION pg_temp.deal_assert')
        sql = once(sql, 'END $settle$;', 'END $settle$;\nCREATE TEMP TABLE legacy_pre_upgrade AS SELECT pg_temp.final_deal_exact_state() AS state;\n' + migration + '\n' + legacy_replay())
        sql = once(sql, 'SET CONSTRAINTS ALL IMMEDIATE;', "SELECT pg_temp.deal_assert((SELECT position=6 FROM public.tournament_players WHERE tournament_id='" + TID + "' AND user_id=md5('atomic-deal-user:8')::uuid),'paid recording-order recipient remains unchanged despite contrary bust witness');\nSET CONSTRAINTS ALL IMMEDIATE;")
        return sql
    if case == 'legacy_open_consent':
        return sql.split('-- Observe the final receipt only')[0] + migration + f"""
DO $old_consent$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); r record; result jsonb; refused boolean:=false;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 result:=public.fn_get_tournament_deal_consensus('{TID}');
 PERFORM pg_temp.deal_assert(result->>'ready'='false','pre-upgrade open consent requires a fresh witness-bound proposal');
 BEGIN
  result:=public.fn_complete_tournament_terminal_proposal('{TID}',NULL,'final_table_deal',r.proposal_id,r.revision);
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM='deal proposal is stale' THEN refused:=true; ELSE RAISE; END IF;
 END;
 PERFORM pg_temp.deal_assert(refused AND pg_temp.final_deal_exact_state()=original,
  'upgrading open consent changes no payment or original immutable proposal');
END $old_consent$;
ROLLBACK;
"""
    if case.startswith('drift_'):
        alterations = {
            'drift_body': "COMMENT ON FUNCTION public.fn_ca_tournament_deal_snapshot(uuid) IS 'synthetic'; CREATE OR REPLACE FUNCTION public.fn_ca_tournament_deal_snapshot(p_tournament_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp SET timezone TO 'UTC' AS $bad$BEGIN RETURN '{}'::jsonb; END$bad$;",
            'drift_acl': 'GRANT EXECUTE ON FUNCTION public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean) TO service_role;',
            'drift_rank_schema': migration + "ALTER TABLE public.tournament_final_table_deal_batches DROP CONSTRAINT final_deal_bust_rank_basis; ALTER TABLE public.tournament_final_table_deal_batches ADD CONSTRAINT final_deal_bust_rank_basis CHECK (true);",
            'drift_helper': migration + "CREATE OR REPLACE FUNCTION public.fn_ca_final_deal_bust_tail(p_tournament_id uuid,p_live_count integer) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO public,pg_temp AS $bad$BEGIN RETURN '[]'::jsonb; END$bad$;",
            'drift_config': "ALTER FUNCTION public.fn_settle_tournament_final_table_deal(uuid) SET statement_timeout='29s';",
        }
        return sql.split('CREATE FUNCTION pg_temp.deal_assert')[0] + alterations[case] + '\n' + migration + '\nROLLBACK;\n'
    sql = once(sql, 'CREATE FUNCTION pg_temp.deal_assert', migration + '\n' + migration + '\nCREATE FUNCTION pg_temp.deal_assert')
    sql = once(sql, "  'UPDATE public.tournament_final_table_deal_batches SET plan", "  'UPDATE public.tournament_final_table_deal_batches SET rank_basis=''recording_sequence_v2'' WHERE tournament_id=''" + TID + "''',\n  'UPDATE public.tournament_final_table_deal_batches SET bust_tail_snapshot=''[]''::jsonb WHERE tournament_id=''" + TID + "''',\n  'UPDATE public.tournament_final_table_deal_batches SET plan")
    multi = case in ('commit_order', 'same_hand', 'same_hand_equal', 'pruned_commit', 'stale_witness', 'paid_misrank', 'prune_after_payment', 'no_candidate', 'rebought_decoy')
    if multi:
        if sql.count('generate_series(1,6) g(i)') != 5:
            raise ValueError('native synthetic roster seed changed')
        sql = sql.replace('generate_series(1,6) g(i)', 'generate_series(1,8) g(i)')
        fixture = (ROOT / 'scripts/ci/probes/final-deal-bust-witness-fixture.sql').read_text()
        if case == 'no_candidate':
            fixture = fixture.split('INSERT INTO public.hand_atomic_commits')[0]
            fixture += "UPDATE public.tournament_players SET eliminated_at=CASE user_id WHEN md5('atomic-deal-user:7')::uuid THEN '2026-09-10 10:30:00+00'::timestamptz WHEN md5('atomic-deal-user:6')::uuid THEN '2026-09-10 10:20:00+00'::timestamptz ELSE '2026-09-10 10:10:00+00'::timestamptz END WHERE tournament_id='" + TID + "' AND status='eliminated';\n"
        if case == 'rebought_decoy':
            fixture += "INSERT INTO public.tournament_knockout_candidates SELECT (jsonb_populate_record(NULL::public.tournament_knockout_candidates,to_jsonb(c)||jsonb_build_object('id',md5('witness-rebought-decoy')::uuid,'state','rebought','hand_number',9801007,'hand_id',md5('witness-rebought-hand')::uuid,'seat_joined_at','2026-09-09 00:00:00+00'))).* FROM public.tournament_knockout_candidates c WHERE id=md5('witness-candidate:7')::uuid;\n"
        if case in ('same_hand', 'same_hand_equal'):
            fixture += "UPDATE public.tournament_knockout_candidates SET hand_number=9800007,hand_id=md5('witness-hand:7')::uuid WHERE id=md5('witness-candidate:6')::uuid;\n"
        if case == 'same_hand_equal':
            fixture += "UPDATE public.tournament_knockout_candidates SET stack_before=70 WHERE id=md5('witness-candidate:6')::uuid;\n"
        if case == 'pruned_commit':
            fixture += 'DELETE FROM public.hand_atomic_commits WHERE hand_number BETWEEN 9800006 AND 9800008;\n'
        sql = once(sql, 'CREATE FUNCTION pg_temp.deal_assert', fixture + '\nCREATE FUNCTION pg_temp.deal_assert')
        # Include witness inputs in rollback evidence, as well as original 29 tables.
        sql = once(sql, "'tournament_deal_proposal_executions']", "'tournament_deal_proposal_executions','hand_atomic_commits','tournament_knockout_candidates']")
        if case == 'stale_witness':
            sql = once(sql, 'CREATE FUNCTION pg_temp.final_deal_late_fault()', (ROOT / 'scripts/ci/probes/final-deal-bust-witness-consent.sql').read_text() + '\nCREATE FUNCTION pg_temp.final_deal_late_fault()')
        if case == 'prune_after_payment':
            sql = once(sql, 'END $settle$;', 'END $settle$;\n' + f"""DELETE FROM public.hand_atomic_commits WHERE hand_number BETWEEN 9800006 AND 9800008;
DO $pruned_replay$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); r record; result jsonb;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 result:=public.fn_complete_tournament_terminal_proposal('{TID}',NULL,'final_table_deal',r.proposal_id,r.revision);
 PERFORM pg_temp.deal_assert(result=(SELECT receipt FROM native_deal_terminal_result), 'new paid witness receipt survives commit pruning');
 result:=public.fn_settle_tournament_final_table_deal('{TID}');
 PERFORM pg_temp.deal_assert(result->>'ok'='true' AND pg_temp.final_deal_exact_state()=original,
  'pruned-witness direct replay changes no receipt or payment');
END $pruned_replay$;
""")
        if case == 'paid_misrank':
            return sql.split('-- Observe the final receipt only')[0] + paid_misrank() + '\nROLLBACK;\n'
        expected = "md5('atomic-deal-user:7')::uuid"
        if case == 'same_hand_equal':
            expected = "greatest(md5('atomic-deal-user:6')::uuid,md5('atomic-deal-user:7')::uuid)"
        assertions = f"""SELECT pg_temp.deal_assert((SELECT position=6 FROM public.tournament_players
 WHERE tournament_id='{TID}' AND user_id={expected}),
 'accepted witness selects the true sixth-place recipient');
SELECT pg_temp.deal_assert((SELECT rank_basis='accepted_bust_witness_v1' AND jsonb_array_length(bust_tail_snapshot)=3
 FROM public.tournament_final_table_deal_batches WHERE tournament_id='{TID}'),
 'immutable receipt binds all three eliminated witnesses');
"""
        sql = once(sql, 'SET CONSTRAINTS ALL IMMEDIATE;', assertions + '\nSET CONSTRAINTS ALL IMMEDIATE;')
    return sql


def legacy_replay():
    return f"""DO $legacy$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); r record; result jsonb;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 PERFORM pg_temp.deal_assert(jsonb_set(original,'{{tournament_final_table_deal_batches}}',
  (SELECT jsonb_agg(to_jsonb(b)-'rank_basis'-'bust_tail_snapshot' ORDER BY to_jsonb(b)::text)
   FROM public.tournament_final_table_deal_batches b))=(SELECT state FROM legacy_pre_upgrade),
  'migration preserves every historical value while adding rank metadata');
 PERFORM pg_temp.deal_assert((SELECT rank_basis='recording_sequence_v2' AND bust_tail_snapshot IS NULL
  FROM public.tournament_final_table_deal_batches WHERE tournament_id='{TID}'), 'paid v2 deal retains recording rank basis');
 result:=public.fn_complete_tournament_terminal_proposal('{TID}',NULL,'final_table_deal',r.proposal_id,r.revision);
 PERFORM pg_temp.deal_assert(result=(SELECT receipt FROM native_deal_terminal_result), 'pre-migration paid v2 terminal receipt replays exactly');
 result:=public.fn_settle_tournament_final_table_deal('{TID}');
 PERFORM pg_temp.deal_assert(result->>'ok'='true' AND pg_temp.final_deal_exact_state()=original,
  'pre-migration paid v2 direct writer replay changes no rows');
END $legacy$;
"""


def paid_misrank():
    return f"""DO $misrank$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); r record; caught boolean:=false;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 BEGIN
  PERFORM public.fn_complete_tournament_terminal_proposal('{TID}',NULL,'final_table_deal',r.proposal_id,r.revision);
 EXCEPTION WHEN SQLSTATE 'P0404' THEN
  RAISE NOTICE 'EXPECTED_FINANCIAL_REFUSAL %',SQLERRM;
  caught:=true;
 END;
 PERFORM pg_temp.deal_assert(caught AND pg_temp.final_deal_exact_state()=original,
  'previously paid wrong tail rank refuses atomically without clawback or a second payout');
END $misrank$;
"""


def snapshot(command):
    tables = ['tournaments','tournament_players','tables','table_seats','club_members','wallets',
        'wallet_transactions','wallet_credit_idempotency','chip_ledger','tournament_escrow',
        'tournament_obligations','tournament_payouts','tournament_final_table_deal_batches',
        'tournament_final_table_deal_receipts','tournament_finish_receipts','tournament_terminal_settlements',
        'tournament_rake_settlements','rake_records','rake_attributions','agent_commissions','player_stats',
        'vip_points_carry','tournament_seat_exit_authorizations','tournament_deal_reviews',
        'tournament_deal_proposals','tournament_deal_proposal_consents','tournament_deal_proposal_executions',
        'hand_atomic_commits','tournament_knockout_candidates']
    inventory = subprocess.check_output(command + ['-c', "SELECT tablename FROM pg_tables WHERE schemaname='public'"], text=True).splitlines()
    result = {}
    # Hash only affected catalog rows. Unrelated autovacuum catalog statistics
    # are not migration effects; hashing the entire copied pg_attribute/pg_proc
    # in one aggregate also needlessly retains a large amount of server memory.
    catalog = {
        'pg_proc': "proname IN ('fn_ca_tournament_deal_snapshot','fn_settle_tournament_final_table_deal','fn_ca_verify_terminal_final_deal_batch','fn_ca_final_deal_bust_tail')",
        'pg_trigger': "tgrelid='public.tournament_final_table_deal_batches'::regclass",
        'pg_attribute': "attrelid='public.tournament_final_table_deal_batches'::regclass",
        'pg_attrdef': "adrelid='public.tournament_final_table_deal_batches'::regclass",
        'pg_constraint': "conrelid='public.tournament_final_table_deal_batches'::regclass",
    }
    for schema, name, where in [('pg_catalog', c, w) for c, w in catalog.items()] + [('public', t, 'true') for t in tables if t in inventory]:
        query = "SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM %s.%s t WHERE %s" % (schema, name, where)
        result[schema + '.' + name] = subprocess.check_output(command + ['-c', query], text=True).strip()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--psql', default='/opt/homebrew/opt/postgresql@17/bin/psql')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', action='append', choices=CASES)
    args = parser.parse_args()
    if not args.socket.is_absolute() or 'codex-chip-drift-cutover-e2iav203' in str(args.socket.resolve()):
        raise ValueError('use your own absolute local socket, never the retained shared fixture')
    command = [args.psql, '-X', '-h', str(args.socket), '-p', str(args.port), '-U', 'postgres', '-d', 'full_stage1', '-At', '-v', 'ON_ERROR_STOP=1']
    baseline = subprocess.check_output(command + ['-c', "SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||(current_setting('server_version_num')::integer/10000)||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())"], text=True).strip()
    if baseline != 'full_stage1|postgres|true|17|15|12|0':
        raise ValueError('owned PG17 fixture baseline differs: ' + baseline)
    args.output.mkdir(parents=True, exist_ok=True)
    cases = args.case or CASES
    before = snapshot(command)
    evidence = {'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'baseline': baseline,
        'production_mutation': False, 'runtime_triggers': 'origin', 'migration_sha256': hashlib.sha256((ROOT / MIGRATION).read_bytes()).hexdigest(), 'before_sha256': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(), 'scenarios': []}
    for case in cases:
        sql = compose(case)
        path = args.output / (case + '.sql')
        path.write_text(sql)
        run = subprocess.run(command + ['-f', str(path)], capture_output=True, text=True)
        log = run.stdout + run.stderr
        (args.output / (case + '.log')).write_text(log)
        exact_rollback = before == snapshot(command)
        expected_refusal = case.startswith('drift_') and run.returncode != 0 and 'final deal bust witness prerequisite differs' in log
        passed = exact_rollback and (expected_refusal if case.startswith('drift_') else run.returncode == 0)
        rows = [json.loads(line.split('=',1)[1]) for line in run.stdout.splitlines() if line.startswith('FINAL_DEAL_NATIVE_EVIDENCE=')]
        item = {'case': case, 'passed': passed, 'exit_code': run.returncode, 'assertions': len(re.findall(r'NOTICE:\s+PASS ', log)), 'sql_sha256': hashlib.sha256(sql.encode()).hexdigest(), 'expected_drift_refusal': expected_refusal, 'exact_outer_rollback': exact_rollback}
        if rows:
            item['batch'] = rows[0]['batch']
            item['seat_authority_inserts'] = rows[0]['authority_inserts']
            item['seat_authority_deletes'] = rows[0]['authority_deletes']
        evidence['scenarios'].append(item)
        print(case, 'PASS' if passed else 'FAIL', item['assertions'], flush=True)
        if not passed:
            print(log[-2400:])
    (args.output / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if not all(row['passed'] for row in evidence['scenarios']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
