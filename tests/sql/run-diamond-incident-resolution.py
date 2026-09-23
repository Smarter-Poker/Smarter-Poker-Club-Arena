#!/usr/bin/env python3
"""A Diamond incident cannot outlive its cause: isolated PostgreSQL 17 proof.

Never connects to production. The fixture carries the EXACT production text of
fn_ca_diamond_health_watch, fn_ca_diamond_trial_balance_watch and
fn_ca_diamond_incident (captured read-only 2026-09-19) over a stubbed
fn_ca_diamond_health() and fn_ca_diamond_trial_balance() that read fixture
tables, so the migration's md5 pins pass here exactly as they must in
production. The sequence is the production one in miniature:

  1. stale DR0 / DR11 / DR12 rows whose causes have cleared, plus rows under
     other rules; the ORIGINAL watches tick and resolve nothing (the defect);
  2. the migration applies, its own final tick resolves the stale rows with a
     note read from their detail, and it asserts no critical row is left;
  3. the redefined watches: a critical area files a DR0, the row stays open
     while any named area is still critical or unknown, resolves once every
     named area has cleared, a report with no rows clears nothing, a row that
     names no area is left for a person, a DR11 break resolves only for the
     account that reads 0, DR12 resolves when suspense reads 0, and no row
     under any other rule is resolved or deleted by either watch.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / 'tests/sql'
PG = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SOCKET = '/tmp/codex-diamond-phase2-pg'
PORT = '55472'
DB = 'poker_diamond_incident_resolution_test'
MIGRATION = ROOT / 'supabase/migrations/20260919223032_the_health_watch_resolves_what_it_filed.sql'
BASE = [str(PG / 'psql'), '-X', '-q', '-h', SOCKET, '-p', PORT, '-v', 'ON_ERROR_STOP=1', '-At']

passed = 0


def check(condition, label):
    global passed
    assert condition, label
    passed += 1
    print('PASS:', label, flush=True)


def psql(args, sql=None, db=DB, ok=True):
    r = subprocess.run(BASE + ['-d', db] + args, input=sql, text=True, capture_output=True, timeout=120)
    if ok and r.returncode:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise RuntimeError('isolated incident resolution SQL failed')
    return r


def sql(q, ok=True):
    r = psql(['-c', q], ok=ok)
    return r.stdout.strip() if ok else r


def script(text):
    """Run a multi-statement script through a file and return (stdout, stderr)."""
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.sql', dir=SQL_DIR) as f:
        f.write(text)
        f.flush()
        r = psql(['-P', 'pager=off', '-f', f.name])
    for line in r.stderr.splitlines():
        if 'PASS:' in line:
            print(line.split('PASS:', 1)[1].strip())
    return r.stdout.strip(), r.stderr


def ready():
    return subprocess.run([str(PG / 'pg_isready'), '-h', SOCKET, '-p', PORT], capture_output=True).returncode == 0


started_here = None
if not ready():
    # No isolated cluster is up: start a private one on the estate's socket and port and
    # stop it on the way out. Nothing here ever points at a network address.
    data = pathlib.Path(SOCKET) / 'data-incident-resolution'
    if not (data / 'PG_VERSION').exists():
        data.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(PG / 'initdb'), '-D', str(data), '--auth=trust', '-E', 'UTF8'],
                       check=True, capture_output=True, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    subprocess.run([str(PG / 'pg_ctl'), '-D', str(data), '-l', str(data.parent / 'server-incident-resolution.log'),
                    '-o', f"-p {PORT} -k {SOCKET} -c listen_addresses='' -c fsync=off", '-w', '-t', '30', 'start'],
                   check=True, capture_output=True, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    started_here = data
    check(ready(), 'private isolated cluster started on the estate socket')

try:
    exists = psql(['-c', f"SELECT 1 FROM pg_database WHERE datname='{DB}'"], db='postgres').stdout.strip()
    if not exists:
        psql(['-c', f'CREATE DATABASE {DB}'], db='postgres')
    script((SQL_DIR / 'diamond-incident-resolution-fixture.sql').read_text())

    AREAS = ['rule arming', 'horse claim button', 'rewards lost to expiry', 'horse claims', 'rules overdue',
             'money identity', 'deploy gate', 'trial balance', 'per-user caps', 'VIP caps', 'horses are players',
             'budget plans', 'unreachable money', 'evaluation coverage']

    def set_health(bad=None):
        """Every production area reads ok except the ones given as {area: status}."""
        bad = bad or {}
        rows = ','.join(
            f"({i},'{a}','{bad.get(a, 'ok')}','fixture reading')" for i, a in enumerate(AREAS))
        sql(f'TRUNCATE fixture_health; INSERT INTO fixture_health VALUES {rows}')

    def clear_health():
        sql('TRUNCATE fixture_health')

    ACCOUNTS = ['player_diamonds', 'fixture_accounts', 'diamond_house', 'arena_wallets', 'register',
                'diamond_debts', 'promo_budgets_spent', 'mirror_mismatch', 'dead_stores', 'suspense', 'total']

    def set_trial_balance(differences=None, suspense=0):
        """Every reconciling account reads difference 0 except those given; suspense as given."""
        differences = differences or {}
        rows = []
        for i, a in enumerate(ACCOUNTS):
            if a == 'suspense':
                diff, bal = 'NULL', str(suspense) if suspense is not None else 'NULL'
            elif a in ('arena_wallets', 'diamond_debts', 'promo_budgets_spent', 'mirror_mismatch', 'dead_stores'):
                diff, bal = 'NULL', '0'
            else:
                d = differences.get(a, 0)
                diff, bal = ('NULL' if d is None else str(d)), '100'
            rows.append(f"({i},'{a}',{bal},0,0,0,{diff},'fixture reading')")
        sql('TRUNCATE fixture_trial_balance; INSERT INTO fixture_trial_balance VALUES ' + ','.join(rows))

    def open_rows(rule=None):
        where = f" AND rule='{rule}'" if rule else ''
        return int(sql(f"SELECT count(*) FROM ca_diamond_incidents WHERE resolved_at IS NULL{where}"))

    def resolution(row_id):
        return sql(f"SELECT COALESCE(resolution,'') FROM ca_diamond_incidents WHERE id={row_id}")

    def dr0(areas, days_ago, status='critical'):
        detail = json.dumps({'areas': len(areas), 'detail': [
            {'area': a, 'status': status, 'detail': f'{a} was {status}'} for a in areas]})
        return int(sql(
            "INSERT INTO ca_diamond_incidents(occurred_at,rule,severity,writer,detail) VALUES "
            f"(now()-interval '{days_ago} days','DR0:health_critical','critical','fn_ca_diamond_health_watch',"
            f"'{detail}'::jsonb) RETURNING id"))

    def dr11(account, difference, days_ago):
        detail = json.dumps({'account': account, 'difference': difference, 'balance_now': 100})
        return int(sql(
            "INSERT INTO ca_diamond_incidents(occurred_at,rule,severity,writer,amount,detail) VALUES "
            f"(now()-interval '{days_ago} days','DR11:trial_balance_break','warning','{account}',{difference},"
            f"'{detail}'::jsonb) RETURNING id"))

    def other(rule, severity, days_ago):
        return int(sql(
            "INSERT INTO ca_diamond_incidents(occurred_at,rule,severity,writer,detail) VALUES "
            f"(now()-interval '{days_ago} days','{rule}','{severity}','fixture','{{}}'::jsonb) RETURNING id"))

    # ---- 1. The production shape in miniature, with every cause already cleared. ----
    set_health()
    set_trial_balance()
    stale_dr0 = [dr0(['rewards lost to expiry'], 10), dr0(['rewards lost to expiry'], 10),
                 dr0(['money identity', 'trial balance'], 8), dr0(['deploy gate'], 8)]
    stale_dr11 = [dr11('register', 100, 8), dr11('player_diamonds', -100, 8)]
    stale_dr12 = int(sql(
        "INSERT INTO ca_diamond_incidents(occurred_at,rule,severity,writer,amount,detail) VALUES "
        "(now()-interval '2 days','DR12:suspense_nonzero','info','fn_ca_diamond_trial_balance_watch',5,"
        "'{\"suspense\":5}'::jsonb) RETURNING id"))
    others = [other('CH3:horse_claim_failed', 'warning', 9), other('DR7:user_over_daily_cap', 'warning', 1),
              other('DR13:concentration_or_velocity', 'warning', 2), other('DR5:deleted_with_balance', 'info', 3)]
    swept = other('DR11:trial_balance_summary', 'info', 8)   # the live seven-day sweep takes this one
    old_info = other('DR5:journal_row_deleted_under_maintenance', 'info', 40)
    sql(f"UPDATE ca_diamond_incidents SET resolved_at=now()-interval '35 days' WHERE id={old_info}")  # the live thirty-day removal takes this one
    check(open_rows('DR0:health_critical') == 4 and open_rows('DR11:trial_balance_break') == 2
          and open_rows('DR12:suspense_nonzero') == 1, 'stale DR0, DR11 and DR12 rows are open with their causes cleared')

    # The negative control: the original watches tick over clean readings and resolve nothing.
    check(sql('SELECT fn_ca_diamond_health_watch()') == '0', 'original health watch reads 0 bad areas')
    check(sql('SELECT fn_ca_diamond_trial_balance_watch()') == '0', 'original trial balance watch files 0 breaks')
    check(open_rows('DR0:health_critical') == 4 and open_rows('DR11:trial_balance_break') == 2
          and open_rows('DR12:suspense_nonzero') == 1,
          'negative control: the original watches leave every stale row open although its cause has cleared')
    check(sql("SELECT count(*) FROM information_schema.columns WHERE table_name='ca_diamond_incidents' AND column_name='resolution'") == '0',
          'negative control: there is no resolution note before the migration')

    # ---- 2. The migration, whose final tick resolves what the deployed code can now resolve. ----
    out, err = script(MIGRATION.read_text())
    check('before the tick: 4 open critical' in err, 'migration reports the open critical count before its tick')
    check('after the tick: 0 open critical' in err, 'migration reports 0 open critical after its tick')
    check(open_rows('DR0:health_critical') == 0, 'the tick resolved every stale DR0 row')
    check(open_rows('DR11:trial_balance_break') == 0, 'the tick resolved both stale DR11 rows')
    check(open_rows('DR12:suspense_nonzero') == 0, 'the tick resolved the stale DR12 row')
    check(resolution(stale_dr0[0]).startswith('auto: area rewards lost to expiry read ok at '),
          'a DR0 resolution note names the area and the status it read')
    note = resolution(stale_dr0[2])
    check('area money identity read ok' in note and 'area trial balance read ok' in note,
          'a two-area DR0 note names both areas')
    check(resolution(stale_dr11[0]).startswith('auto: account register read difference 0 at ')
          and resolution(stale_dr11[1]).startswith('auto: account player_diamonds read difference 0 at '),
          'a DR11 resolution note names the account')
    check(resolution(stale_dr12).startswith('auto: suspense read 0 at '), 'a DR12 resolution note says suspense read 0')
    for row_id in others[:3]:
        check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={row_id}') == 't',
              f'warning row {row_id} under another rule is untouched by the migration tick')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={others[3]}') == 't',
          'a three-day-old info row under another rule is untouched')
    check(sql(f'SELECT resolved_at IS NOT NULL AND resolution IS NULL FROM ca_diamond_incidents WHERE id={swept}') == 't',
          'the live seven-day info sweep still runs and still writes no note')
    check(sql(f'SELECT count(*) FROM ca_diamond_incidents WHERE id={old_info}') == '0',
          'the live thirty-day removal of resolved info rows is unchanged')
    check(sql("SELECT count(*) FROM ca_diamond_incidents WHERE resolved_at IS NULL AND rule='DR11:trial_balance_summary'") == '2',
          'the migration tick filed its summary row as the live watch does (one from the negative control, one from the tick)')
    check(sql("SELECT has_function_privilege('anon','public.fn_ca_diamond_health_watch()','EXECUTE') OR "
              "has_function_privilege('authenticated','public.fn_ca_diamond_health_watch()','EXECUTE') OR "
              "has_function_privilege('anon','public.fn_ca_diamond_trial_balance_watch()','EXECUTE') OR "
              "has_function_privilege('authenticated','public.fn_ca_diamond_trial_balance_watch()','EXECUTE')") == 'f',
          'neither watch is executable by anon or authenticated')
    check(sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' "
              "AND p.proname='fn_ca_diamond_trial_balance_watch' AND p.prosecdef "
              "AND 'search_path=public, pg_temp' = ANY(p.proconfig)") == '1',
          'the trial balance watch stays SECURITY DEFINER with search_path pinned to public, pg_temp')

    # Re-applying refuses: the pins no longer match.
    r = psql(['-f', str(MIGRATION)], ok=False)
    check(r.returncode != 0 and 'fn_ca_diamond_health_watch changed' in r.stderr,
          'the migration refuses to apply a second time (md5 pins)')

    # ---- 3. The redefined watches. ----
    total_before = int(sql('SELECT count(*) FROM ca_diamond_incidents'))
    set_health({'money identity': 'critical'})
    check(sql('SELECT fn_ca_diamond_health_watch()') == '1', 'a critical area is counted')
    fresh = int(sql("SELECT max(id) FROM ca_diamond_incidents WHERE rule='DR0:health_critical'"))
    check(open_rows('DR0:health_critical') == 1
          and sql(f"SELECT detail->'detail'->0->>'area' FROM ca_diamond_incidents WHERE id={fresh}") == 'money identity',
          'a critical area files a DR0 naming it')
    sql('SELECT fn_ca_diamond_health_watch()')
    check(open_rows('DR0:health_critical') == 2, 'a cause that persists keeps filing and nothing resolves')
    set_health()
    check(sql('SELECT fn_ca_diamond_health_watch()') == '0', 'the area reads ok again')
    check(open_rows('DR0:health_critical') == 0 and resolution(fresh).startswith('auto: area money identity read ok at '),
          'the watch resolves its own filings once the area reads ok, with a note')

    set_health({'money identity': 'critical', 'deploy gate': 'critical'})
    check(sql('SELECT fn_ca_diamond_health_watch()') == '2', 'two critical areas are counted')
    two = int(sql("SELECT max(id) FROM ca_diamond_incidents WHERE rule='DR0:health_critical'"))
    set_health({'deploy gate': 'critical'})
    sql('SELECT fn_ca_diamond_health_watch()')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={two}') == 't',
          'a row whose second area is still critical stays open')
    set_health({'deploy gate': 'unknown'})
    sql('SELECT fn_ca_diamond_health_watch()')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={two}') == 't',
          'an area that reads unknown is not an area that cleared')
    set_health({'deploy gate': 'attention'})
    sql('SELECT fn_ca_diamond_health_watch()')
    note = resolution(two)
    check(sql(f'SELECT resolved_at IS NOT NULL FROM ca_diamond_incidents WHERE id={two}') == 't'
          and 'area money identity read ok' in note and 'area deploy gate read attention' in note,
          'once every named area is neither critical nor unknown the row resolves and the note reads each status')
    sql("UPDATE ca_diamond_incidents SET resolved_at=now(), resolution='fixture: closing the follow-up filings' "
        "WHERE rule='DR0:health_critical' AND resolved_at IS NULL")

    set_health({'trial balance': 'critical'})
    sql('SELECT fn_ca_diamond_health_watch()')
    pending = int(sql("SELECT max(id) FROM ca_diamond_incidents WHERE rule='DR0:health_critical'"))
    clear_health()
    check(sql('SELECT fn_ca_diamond_health_watch()') == '0'
          and sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={pending}') == 't',
          'a report that came back with no rows clears nothing')
    set_health()
    sql('SELECT fn_ca_diamond_health_watch()')
    check(sql(f'SELECT resolved_at IS NOT NULL FROM ca_diamond_incidents WHERE id={pending}') == 't',
          'the same row resolves on the next tick that reads the area ok')

    no_area = int(sql("INSERT INTO ca_diamond_incidents(rule,severity,writer,detail) VALUES "
                      "('DR0:health_critical','critical','fixture','{}'::jsonb) RETURNING id"))
    sql('SELECT fn_ca_diamond_health_watch()')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={no_area}') == 't',
          'a DR0 row that names no area is left for a person')
    sql(f"UPDATE ca_diamond_incidents SET resolved_at=now(), resolution='fixture: a person closed it' WHERE id={no_area}")

    set_trial_balance({'register': 100, 'player_diamonds': -50})
    check(sql('SELECT fn_ca_diamond_trial_balance_watch()') == '2', 'two breaks are filed')
    reg = int(sql("SELECT max(id) FROM ca_diamond_incidents WHERE rule='DR11:trial_balance_break' AND detail->>'account'='register'"))
    pla = int(sql("SELECT max(id) FROM ca_diamond_incidents WHERE rule='DR11:trial_balance_break' AND detail->>'account'='player_diamonds'"))
    set_trial_balance({'player_diamonds': -50})
    check(sql('SELECT fn_ca_diamond_trial_balance_watch()') == '1', 'one break persists')
    check(sql(f'SELECT resolved_at IS NOT NULL FROM ca_diamond_incidents WHERE id={reg}') == 't'
          and resolution(reg).startswith('auto: account register read difference 0 at '),
          'the break on the account that reads 0 resolves with a note naming the account')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={pla}') == 't',
          'the break on the account that is still broken stays open')
    set_trial_balance({'player_diamonds': None})
    sql('SELECT fn_ca_diamond_trial_balance_watch()')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={pla}') == 't',
          'an account whose difference could not be read clears nothing')
    set_trial_balance()
    sql('SELECT fn_ca_diamond_trial_balance_watch()')
    check(sql(f'SELECT resolved_at IS NOT NULL FROM ca_diamond_incidents WHERE id={pla}') == 't',
          'the remaining break resolves once its account reads 0')
    sql("UPDATE ca_diamond_incidents SET resolved_at=now(), resolution='fixture: closing the follow-up filings' "
        "WHERE rule='DR11:trial_balance_break' AND resolved_at IS NULL")

    set_trial_balance(suspense=7)
    sql('SELECT fn_ca_diamond_trial_balance_watch()')
    sus = int(sql("SELECT max(id) FROM ca_diamond_incidents WHERE rule='DR12:suspense_nonzero'"))
    sql('SELECT fn_ca_diamond_trial_balance_watch()')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={sus}') == 't',
          'a suspense row stays open while suspense is nonzero')
    set_trial_balance(suspense=None)
    sql('SELECT fn_ca_diamond_trial_balance_watch()')
    check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={sus}') == 't',
          'a suspense reading that is NULL clears nothing')
    set_trial_balance(suspense=0)
    sql('SELECT fn_ca_diamond_trial_balance_watch()')
    check(sql(f'SELECT resolved_at IS NOT NULL FROM ca_diamond_incidents WHERE id={sus}') == 't'
          and resolution(sus).startswith('auto: suspense read 0 at '),
          'the suspense row resolves once suspense reads 0')

    for row_id in others[:3]:
        check(sql(f'SELECT resolved_at IS NULL FROM ca_diamond_incidents WHERE id={row_id}') == 't',
              f'warning row {row_id} under another rule is untouched by every tick')
    check(int(sql('SELECT count(*) FROM ca_diamond_incidents')) >= total_before,
          'no tick deleted a row (only the live thirty-day info removal ever does, and nothing qualified)')
    check(sql("SELECT count(*) FROM ca_diamond_incidents WHERE resolution LIKE 'auto:%' AND rule NOT IN "
              "('DR0:health_critical','DR11:trial_balance_break','DR12:suspense_nonzero')") == '0',
          'an automatic resolution note appears only under DR0, DR11 and DR12')
finally:
    if started_here is not None:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(started_here), '-m', 'fast', '-w', '-t', '30', 'stop'],
                       capture_output=True, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})

print(f'{passed} isolated incident resolution checks passed; this is not a production certification.')
