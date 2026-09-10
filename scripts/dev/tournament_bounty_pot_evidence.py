"""Isolated PostgreSQL 17 proof of exact bounty-pot identity, without payment stubs."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / 'supabase/migrations/20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
MIGRATION = ROOT / 'supabase/migrations/20260910053723_tournament_bounty_per_pot_evidence.sql'
SIGNATURE = 'public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)'
OLD_HASH = '193de04c64c285ba0bf0cb20bb38c28d'
EVENT = 'd3000000-0000-4000-8000-000000000001'
HAND = 'd3000000-0000-4000-8000-000000000002'
A = 'd3000000-0000-4000-8000-000000000003'
B = 'd3000000-0000-4000-8000-000000000004'
BUSTED = 'd3000000-0000-4000-8000-000000000005'
OUTSIDER = 'd3000000-0000-4000-8000-000000000006'


def definition(path):
    sql = path.read_text()
    start = sql.index('CREATE OR REPLACE FUNCTION public.fn_exact_tournament_knockout_claimants(')
    end = sql.index('$function$;', start) + len('$function$;')
    return sql[start:end]


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pg-bin', default='/opt/homebrew/opt/postgresql@17/bin')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    pg = Path(args.pg_bin)
    temp = Path(tempfile.mkdtemp(prefix='ca-bounty-pot-pg17-'))
    sock = temp / 'socket'
    sock.mkdir()
    data = temp / 'data'
    with socket.socket() as port_probe:
        port_probe.bind(('127.0.0.1', 0))
        port = port_probe.getsockname()[1]
    env = dict(os.environ, LC_ALL='C', LANG='C', PGHOST=str(sock), PGPORT=str(port), PGDATABASE='postgres',
               PGUSER=os.environ.get('USER', 'smarter.poker'))
    passed = []
    started = False

    def run(command):
        return subprocess.run(command, check=True, capture_output=True, text=True, env=env)

    def query(sql):
        return subprocess.run([str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                              input=sql, text=True, capture_output=True, check=True, env=env).stdout.strip()

    def claim(pots, winners=None):
        if winners is None:
            winners = [dict(userId=A, amount=600, potIndex=0)]
        query("UPDATE hand_history SET pots=" + literal(pots) + ",winners=" + literal(winners) + ";")
        value = query("SELECT " + SIGNATURE.split('(')[0] + "('" + EVENT + "','" + HAND + "','" + BUSTED + "');")
        return json.loads(value) if value else None

    def pots(awards):
        return [dict(index=0, eligible=[A, B, BUSTED], amount=300),
                dict(index=1, eligible=[A, B, BUSTED], amount=300, awards=awards)]

    def check(name, result):
        assert result, name
        passed.append(name)

    try:
        run([str(pg / 'initdb'), '-D', str(data), '-A', 'trust', '--no-locale'])
        run([str(pg / 'pg_ctl'), '-D', str(data), '-l', str(temp / 'postgres.log'),
             '-o', "-F -k " + str(sock) + " -h '' -p " + str(port), '-w', 'start'])
        started = True
        query("""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE hand_history(id uuid PRIMARY KEY,pots jsonb,winners jsonb);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,PRIMARY KEY(tournament_id,user_id));
ALTER TABLE hand_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;
INSERT INTO hand_history VALUES ('""" + HAND + """',NULL,NULL);
INSERT INTO tournament_players VALUES """ +
              ','.join("('" + EVENT + "','" + uid + "')" for uid in [A, B, BUSTED]) + ';')
        old = definition(BASELINE)
        assert hashlib.md5(old.split('$function$')[1].encode()).hexdigest() == OLD_HASH
        query(old)
        old_pots = [dict(index=0, eligible=[A, BUSTED], amount=300),
                    dict(index=1, eligible=[A, BUSTED], amount=300)]
        check('baseline reproduces missing later-pot claimant from merged winner',
              claim(old_pots) is None)
        query('BEGIN;\n' + MIGRATION.read_text() + '\nCOMMIT;')
        new_hash = query("SELECT md5(prosrc) FROM pg_proc WHERE oid='" + SIGNATURE + "'::regprocedure;")
        expected_hash = hashlib.md5(definition(MIGRATION).split('$function$')[1].encode()).hexdigest()
        assert new_hash == expected_hash

        expected_a = [dict(user_id=A, weight=1)]
        expected_ab = [dict(user_id=A, weight=1), dict(user_id=B, weight=1)]
        check('actual later-pot award survives merged paid total',
              claim(pots([dict(userId=A, amount=300, potIndex=1, low=False)])) == expected_a)
        check('same claim replays deterministically without writing a payout',
              claim(pots([dict(userId=A, amount=300, potIndex=1, low=False)])) == expected_a)
        check('equal tied recipients remain distinct and preserve existing hi-lo sharing',
              claim(pots([dict(userId=A, amount=75, potIndex=1, low=False),
                          dict(userId=B, amount=75, potIndex=1, low=False),
                          dict(userId=A, amount=150, potIndex=1, low=True)])) == expected_ab)
        check('old ineligible side-pot winner remains refused',
              claim(old_pots, [dict(userId=A, amount=300, potIndex=0),
                               dict(userId=B, amount=300, potIndex=1)]) is None)
        # The preceding legacy row intentionally omits B from eligibility.
        valid_old = [dict(index=0, eligible=[A, B, BUSTED], amount=300),
                     dict(index=1, eligible=[B, BUSTED], amount=300)]
        check('old accepted complete pot history retains its claimant',
              claim(valid_old, [dict(userId=A, amount=300, potIndex=0),
                                dict(userId=B, amount=300, potIndex=1)]) == [dict(user_id=B, weight=1)])
        for label, awards in [
            ('null', None), ('empty', []), ('object', {}),
            ('wrong pot', [dict(userId=A, potIndex=0)]),
            ('missing pot', [dict(userId=A)]),
            ('self', [dict(userId=BUSTED, potIndex=1)]),
            ('outsider', [dict(userId=OUTSIDER, potIndex=1)]),
            ('malformed id', [dict(userId='bad-id', potIndex=1)]),
        ]:
            check('exact ' + label + ' evidence never falls back to merged winners',
                  claim(pots(awards)) is None)
        null_index = pots([dict(userId=A, amount=300, potIndex=1)])
        null_index[1]['index'] = None
        check('null pot index uses array position',
              claim(null_index) == expected_a)
        check('anonymous and authenticated calls remain refused',
              query("SELECT NOT has_function_privilege('anon','" + SIGNATURE + "','EXECUTE') AND "
                    "NOT has_function_privilege('authenticated','" + SIGNATURE + "','EXECUTE') "
                    "AND has_function_privilege('service_role','" + SIGNATURE + "','EXECUTE');") == 't')
        check('rows remain limited to synthetic fixture evidence',
              query("SELECT (SELECT count(*) FROM hand_history)=1 AND "
                    "(SELECT count(*) FROM tournament_players)=3;") == 't')
        result = dict(passed=len(passed), cases=passed, baseline_md5=OLD_HASH,
                      proposed_md5=new_hash, cluster=str(temp), scope='claimant read authority only')
        Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    finally:
        if started:
            run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', 'stop'])
            print('Private PostgreSQL cluster stopped')


if __name__ == '__main__':
    main()
