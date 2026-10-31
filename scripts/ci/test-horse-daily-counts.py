#!/usr/bin/env python3
"""Real PG17 accepted-hand projection: paired counts, replay, races, rollback.
No DSN or remote connection accepted. Uses a private Unix socket and synthetic
hands only; the captured preimage/types contain no player data.
"""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/sql/fixtures/horse-daily-counts'
MIGRATION = ROOT / 'supabase/migrations/20261025185247_horse_daily_counts_share_the_accepted_hand_receipt.sql'
SEAT_MIGRATION = ROOT / 'supabase/migrations/20261026142110_accepted_horse_hand_projection_updates_its_physical_seat_clo.sql'
WITNESS_MIGRATION = ROOT / 'supabase/migrations/20261026181909_all_in_runout_witnesses_survive_the_accepted_stats_projector.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
BASE = Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
if sys.platform == 'darwin' and not str(BASE).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('TMPDIR must be the task-owned external SSD scratch directory')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV.update(LANG='C', LC_ALL='C')


def uid(label):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'horse-daily-counts/' + label))


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def payload(label, **over):
    f = dict(hand_id=uid(label), user_id=uid('horse'), table_id=uid('table'),
             club_id=uid('club'), tournament_id=None, played_at='2026-10-24T23:59:59.125Z',
             game_variant='nlh', big_blind=2, position='btn', players_dealt=3,
             invested=2, returned=5, net=3, net_bb=1.5, rake_paid=.1,
             ev_net=3, ev_net_bb=1.5)
    f.update({k:False for k in ['vpip','pfr','three_bet','four_bet','faced_three_bet',
        'folded_to_three_bet','had_cbet_flop_opp','cbet_flop','saw_flop',
        'went_to_showdown','won_at_showdown','was_all_in']})
    f.update(aggressive_actions=0,passive_actions=0)
    n = dict(horse_user_id=uid('horse'), day='2026-10-24', game_variant='nlh',
             format='cash', hands=1, net_bb=1.5, rake_bb=.05, bbj_bb=.01)
    p = dict(horse_user_id=uid('horse'), day='2026-10-24', format='cash',
             floored=False, hands=1, vpip=1, pfr=0, three_bets=0, three_bet_opps=0,
             open_raises=0, faced_3bets=0, fold_to_3bets=0, saw_flop=1,
             won_when_saw_flop=1, post_aggr=0, post_passive=1)
    d = dict(version=2, facts=[f], transfers=[], horse_rollups=dict(version=1,nets=[n],play=[p]))
    d.update(over)
    return d


def main():
    checks = []
    if os.geteuid() == 0:
        raise RuntimeError('Run as non-root (initdb requirement)')
    with tempfile.TemporaryDirectory(prefix='horse-counts-', dir=BASE) as raw, \
         tempfile.TemporaryDirectory(prefix='hc-', dir=BASE.parents[1]) as sock:
        data = Path(raw)/'data'
        def command(args, sql=None):
            return subprocess.run(list(map(str,args)), input=sql, text=True,
                                  capture_output=True, env=ENV, timeout=60)
        def run(sql, ok=True):
            r = command([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,
                         '-p','55497','-U','postgres','-d','postgres'],sql)
            if ok is None:
                return r
            if (r.returncode == 0) != ok:
                raise AssertionError(r.stderr or r.stdout)
            return r.stdout.strip() if ok else r.stderr
        def check(name, condition):
            if not condition:
                raise AssertionError(name)
            checks.append(name)
        def accept(label, d):
            run('INSERT INTO hand_atomic_commits VALUES (' +
                "'"+uid(label)+"','"+uid('table')+"',"+
                literal(dict(accepted_hand_facts=dict(stats_facts=d)))+');')
        def project(label, ok=True):
            return run("SELECT ca_project_hand_stats_facts('"+uid(label)+"');",ok)
        def counts():
            return json.loads(run("SELECT json_build_array((SELECT coalesce(sum(hands),0) FROM horse_daily_nets),(SELECT coalesce(sum(hands),0) FROM horse_daily_play),(SELECT count(*) FROM ca_hand_fact_projection_receipts));"))
        r=command([PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale'])
        if r.returncode: raise RuntimeError(r.stderr)
        r=command([PG/'pg_ctl','-D',data,'-l',Path(raw)/'postgres.log','-o',f'-k {sock} -p 55497 -c listen_addresses= -c fsync=off','-w','start'])
        if r.returncode: raise RuntimeError(r.stderr)
        try:
            run("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE hand_atomic_commits(hand_id uuid PRIMARY KEY,table_id uuid,post_commit_payload jsonb); CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY,host_table_id uuid);")
            run((FIXTURE/'schema.sql').read_text())
            run((FIXTURE/'add.sql').read_text())
            run((FIXTURE/'projector-before.sql').read_text()+';')
            lightning_source = (ROOT/'supabase/migrations/20261025000729_lightning_hands_reach_the_stats_facts_and_the_collusion_scan.sql').read_text()
            validator = re.search(r'CREATE FUNCTION public\.fn_lightning_hand_stats_facts\(.*?AS \$function\$.*?\$function\$;',lightning_source,re.S)
            if not validator: raise RuntimeError('maintained Lightning validator is missing')
            run(validator.group(0))
            run('REVOKE ALL ON FUNCTION ca_project_hand_stats_facts(uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION ca_project_hand_stats_facts(uuid) TO service_role;')
            run("INSERT INTO tables VALUES ('"+uid('table')+"','"+uid('club')+"');")
            check('exact production preimage',run("SELECT md5(pg_get_functiondef('ca_project_hand_stats_facts(uuid)'::regprocedure));")=='a1cb10fc7d70197179861c09c6caa91c')
            check('old projector does not advertise the new count contract','horse_daily_rollups_contract' not in json.loads(run('SELECT ca_project_hand_stats_facts(NULL);')))
            accept('before',payload('before')); project('before')
            check('baseline leaves both daily counts outside accepted projection',counts()==[0,0,1])
            run('TRUNCATE ca_hand_facts,ca_hand_transfers,ca_hand_fact_projection_receipts,hand_atomic_commits;')
            run(MIGRATION.read_text())
            run("CREATE TABLE ca_horse_fleet_state(horse_id uuid PRIMARY KEY,table_id uuid,last_action_at timestamptz,updated_at timestamptz); INSERT INTO ca_horse_fleet_state VALUES ('"+uid('horse')+"','"+uid('table')+"',NULL,now());")
            run(SEAT_MIGRATION.read_text())
            witness_baseline=payload('witness-before')
            witness_baseline['facts'][0].update(all_in_equity_owed=True,was_all_in=True,went_to_showdown=True,all_in_street='flop')
            baseline_sql="BEGIN; INSERT INTO hand_atomic_commits VALUES ('"+uid('witness-before')+"','"+uid('table')+"',"+literal(dict(accepted_hand_facts=dict(stats_facts=witness_baseline)))+"); SELECT ca_project_hand_stats_facts('"+uid('witness-before')+"'); SELECT all_in_equity_owed FROM ca_hand_facts WHERE hand_id='"+uid('witness-before')+"'; ROLLBACK;"
            check('before repair the real projector drops a true original witness',run(baseline_sql).splitlines()[-1]=='f')
            run(WITNESS_MIGRATION.read_text())
            check('exact witness projector postimage',run("SELECT md5(pg_get_functiondef('ca_project_hand_stats_facts(uuid)'::regprocedure));")=='1fbfe441e124bff9317e4f8b1c3def8c')

            accept('once',payload('once')); project('once'); project('once')
            check('lost ACK / duplicate projection counts once',counts()==[1,1,1])
            check('accepted hand advances physical seat clock',run("SELECT last_action_at='2026-10-24T23:59:59.125Z'::timestamptz FROM ca_horse_fleet_state;")=='t')
            run("UPDATE ca_horse_fleet_state SET last_action_at='2026-10-25T01:00:00Z';")
            race=payload('race'); race['facts'][0].update(all_in_equity_owed=True,was_all_in=True,went_to_showdown=True,all_in_street='turn')
            accept('race',race)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(lambda _:project('race'),range(8)))
            check('eight concurrent projections count once',counts()==[2,2,2])
            check('concurrent original receipt retains its owed witness',run("SELECT all_in_equity_owed FROM ca_hand_facts WHERE hand_id='"+uid('race')+"';")=='t')
            check('older accepted hand never regresses the seat clock',run("SELECT last_action_at='2026-10-25T01:00:00Z'::timestamptz FROM ca_horse_fleet_state;")=='t')
            d=payload('legacy'); d.pop('horse_rollups'); accept('legacy',d); project('legacy')
            check('legacy receipt never adds new daily counts',counts()==[2,2,3])
            # Fault after the nets update. The original transaction must undo
            # facts, receipt and nets, then accept exactly once on recovery.
            run("CREATE FUNCTION public.fixture_fail_play() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_play_failure'; END $$; CREATE TRIGGER injected_failure BEFORE INSERT OR UPDATE ON horse_daily_play FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_play();")
            accept('rollback',payload('rollback'))
            check('fault reaches second aggregate', 'injected_play_failure' in project('rollback',False))
            check('failed second aggregate rolls back both and receipt',counts()==[2,2,3])
            check('failed projection leaves no partial fact',run("SELECT count(*) FROM ca_hand_facts WHERE hand_id='"+uid('rollback')+"';")=='0')
            run('DROP TRIGGER injected_failure ON horse_daily_play;'); project('rollback')
            check('same accepted receipt recovers once',counts()==[3,3,4])
            for label,change in [('missing-play',lambda d:d['horse_rollups'].update(play=[])),
                                 ('duplicate-horse',lambda d:d['horse_rollups']['nets'].append(d['horse_rollups']['nets'][0])),
                                 ('wrong-day',lambda d:d['horse_rollups']['nets'][0].update(day='2026-10-25')),
                                 ('wrong-net',lambda d:d['horse_rollups']['nets'][0].update(net_bb=999)),
                                 ('wrong-format',lambda d:d['horse_rollups']['play'][0].update(format='tournament')),
                                 ('negative-frequency',lambda d:d['horse_rollups']['play'][0].update(vpip=-1))]:
                d=payload(label); change(d); accept(label,d)
                check(label+' refused','horse rollups refused' in project(label,False))
                check(label+' leaves no count/receipt',counts()==[3,3,4])
            check('participant roles cannot execute projector',run("SELECT has_function_privilege('anon','ca_project_hand_stats_facts(uuid)','execute') OR has_function_privilege('authenticated','ca_project_hand_stats_facts(uuid)','execute');")=='f')
            check('service role retains projector',run("SELECT has_function_privilege('service_role','ca_project_hand_stats_facts(uuid)','execute');")=='t')
            check('capability is installed with the projector',json.loads(run('SELECT ca_project_hand_stats_facts(NULL);'))['horse_daily_rollups_contract']==1)
            check('capability cannot alter counts or receipts',counts()==[3,3,4])
            changed=payload('once'); changed['horse_rollups']['nets'][0]['net_bb']=9
            run('UPDATE hand_atomic_commits SET post_commit_payload='+literal(dict(accepted_hand_facts=dict(stats_facts=changed)))+" WHERE hand_id='"+uid('once')+"';")
            check('changed original source is refused','source_hash_conflict' in project('once',False))
            check('source conflict cannot recount',counts()==[3,3,4])
            run("UPDATE ca_horse_fleet_state SET table_id='"+uid('moved-table')+"',last_action_at=NULL;")
            midnight=payload('midnight');midnight['facts'][0]['played_at']='2026-10-24T00:00:00.001Z'
            accept('midnight',midnight)
            run("SET TIME ZONE 'America/Chicago'; SELECT ca_project_hand_stats_facts('"+uid('midnight')+"');")
            check('UTC day survives a different database session timezone',counts()==[4,4,5])
            check('delayed hand cannot touch a different physical seat',run("SELECT last_action_at IS NULL FROM ca_horse_fleet_state;")=='t')
            run("UPDATE ca_horse_fleet_state SET table_id='"+uid('table')+"';")
            lightning=payload('lightning')
            for arm in ['nets','play']:lightning['horse_rollups'][arm][0]['format']='lightning_2bb'
            kept=json.loads(run("SELECT fn_lightning_hand_stats_facts("+literal({'_accepted_post_commit_facts':{'stats_facts':lightning}})+",'"+uid('lightning')+"','"+uid('table')+"','"+uid('club')+"');"))
            check('actual Lightning validator retains the complete private paired-count payload',kept=={'stats_facts':lightning})
            run("INSERT INTO lightning_hand VALUES ('"+uid('lightning')+"','"+uid('table')+"');")
            accept('lightning',lightning);project('lightning');project('lightning')
            check('durable Lightning identity preserves its separate paired bucket',counts()==[5,5,6])
            check('Lightning host hand never touches the physical seat clock',run("SELECT last_action_at IS NULL FROM ca_horse_fleet_state;")=='t')
            run("CREATE FUNCTION fixture_fail_seat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_seat_failure'; END $$; CREATE TRIGGER injected_seat_failure BEFORE UPDATE ON ca_horse_fleet_state FOR EACH ROW EXECUTE FUNCTION fixture_fail_seat();")
            accept('seat-failure',payload('seat-failure'))
            check('seat failure is observable', 'injected_seat_failure' in project('seat-failure',False))
            check('seat failure rolls back counts and projection receipt',counts()==[5,5,6])
            run('DROP TRIGGER injected_seat_failure ON ca_horse_fleet_state;')
            project('seat-failure');project('seat-failure')
            check('original hand recovers atomically once',counts()==[6,6,7])
            check('recovery advances the physical clock',run("SELECT last_action_at='2026-10-24T23:59:59.125Z'::timestamptz FROM ca_horse_fleet_state;")=='t')
            forged=payload('forged-lightning')
            for arm in ['nets','play']:forged['horse_rollups'][arm][0]['format']='lightning_2bb'
            accept('forged-lightning',forged)
            check('ordinary hand cannot claim a Lightning bucket','paired_fact_scope' in project('forged-lightning',False))
            for street in ['preflop','flop','turn']:
                label='witness-'+street
                d=payload(label)
                d['facts'][0].update(all_in_equity_owed=True,was_all_in=True,went_to_showdown=True,all_in_street=street,all_in_equity=None)
                accept(label,d); first=project(label); second=project(label)
                check(street+' original owed witness persists without invented equity',run("SELECT all_in_equity_owed AND all_in_equity IS NULL FROM ca_hand_facts WHERE hand_id='"+uid(label)+"';")=='t')
                check(street+' duplicate original projection is stable',first==second)
            check('legacy omitted witness remains false',run("SELECT NOT all_in_equity_owed FROM ca_hand_facts WHERE hand_id='"+uid('legacy')+"';")=='t')
            for bad in [None,'true',1]:
                label='witness-invalid-'+str(bad)
                d=payload(label); d['facts'][0]['all_in_equity_owed']=bad
                accept(label,d)
                check('malformed witness '+str(bad)+' refused','invalid_all_in_equity_witness' in project(label,False))
            d=payload('witness-false'); d['facts'][0]['all_in_equity_owed']=False
            accept('witness-false',d); project('witness-false')
            check('explicit false witness persists',run("SELECT NOT all_in_equity_owed FROM ca_hand_facts WHERE hand_id='"+uid('witness-false')+"';")=='t')
            run("UPDATE ca_hand_facts SET all_in_equity_owed=false WHERE hand_id='"+uid('witness-flop')+"';")
            unchanged=counts()
            check('original receipt detects a changed stored witness','existing_fact_conflict' in project('witness-flop',False))
            check('witness conflict cannot recount either daily aggregate',counts()==unchanged)
            d=payload('witness-turn'); d['facts'][0].update(all_in_equity_owed=False,was_all_in=True,went_to_showdown=True,all_in_street='turn',all_in_equity=None)
            run("UPDATE hand_atomic_commits SET post_commit_payload="+literal(dict(accepted_hand_facts=dict(stats_facts=d)))+" WHERE hand_id='"+uid('witness-turn')+"';")
            check('changed original witness cannot replace accepted hash','source_hash_conflict' in project('witness-turn',False))
            check('installed witness migration cannot replay','all_in_witness_projector_preimage_changed' in run(WITNESS_MIGRATION.read_text(),False))
            spec=importlib.util.spec_from_file_location('booking_cap',ROOT/'scripts/ci/horse-booking-cap-native.py')
            booking_cap=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(booking_cap)
            booking_cap.verify(ROOT,run,check,uid,ROOT/'supabase/migrations/20261026230116_late_tournament_registration_obeys_the_four_game_cap.sql')
        finally:
            command([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])

    subprocess.run([sys.executable, '-B', str(ROOT/'scripts/ci/test-horse-future-purchase-budget.py')], cwd=ROOT, env={**ENV, 'PG_BIN':str(PG), 'TMPDIR':str(BASE)}, check=True, timeout=120)

    # Daily horse reporting shares this existing required native owner. Run the
    # source-bound audit fixture after the accepted-hand cluster is stopped;
    # no new workflow/matrix, shared input-map churn or optional test path.
    audit = subprocess.run([
        sys.executable, '-B', str(ROOT/'scripts/ci/run_launch_reset_accounting_fixture.py'),
        '--fixture', str(ROOT/'scripts/ci/fixtures/horse-layer-outcomes.sql'),
        '--candidate', str(ROOT/'supabase/migrations/20261026143605_horse_audit_separates_outcomes_from_execution_layers.sql'),
        '--work-root', str(BASE), '--pg-bin', str(PG),
    ], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=120)
    if audit.returncode:
        raise AssertionError(audit.stderr or audit.stdout)
    audit_reporting = json.loads(audit.stdout)
    if audit_reporting.get('native_fixture') != 'passed':
        raise AssertionError('Daily audit native fixture supplied no passing receipt')
    print(json.dumps(dict(passed=True, checks=checks,
        migration_sha256=hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
        audit_reporting=audit_reporting, witness_migration_sha256=hashlib.sha256(WITNESS_MIGRATION.read_bytes()).hexdigest(), production_mutations=False), indent=2))


if __name__=='__main__':
    main()
