"""Exercise the real prize-window trigger and guarded migration on owned PG17."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
configured = os.environ.get('PG17_BINDIR') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path('/opt/homebrew/opt/postgresql@17/bin')
source = (repo / 'supabase/migrations/20260908042400_tournament_places_settle_and_complete_atomically.sql').read_text()
matches = re.findall(r'CREATE OR REPLACE FUNCTION public\.trg_tournament_pool_finalization_window_guard\(\).*?\$function\$;', source, re.S)
assert len(matches) == 1, 'Expected one exact historical trigger definition'
candidate = (repo / 'supabase/migrations/20260912033500_explicit_zero_closes_tournament_late_registration.sql').read_text()
node = os.environ.get('PGNODE')
helper = repo / 'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/registration-query.mjs'
root = Path(tempfile.mkdtemp(prefix='ca-prize-window-'))
sock = root / 'socket'
sock.mkdir(mode=0o700)
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
           PGUSER='postgres', PGDATABASE='postgres')
passed = []
started = False


def command(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return result.stdout


def query(sql, error=None):
    args = [node, str(helper)] if node else [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
    result = subprocess.run(args, input=(json.dumps(sql) if node else sql) + '\n',
                            capture_output=True, text=True, env=env, timeout=15)
    if error:
        assert result.returncode and error in result.stderr, result.stdout + result.stderr
    else:
        assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def scene(name, settings='', error=None):
    # Only the fixture row changes. The production trigger is called by a real
    # UPDATE, and the complete row must survive a refused transaction unchanged.
    query('TRUNCATE public.tournaments; INSERT INTO public.tournaments(id) VALUES (1);' + settings)
    before = query('SELECT to_jsonb(t) FROM public.tournaments t;')
    query('UPDATE public.tournaments SET prize_pool_finalized=true WHERE id=1;', error)
    if error:
        assert query('SELECT to_jsonb(t) FROM public.tournaments t;') == before
    else:
        assert query('SELECT prize_pool_finalized FROM public.tournaments WHERE id=1;') == 't'
    passed.append(name)


try:
    assert '17.' in command([pg / 'postgres', '--version'])
    command([pg / 'initdb', '-D', root / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    command([pg / 'pg_ctl', '-D', root / 'data', '-l', root / 'postgres.log', '-w',
             '-o', f"-h '' -k '{sock}' -p {port} -c shared_buffers=16MB", 'start'])
    started = True
    assert query("SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')='';") == 't'
    query('''CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.tournaments(
 id integer PRIMARY KEY,status text DEFAULT 'RUNNING',prize_pool_finalized boolean DEFAULT false,
 late_reg_levels integer DEFAULT 0,rebuy_levels integer DEFAULT 4,current_level integer DEFAULT 0,
 late_reg_mins integer DEFAULT 0,started_at timestamptz DEFAULT now(),
 is_rebuy boolean DEFAULT false,is_reentry boolean DEFAULT false,
 add_on_available boolean DEFAULT false,addon_period_started_at timestamptz,
 addon_period_ends_at timestamptz);
''' + matches[0] + '''
REVOKE ALL ON FUNCTION public.trg_tournament_pool_finalization_window_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_tournament_pool_finalization_window_guard() TO service_role;
CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized
 ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_pool_finalization_window_guard();''')
    scene('reproduced_unused_rebuy_default_block', error='late registration level 4')
    query(candidate)
    before_replay = query("SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.trg_tournament_pool_finalization_window_guard()'::regprocedure;")
    query(candidate)
    assert query("SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.trg_tournament_pool_finalization_window_guard()'::regprocedure;") == before_replay
    passed.append('migration_exact_replay')
    scene('explicit_zero_no_rebuy_closes')
    scene('null_uses_legacy_rebuy_cap', 'UPDATE tournaments SET late_reg_levels=NULL;', 'late registration level 4')
    scene('explicit_open_level_remains_blocked', 'UPDATE tournaments SET late_reg_levels=4;', 'late registration level 4')
    scene('completed_level_can_finalize', 'UPDATE tournaments SET late_reg_levels=4,current_level=4;')
    scene('timed_window_remains_blocked', 'UPDATE tournaments SET late_reg_mins=30;', 'timed late registration is open')
    scene('expired_timed_window_can_finalize', "UPDATE tournaments SET late_reg_mins=30,started_at=now()-interval '1 hour';")
    scene('missing_timed_start_remains_blocked', 'UPDATE tournaments SET late_reg_mins=30,started_at=NULL;', 'timed late registration is open')
    scene('enabled_rebuy_still_blocks', 'UPDATE tournaments SET is_rebuy=true;', 'rebuy level 4')
    scene('enabled_reentry_still_blocks', 'UPDATE tournaments SET is_reentry=true;', 'rebuy level 4')
    scene('uncapped_rebuy_still_blocks', 'UPDATE tournaments SET is_rebuy=true,rebuy_levels=0;', 'uncapped rebuy or re-entry')
    scene('registration_promise_still_blocks', "UPDATE tournaments SET status='REGISTERING',late_reg_levels=2;", 'post-start entry windows')
    scene('announced_timed_promise_still_blocks', "UPDATE tournaments SET status='ANNOUNCED',late_reg_mins=30;", 'post-start entry windows')
    scene('future_addon_still_blocks', "UPDATE tournaments SET add_on_available=true,addon_period_started_at=now()+interval '1 hour',addon_period_ends_at=now()+interval '2 hours';", 'promised add-on window')
    scene('unbounded_addon_still_blocks', 'UPDATE tournaments SET add_on_available=true;', 'durably bounded')
    scene('closed_addon_can_finalize', "UPDATE tournaments SET add_on_available=true,addon_period_started_at=now()-interval '2 hours',addon_period_ends_at=now()-interval '1 hour';")
    query('UPDATE public.tournaments SET prize_pool_finalized=false WHERE id=1;', 'cannot be reopened')
    passed.append('finalized_pool_cannot_reopen')
    query("ALTER FUNCTION public.trg_tournament_pool_finalization_window_guard() SET search_path=public,pg_temp;")
    query(candidate, 'authority or trigger differs')
    passed.append('metadata_drift_refused_before_replay')
    print(json.dumps({'passed': len(passed), 'cases': passed, 'scope': 'real trigger and guarded migration; no full tournament or production claim'}))
finally:
    if started or (root / 'data/postmaster.pid').exists():
        command([pg / 'pg_ctl', '-D', root / 'data', '-m', 'fast', '-w', 'stop'])
    state = subprocess.run([str(pg / 'pg_ctl'), '-D', str(root / 'data'), 'status'], capture_output=True)
    assert state.returncode == 3 and not (root / 'data/postmaster.pid').exists()
    assert not (sock / ('.s.PGSQL.' + port)).exists()
    assert root.name.startswith('ca-prize-window-')
    shutil.rmtree(root)
    print(json.dumps({'cleanup': 'owned cluster stopped; pid and socket absent; only owned directory removed'}))
