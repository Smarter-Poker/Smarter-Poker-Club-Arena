#!/usr/bin/env python3
"""Run actual cash entry-close proof functions against synthetic PG17 inputs.

Only an isolated Unix-socket cluster is used. No database URL is accepted.
This is result-cache acceptance, not a wallet or terminal-settlement test.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get('POKER_AUDIT_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
root = Path(tempfile.mkdtemp(prefix='ca-entry-reprice-pg17-'))
cluster, sock = root / 'cluster', root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
           PGUSER='reprice_test', PGDATABASE='postgres')
client = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
event = 'd3000000-0000-4000-8000-000000000001'
legacy = repo / 'supabase/migrations/20260908042200_late_registration_can_build_its_first_table.sql'
change = repo / 'supabase/migrations/20260910053005_cash_entry_close_proves_the_reserved_unpaid_ladder.sql'
passed = []
started = False

def definition(path, name):
    source = path.read_text()
    start = source.index('CREATE OR REPLACE FUNCTION public.' + name + '(')
    tag = re.search(r'AS\s+(\$\w*\$)', source[start:])
    end = source.index(tag[1] + ';', start + tag.end())
    return source[start:end + len(tag[1]) + 1]

with (root / 'results.log').open('w') as log:
    def run(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)
        log.flush()

    def q(sql, error=None):
        result = subprocess.run(client, input=sql + '\n', capture_output=True,
                                text=True, env=env, timeout=15)
        log.write(result.stdout + result.stderr)
        log.flush()
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def call():
        return json.loads(q("SELECT public.fn_complete_tournament_entry_reprice('" + event + "');"))

    def reset(bubble=False):
        q("TRUNCATE tournaments,tournament_players,tournament_entry_close_receipts,tournament_payouts; "
          "INSERT INTO tournaments (id,prize_pool,payout_structure,variant,tournament_type,buy_in_amount,bubble_protection,prize_pool_finalized) VALUES ('"
          + event + "',1000,'[{\"place\":1,\"percentage\":50},{\"place\":2,\"percentage\":30},{\"place\":3,\"percentage\":20}]','mtt','MTT',100,"
          + ('true' if bubble else 'false') + ",true); "
          "INSERT INTO tournament_players(tournament_id,user_id,status,position,prize) VALUES "
          + ','.join("('" + event + "','" + str(i) + "','" + ('playing' if i == 1 else 'eliminated')
                     + "'," + ('NULL' if i == 1 else str(i)) + ","
                     + str(({2:270,3:180} if bubble else {2:300,3:200}).get(i,0)) + ")" for i in range(1,5)) + "; "
          "INSERT INTO tournament_entry_close_receipts(tournament_id,final_prize_pool,payout_structure_snapshot) "
          "SELECT id,prize_pool,payout_structure FROM tournaments;")

    def state():
        return q("SELECT jsonb_build_object('t',(SELECT jsonb_agg(t) FROM tournaments t),"
                 "'p',(SELECT jsonb_agg(p) FROM tournament_players p),'money',(SELECT jsonb_agg(p) FROM tournament_payouts p));")

    def check(name, condition):
        assert condition, name
        passed.append(name)
        print('PASS ' + name, flush=True)

    try:
        assert ' 17.' in subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        run([str(pg / 'initdb'), '-D', str(cluster), '-U', 'reprice_test', '--auth=trust', '--no-locale'])
        run([str(pg / 'pg_ctl'), '-D', str(cluster), '-o', f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        fixture = repo / 'scripts/dev/fixtures/tournament-payout-amounts'
        q('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;')
        q((fixture / 'fixture.sql').read_text())
        q("ALTER TABLE tournaments ADD COLUMN prize_pool_finalized boolean; "
          "ALTER TABLE tournament_players ADD COLUMN user_id text,ADD COLUMN status text,ADD COLUMN position integer,ADD COLUMN prize numeric; "
          "CREATE TABLE tournament_entry_close_receipts(tournament_id uuid PRIMARY KEY,final_prize_pool numeric,payout_structure_snapshot jsonb,reprice_completed_at timestamptz,updated_at timestamptz); "
          "CREATE TABLE tournament_payouts(tournament_id uuid,user_id text,position integer,source text,amount numeric);")
        q(definition(repo / 'supabase/migrations/20260902013000_every_tournament_insert_was_failing_on_a_text_column_read_as_jsonb.sql', 'fn_safe_jsonb_array'))
        q(definition(legacy, 'fn_tournament_place_prize_exact'))
        q((fixture / 'installed.sql').read_text())
        q(definition(legacy, 'fn_complete_tournament_entry_reprice'))
        q('REVOKE ALL ON FUNCTION fn_complete_tournament_entry_reprice(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_complete_tournament_entry_reprice(uuid) TO service_role;')
        baseline_hash = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_complete_tournament_entry_reprice(uuid)'::regprocedure;")
        assert baseline_hash == '51c598a2fdb9a805485dec239eb70169', baseline_hash
        amount_hash = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_tournament_place_amounts(uuid)'::regprocedure;")
        assert amount_hash == '8f6cde5f5b799949506259f3064568b9', amount_hash
        reset()
        check('installed baseline falsely requires already-paid cash places', call() == {'ok':False,'reason':'reprice_incomplete','mismatches':2})
        q(change.read_text())
        reset()
        before = state()
        check('final unpaid cash facts complete without any wallet payment', call()['ok'] is True)
        check('cash proof writes only its own completion receipt', state() == before)
        stamp = q('SELECT reprice_completed_at FROM tournament_entry_close_receipts;')
        check('receipt replay is idempotent', call().get('already_completed') is True and stamp == q('SELECT reprice_completed_at FROM tournament_entry_close_receipts;'))
        reset(True)
        check('bubble amounts agree with the canonical reserved ladder', call()['ok'] is True)
        reset(True)
        q("UPDATE tournament_players SET prize=300 WHERE position=2;")
        check('old full-pool bubble amount cannot complete', call() == {'ok':False,'reason':'reprice_incomplete','mismatches':1})
        reset()
        q("UPDATE tournament_players SET prize=300.001 WHERE position=2;")
        check('fractional-cent result cannot complete', call().get('mismatches') == 1)
        reset()
        q("UPDATE tournament_players SET position=NULL WHERE user_id='2';")
        check('missing finishing position cannot disappear from proof', call().get('mismatches') == 1)
        reset()
        q('UPDATE tournaments SET prize_pool=1001;')
        check('pool drift cannot complete', call().get('reason') == 'final_pool_or_structure_drifted')
        reset()
        q("UPDATE tournaments SET payout_structure='[{\"place\":1,\"percentage\":100}]';")
        check('ladder drift cannot complete', call().get('reason') == 'final_pool_or_structure_drifted')
        reset()
        q('TRUNCATE tournament_entry_close_receipts;')
        check('missing closure receipt is reported', call().get('reason') == 'receipt_missing')
        reset()
        q("UPDATE tournaments SET payout_structure='[]'; UPDATE tournament_entry_close_receipts SET payout_structure_snapshot='[]';")
        q("SELECT public.fn_complete_tournament_entry_reprice('" + event + "');", error='no usable canonical payout ladder')
        check('invalid canonical ladder leaves receipt pending', q('SELECT reprice_completed_at IS NULL FROM tournament_entry_close_receipts;') == 't')
        reset()
        q("UPDATE tournaments SET variant='satellite';")
        check('satellite acceptance contract is preserved', call() == {'ok':False,'reason':'reprice_incomplete','mismatches':2})
        reset()
        q(change.read_text())
        check('migration is repeatable without changing the result', call()['ok'] is True)
        q('GRANT EXECUTE ON FUNCTION fn_complete_tournament_entry_reprice(uuid) TO PUBLIC;')
        q(change.read_text(), error='existing security contract is unexpected')
        q('REVOKE EXECUTE ON FUNCTION fn_complete_tournament_entry_reprice(uuid) FROM PUBLIC;')
        check('unsafe public definer ACL cannot be silently accepted', True)
        q('ALTER FUNCTION fn_complete_tournament_entry_reprice(uuid) RESET search_path;')
        q(change.read_text(), error='existing security contract is unexpected')
        q("ALTER FUNCTION fn_complete_tournament_entry_reprice(uuid) SET search_path TO 'public','pg_temp';")
        check('a missing definer search path is refused', True)

        q(definition(legacy, 'fn_complete_tournament_entry_reprice').replace("'receipt_missing'", "'changed_receipt_missing'"))
        q(change.read_text(), error='source prerequisite changed')
        check('a concurrently changed implementation is not overwritten', True)
        q(definition(legacy, 'fn_complete_tournament_entry_reprice'))
        q('DROP FUNCTION public.fn_complete_tournament_entry_reprice(uuid);')
        q(change.read_text(), error='prerequisite function or receipt table is missing')
        check('missing target never creates a new public definer', q("SELECT to_regprocedure('public.fn_complete_tournament_entry_reprice(uuid)') IS NULL;") == 't')
        q(definition(legacy, 'fn_complete_tournament_entry_reprice'))
        q('REVOKE ALL ON FUNCTION fn_complete_tournament_entry_reprice(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_complete_tournament_entry_reprice(uuid) TO service_role;')
        q('ALTER FUNCTION public.fn_ca_tournament_place_amounts(uuid) RENAME TO absent_amounts;')
        q(change.read_text(), error='prerequisite function or receipt table is missing')
        q('ALTER FUNCTION public.absent_amounts(uuid) RENAME TO fn_ca_tournament_place_amounts;')
        check('missing canonical amount authority refuses before replacement', True)
        q(change.read_text())
        check('service-only ACL survives replacement exactly', q("SELECT has_function_privilege('service_role','fn_complete_tournament_entry_reprice(uuid)','EXECUTE') AND NOT has_function_privilege('anon','fn_complete_tournament_entry_reprice(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_complete_tournament_entry_reprice(uuid)','EXECUTE');") == 't')

        after_hash = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_complete_tournament_entry_reprice(uuid)'::regprocedure;")
    finally:
        if started:
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'], stdout=log, stderr=log, check=True, timeout=15)
        shutil.rmtree(cluster, ignore_errors=True)
(root / 'results.json').write_text(json.dumps({'passed':passed,'baseline_body_md5':baseline_hash,
    'corrected_body_md5':after_hash,'amount_authority_body_md5':amount_hash,
    'production_database_used':False,'scope':'Actual entry-close acceptance and amount functions with synthetic input tables; no wallet or terminal settlement certification.'},indent=2)+'\n')
print(str(len(passed)) + ' groups passed; evidence: ' + str(root / 'results.json'))
