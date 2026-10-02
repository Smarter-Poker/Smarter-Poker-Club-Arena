#!/usr/bin/env python3
"""A raked hand must not hold its club's wallet row for the rest of its transaction.

Measured on production 2026-10-02 18:00-19:45 UTC: 1,518 statement timeouts on
one statement, the per-hand accumulator UPDATE of public.club_wallets inside
atomic_distribute_rake, which every raked hand of a club and every tournament
finish of that club take and hold to COMMIT. At 19:37 the pile-up starved the
PostgREST pool and the engine voided 180 hands on 116 tables as
lease_proof_expired.

This harness runs the REAL function on a disposable PostgreSQL cluster:

  * the pre-image is the exact CREATE OR REPLACE text of
    20260929040413_a_lifetime_total_is_not_a_lock_on_the_club_row.sql, whose
    body is the one production runs today (md5 of pg_get_functiondef pinned);
  * the post-image is produced by executing the shipped migration's own
    asserted-substitution block over it - not a copy of the new text - so a
    pass proves the migration as written, md5 pins included;
  * the tables and helper functions it touches are stubs with the columns and
    unique keys the body relies on.

Both directions are pinned:

  BEFORE  a hand at table 2 of a club waits for an open hand at table 1, and a
          finish's club_wallets lock waits for it too.
  AFTER   neither waits, and every figure is still written exactly once:
          the per-table total, the receipt, the burn or the union rake leg.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/club-rake-total-lock')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


pg = find_pg_bin()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='club-rake-total-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55703'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'a raked hand does not hold its club wallet row', 'cases': [], 'passed': False}

MIGRATIONS = ROOT / 'supabase/migrations'
SIG = ('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,'
       'integer,jsonb,uuid,jsonb,text)')


def one(pattern):
    found = sorted(MIGRATIONS.glob(pattern))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {pattern}, found {len(found)}')
    return found[0].read_text()


PRE_SOURCE = one('*_a_lifetime_total_is_not_a_lock_on_the_club_row.sql')
PRE_FUNCTION = PRE_SOURCE[PRE_SOURCE.index('CREATE OR REPLACE FUNCTION public.atomic_distribute_rake'):
                          PRE_SOURCE.index('$function$;') + len('$function$;')]
PRE_GRANTS = '\n'.join(l for l in PRE_SOURCE.split('\n')
                       if re.match(r'(REVOKE|GRANT) .*atomic_distribute_rake', l))
SHIPPED = one('*_a_club_rake_total_is_not_a_lock_on_the_club_wallet.sql')


def shipped_for_rake_only(sql):
    """The shipped migration minus everything about fn_club_money_panel, whose
    auth-heavy body this harness does not model. The rake block runs verbatim."""
    body = sql[sql.index('BEGIN;'):]
    blocks = body.split('\nDO $subs$')
    require(len(blocks) == 3, 'the shipped migration should carry exactly two substitutions')
    rake_block = 'DO $subs$' + blocks[1]
    require("'0ef820b10c57d902b5ab2d5f9e2be8a6'" in rake_block, 'first substitution is not the rake')
    head = blocks[0]
    post = body[body.index('DO $post$'):]
    post = re.sub(r"  IF NOT \(SELECT p\.prosrc LIKE '%public\.club_table_rake_totals%'.*?END IF;\n",
                  '', post, flags=re.S)
    require('PANEL_DOES_NOT_READ' not in post, 'could not isolate the panel post-check')
    return head + '\n' + rake_block.split('END $subs$;')[0] + 'END $subs$;\n\n' + post


FIXTURE = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE TABLE public.clubs (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tables (id uuid PRIMARY KEY, is_private boolean, union_id uuid);
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, is_private boolean, union_id uuid);
CREATE TABLE public.hand_history (id uuid PRIMARY KEY, table_id uuid, hand_number int,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.rake_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hand_id uuid,
  table_id uuid, club_id uuid, rake_amount numeric, bbj_contribution numeric, pot_size numeric,
  num_players int, player_contributions jsonb, is_tournament boolean, tournament_id uuid,
  source text, metadata jsonb, rake_method text, returned_uncalled jsonb,
  created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX ON public.rake_records (hand_id) WHERE hand_id IS NOT NULL;
CREATE TABLE public.rake_attributions (hand_id uuid, player_id uuid, rake_amount numeric,
  rake_record_id uuid, table_id uuid, club_id uuid, gross_contribution numeric,
  returned_uncalled numeric, eligible_contribution numeric, contribution_weight numeric,
  weighted_rake_credit numeric, bbj_attributed_contribution numeric, rake_method text,
  UNIQUE (hand_id, player_id));
CREATE TABLE public.financial_alerts (severity text, source text, message text, context jsonb);
CREATE TABLE public.rake_distribution_legs (leg_key uuid, leg text, club_id uuid, union_id uuid,
  amount numeric, PRIMARY KEY (leg_key, leg));
CREATE TABLE public.club_wallets (club_id uuid UNIQUE NOT NULL, chip_balance numeric NOT NULL DEFAULT 0,
  period_rake_collected numeric NOT NULL DEFAULT 0, period_bbj_contribution numeric NOT NULL DEFAULT 0,
  lifetime_rake_collected numeric NOT NULL DEFAULT 0, lifetime_bbj_contribution numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.club_wallet_transactions (club_id uuid, type text, amount numeric,
  balance_after numeric, related_id uuid, reason text);
CREATE TABLE public.union_wallets (union_id uuid UNIQUE, chip_balance numeric, rake_wallet numeric,
  total_rake_collected numeric, updated_at timestamptz);
CREATE TABLE public.union_wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(), union_id uuid, club_id uuid, amount numeric, tx_type text,
  wallet text, direction text, balance_after numeric, notes text);
CREATE TABLE public.accounting_cash_bank_receipts (rake_record_id uuid, union_id uuid, club_id uuid,
  union_transaction_id uuid, club_ledger_id uuid, banked_at timestamptz, amount numeric);
CREATE TABLE public.chip_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(), performed_by uuid, from_type text, from_entity_id uuid,
  to_type text, to_entity_id uuid, amount numeric, category text, club_id uuid, table_id uuid,
  hand_id uuid, tournament_id uuid, description text);
CREATE FUNCTION public.fn_lock_cash_bank_accounting_week(uuid, uuid, timestamptz)
  RETURNS void LANGUAGE sql AS 'SELECT';
CREATE FUNCTION public.fn_allocate_rake_credits(p_rake numeric, p_contributions jsonb, p_method text)
  RETURNS TABLE(user_id uuid, weight numeric, credit numeric) LANGUAGE sql AS $$
  SELECT k::uuid, 1::numeric, round(p_rake / count(*) OVER (), 2)
    FROM jsonb_object_keys(COALESCE(p_contributions, '{}'::jsonb)) k $$;
CREATE FUNCTION public.fn_cash_earning_club(uuid, uuid, uuid, p_club uuid, uuid)
  RETURNS uuid LANGUAGE sql AS 'SELECT p_club';

-- Standalone club S (two tables), union club U (one table) in union N.
INSERT INTO public.clubs VALUES ('00000000-0000-0000-0000-00000000000a', 'S'),
                                ('00000000-0000-0000-0000-00000000000b', 'U'),
                                ('00000000-0000-0000-0000-00000000000c', 'New');
INSERT INTO public.tables VALUES ('00000000-0000-0000-0000-0000000000a1', false, NULL),
                                 ('00000000-0000-0000-0000-0000000000a2', false, NULL),
                                 ('00000000-0000-0000-0000-0000000000b1', false,
                                  '00000000-0000-0000-0000-0000000000ff'),
                                 ('00000000-0000-0000-0000-0000000000c1', false, NULL);
INSERT INTO public.club_wallets (club_id, chip_balance, period_rake_collected, lifetime_rake_collected)
  VALUES ('00000000-0000-0000-0000-00000000000a', 500, 1000, 1000),
         ('00000000-0000-0000-0000-00000000000b', 70, 300, 300);
INSERT INTO public.union_wallets VALUES ('00000000-0000-0000-0000-0000000000ff', 0, 10, 10, now());
"""

S = '00000000-0000-0000-0000-00000000000a'
U = '00000000-0000-0000-0000-00000000000b'
NEW = '00000000-0000-0000-0000-00000000000c'
S1 = '00000000-0000-0000-0000-0000000000a1'
S2 = '00000000-0000-0000-0000-0000000000a2'
U1 = '00000000-0000-0000-0000-0000000000b1'
N1 = '00000000-0000-0000-0000-0000000000c1'


def rake_call(club, table, hand, number, rake='2.50', bbj='0.50'):
    return (f"SELECT applied FROM public.atomic_distribute_rake('{table}','{club}','{hand}',{number},"
            f"{rake},{bbj},20,2,'{{\"00000000-0000-0000-0000-000000000001\":10,"
            f"\"00000000-0000-0000-0000-000000000002\":10}}'::jsonb,NULL,NULL,'DEALT_EQUAL');")


def command(argv, sql=None, timeout=60):
    return subprocess.run([str(x) for x in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed})
    require(passed, name + ': ' + r.stdout[-400:] + r.stderr[-1200:])
    return r.stdout.rstrip('\n')


def open_hand_blocks(tag, hand, number):
    """Leave one raked hand at table S1 open, as the post-commit transaction is
    while it runs the rest of its obligations. Then ask, with a short
    lock_timeout, whether (1) a hand at the club's OTHER table and (2) a finish
    taking the club wallet FOR NO KEY UPDATE have to wait for it."""
    holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, env=env)
    try:
        holder.stdin.write('BEGIN; ' + rake_call(S, S1, hand, number) +
                           ' SELECT pg_advisory_lock(10022026);\n')
        holder.stdin.flush()
        deadline = time.monotonic() + 15
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'"
                           " AND objid=10022026 AND granted);").stdout.strip() != 't':
            require(holder.poll() is None and time.monotonic() < deadline,
                    tag + ': the open hand never reached its barrier')
            time.sleep(.02)
        other = command(cmd, "SET lock_timeout='1200ms';\nBEGIN;\n" +
                        rake_call(S, S2, '00000000-0000-0000-0000-0000000%05d' % (number + 1),
                                  number + 1) + "\nROLLBACK;\n")
        (out / (tag + '-other-table.log')).write_text(other.stdout + other.stderr)
        finish = command(cmd, "SET lock_timeout='1200ms';\nBEGIN;\n"
                         f"SELECT 1 FROM public.club_wallets WHERE club_id='{S}' FOR NO KEY UPDATE;\n"
                         "ROLLBACK;\n")
        (out / (tag + '-finish.log')).write_text(finish.stdout + finish.stderr)
        blocked = lambda r: r.returncode != 0 and '55P03' in r.stderr  # noqa: E731
        for r, what in ((other, 'other table'), (finish, 'finish')):
            require(r.returncode == 0 or blocked(r), f'{tag} {what} failed for another reason: '
                    + r.stderr[-800:])
        return blocked(other), blocked(finish)
    finally:
        if holder.poll() is None:
            holder.stdin.write('ROLLBACK;\n')
            holder.stdin.close()
            holder.wait(timeout=10)


try:
    version = command([pg / 'postgres', '--version']).stdout
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16+ required: ' + version)
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) +
                "'\nunix_socket_permissions=0700\nport=" + PORT +
                "\nshared_buffers='16MB'\nmax_connections=20\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', FIXTURE)
    run('pre-image', PRE_FUNCTION + '\n' + PRE_GRANTS)
    run('pre-image-is-production', f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));",
        '0ef820b10c57d902b5ab2d5f9e2be8a6')

    # BEFORE: the open hand holds the club wallet; the club's other table and a
    # finish both wait for it.
    before_other, before_finish = open_hand_blocks('before', '00000000-0000-0000-0000-000000010000', 10000)
    results['cases'].append({'name': 'before-an-open-hand-blocks-the-clubs-other-table-and-its-finishes',
                             'other_table_blocked': before_other, 'finish_blocked': before_finish,
                             'passed': before_other and before_finish})
    require(before_other and before_finish,
            'BEFORE arm did not reproduce the convoy; the test cannot prove a fix it cannot first break')

    # The shipped migration, run as written (md5 pins and post-checks included).
    run('shipped-migration', shipped_for_rake_only(SHIPPED))
    run('post-image-is-the-pinned-one', f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));",
        '3cb33db39fdcf0359949f941a178158e')

    after_other, after_finish = open_hand_blocks('after', '00000000-0000-0000-0000-000000020000', 20000)
    results['cases'].append({'name': 'after-an-open-hand-blocks-neither',
                             'other_table_blocked': after_other, 'finish_blocked': after_finish,
                             'passed': not after_other and not after_finish})
    require(not after_other and not after_finish,
            f'AFTER arm still blocks: other table {after_other}, finish {after_finish}')

    # Every figure is still written, once.
    h1 = '00000000-0000-0000-0000-000000030001'
    run('a-standalone-hand-is-totalled-on-its-table', rake_call(S, S1, h1, 30001) +
        f" SELECT rake_collected||'/'||bbj_contribution||'/'||hands FROM public.club_table_rake_totals"
        f" WHERE club_id='{S}' AND table_id='{S1}';", 't\n2.50/0.50/1')
    run('the-same-hand-again-counts-nothing', rake_call(S, S1, h1, 30001) +
        f" SELECT rake_collected||'/'||hands FROM public.club_table_rake_totals"
        f" WHERE club_id='{S}' AND table_id='{S1}';", 'f\n2.50/1')
    run('the-wallet-is-not-written', f"SELECT period_rake_collected||'/'||lifetime_rake_collected||'/'"
        f"||chip_balance FROM public.club_wallets WHERE club_id='{S}';", '1000/1000/500')
    run('the-receipt-shows-the-wallet-as-it-stands',
        f"SELECT count(*)||'/'||max(balance_after)||'/'||max(amount) FROM public.club_wallet_transactions"
        f" WHERE club_id='{S}' AND related_id='{h1}';", '1/500/2.00')
    run('the-standalone-rake-is-still-retired-once',
        f"SELECT count(*)||'/'||sum(amount) FROM public.chip_ledger WHERE hand_id='{h1}' AND category='burn';",
        '1/2.50')
    run('the-club-figure-is-wallet-plus-tables',
        f"SELECT round(w.period_rake_collected + COALESCE((SELECT sum(t.rake_collected)"
        f" FROM public.club_table_rake_totals t WHERE t.club_id=w.club_id),0),2)"
        f" FROM public.club_wallets w WHERE w.club_id='{S}';", '1002.50')

    h2 = '00000000-0000-0000-0000-000000040001'
    run('a-union-hand-still-pays-the-union-rake-treasury', rake_call(U, U1, h2, 40001) +
        " SELECT rake_wallet||'/'||total_rake_collected FROM public.union_wallets;", 't\n12.50/12.50')
    run('and-is-totalled-on-its-table',
        f"SELECT rake_collected||'/'||hands FROM public.club_table_rake_totals WHERE table_id='{U1}';",
        '2.50/1')

    h3 = '00000000-0000-0000-0000-000000050001'
    run('a-club-without-a-wallet-gets-one-at-zero', rake_call(NEW, N1, h3, 50001) +
        f" SELECT chip_balance||'/'||period_rake_collected FROM public.club_wallets WHERE club_id='{NEW}';"
        f" SELECT balance_after FROM public.club_wallet_transactions WHERE related_id='{h3}';",
        't\n0/0\n0')

    executable = '\n'.join(l for l in SHIPPED.split('\n') if not l.lstrip().startswith('--'))
    no_update = not re.search(r"E'\s*UPDATE public\.club_wallets", executable.split('v_new :=')[1].split(';')[0])
    results['cases'].append({'name': 'the-new-text-has-no-wallet-update', 'passed': no_update})
    require(no_update, 'the substituted text still updates club_wallets')

    results['passed'] = all(c.get('passed', True) for c in results['cases'])
finally:
    if (cluster / 'data/postmaster.pid').exists():
        command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    shutil.rmtree(cluster, ignore_errors=True)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']),
                      'evidence': str(out)}))
