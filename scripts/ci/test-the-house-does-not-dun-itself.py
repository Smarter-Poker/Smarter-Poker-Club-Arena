"""Isolated PostgreSQL regression: the house does not dun itself.

fn_union_age_invoices and fn_union_enforce_stop_loss treated every
club-owes-union weekly square-up as a collectible receivable, including one
owed by a club whose owner owns the union (an off-ledger debt the owner owes
himself, against which no payment can ever be recorded). On 2026-10-15 07:35
UTC that escalated two statements and suspended Club JAQK and SHARK CLUB from
Midway Union, one week after a one-off waiver (20261002165500) had cleared the
previous ones.

The test rebuilds the exact production definitions from the migrations that
wrote them (20260907183130, then 20261003024413's reminder substitution, and
20260926042119), asserts their pg_get_functiondef md5 equals the one read on
production on 2026-10-15, proves they escalate and suspend a same-owner
club, then applies the candidate migration (20261015093202, a pinned-text
substitution) and proves:
  * a same-owner square-up is never marked overdue, reminded or escalated, and
    never counts toward suspension; a club suspended for one is restored and
    its suspension alert is resolved by the same run;
  * a club with a DIFFERENT owner is still chased, escalated and suspended
    exactly as before (the rule is not a mute);
  * the migration reproduces production's derived postimage md5 exactly and
    keeps owner, SECURITY DEFINER, settings and grants.
An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
MIGRATION = MIGRATIONS / '20261015093202_the_house_does_not_dun_itself_at_the_source.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/the-house-does-not-dun-itself')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='house-dun-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 read on production 2026-10-15, before and after the
# candidate (the postimage derived read-only on production with replace()).
LIVE_AGE_MD5 = '20ed85f3c1b63072fb8f7966658f1423'
LIVE_ENF_MD5 = 'e36819dfda5eafa1a7152ae0fddb7e3d'
POST_AGE_MD5 = '60ad1fb7ca887133bf93fd5aaab80b30'
POST_ENF_MD5 = '64b6418cf751bc785f358f77ebf6dddf'

UNION = 'fade0000-0000-0000-0000-000000000001'
HOUSE_OWNER = '47965354-0e56-43ef-931c-ddaab82af765'
OTHER_OWNER = '11111111-2222-3333-4444-555555555555'
HOUSE_CLUB = 'a0000000-0000-0000-0000-000000000001'
OTHER_CLUB = 'b0000000-0000-0000-0000-000000000002'
HOUSE_INV = 'c0000000-0000-0000-0000-000000000015'
OTHER_INV = 'c0000000-0000-0000-0000-000000000099'


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


SCHEMA = f"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE TABLE unions(id uuid PRIMARY KEY, name text, owner_id uuid);
CREATE TABLE clubs(id uuid PRIMARY KEY, name text, owner_id uuid);
CREATE TABLE settlement_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text,
  club_id uuid, invoice_type text, from_entity_type text, net_amount numeric, adjusts_invoice_id uuid,
  status text, due_at timestamptz, overdue_at timestamptz, reminders_sent integer DEFAULT 0,
  last_reminder_at timestamptz, breakdown jsonb, updated_at timestamptz DEFAULT now());
CREATE TABLE union_club_terms(union_id uuid, club_id uuid, status text, stop_loss_limit numeric,
  security_deposit numeric, suspended_at timestamptz, suspended_reason text, updated_at timestamptz,
  PRIMARY KEY (union_id, club_id));
CREATE TABLE financial_alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text, severity text,
  message text, context jsonb, resolved boolean DEFAULT false, resolved_at timestamptz, resolution text,
  created_at timestamptz DEFAULT now());
CREATE TABLE reminders(invoice_id uuid, body text, meta jsonb);
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION fn_union_setting(uuid, text, numeric) RETURNS numeric LANGUAGE sql AS 'SELECT $3';
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql
  AS $$SELECT date_trunc('week', $1)$$;
CREATE FUNCTION fn_union_club_exposure(uuid, timestamptz)
  RETURNS TABLE(club_id uuid, club_name text, week_start timestamptz, running_net numeric, presettled numeric,
    exposure numeric, security_deposit numeric, stop_loss_limit numeric, headroom numeric, breached boolean,
    terms_on_file boolean, status text)
  LANGUAGE sql AS 'SELECT NULL::uuid, NULL, NULL::timestamptz, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::boolean, NULL::boolean, NULL WHERE false';
CREATE FUNCTION fn_union_remind_statement(p_invoice uuid, p_body text, p_meta jsonb) RETURNS jsonb
  LANGUAGE sql AS 'INSERT INTO reminders VALUES (p_invoice, p_body, p_meta) RETURNING jsonb_build_object(''ok'', true)';
-- Production definition (read 2026-10-15).
CREATE FUNCTION public.fn_union_invoice_outstanding(p_invoice_id uuid)
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT round(si.net_amount - COALESCE((
           SELECT SUM(cn.net_amount) FROM settlement_invoices cn
            WHERE cn.adjusts_invoice_id = si.id
              AND cn.invoice_type = 'union_weekly_credit_note'), 0), 2)
    FROM settlement_invoices si WHERE si.id = p_invoice_id;
$function$;

INSERT INTO unions VALUES ('{UNION}', 'Midway Union', '{HOUSE_OWNER}');
INSERT INTO clubs VALUES ('{HOUSE_CLUB}', 'House Club', '{HOUSE_OWNER}'),
                         ('{OTHER_CLUB}', 'Other Club', '{OTHER_OWNER}');
INSERT INTO union_club_terms VALUES ('{UNION}', '{HOUSE_CLUB}', 'active', NULL, 0, NULL, NULL, now()),
                                    ('{UNION}', '{OTHER_CLUB}', 'active', NULL, 0, NULL, NULL, now());
-- Both statements issued for the same closed week, due 7.02 days ago.
INSERT INTO settlement_invoices(id, invoice_number, club_id, invoice_type, from_entity_type, net_amount,
                                status, due_at, reminders_sent, breakdown) VALUES
  ('{HOUSE_INV}', 'MIDWAY-2026-000015', '{HOUSE_CLUB}', 'union_weekly_squareup', 'club', 126153.66,
   'generated', now() - interval '7.02 days', 0,
   jsonb_build_object('union_id', '{UNION}', 'club_name', 'House Club')),
  ('{OTHER_INV}', 'MIDWAY-2026-000099', '{OTHER_CLUB}', 'union_weekly_squareup', 'club', 500.00,
   'generated', now() - interval '7.02 days', 0,
   jsonb_build_object('union_id', '{UNION}', 'club_name', 'Other Club'));
"""

GRANTS = """
REVOKE ALL ON FUNCTION public.fn_union_age_invoices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_age_invoices(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_enforce_stop_loss(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_enforce_stop_loss(uuid) TO service_role;
"""


def state():
    return json.loads(run(f"""
SELECT jsonb_build_object(
  'house_status', (SELECT status FROM settlement_invoices WHERE id = '{HOUSE_INV}'),
  'other_status', (SELECT status FROM settlement_invoices WHERE id = '{OTHER_INV}'),
  'house_reminded', (SELECT count(*) FROM reminders WHERE invoice_id = '{HOUSE_INV}'),
  'other_reminded', (SELECT count(*) FROM reminders WHERE invoice_id = '{OTHER_INV}'),
  'house_escalations', (SELECT count(*) FROM financial_alerts WHERE source = 'fn_union_age_invoices'
                          AND context->>'invoice_id' = '{HOUSE_INV}'),
  'other_escalations', (SELECT count(*) FROM financial_alerts WHERE source = 'fn_union_age_invoices'
                          AND context->>'invoice_id' = '{OTHER_INV}'),
  'house_terms', (SELECT status FROM union_club_terms WHERE club_id = '{HOUSE_CLUB}'),
  'other_terms', (SELECT status FROM union_club_terms WHERE club_id = '{OTHER_CLUB}'),
  'house_suspension_alerts_open', (SELECT count(*) FROM financial_alerts WHERE source = 'fn_union_enforce_stop_loss'
                          AND context->>'club_id' = '{HOUSE_CLUB}' AND NOT resolved),
  'house_suspension_alerts', (SELECT count(*) FROM financial_alerts WHERE source = 'fn_union_enforce_stop_loss'
                          AND context->>'club_id' = '{HOUSE_CLUB}'),
  'other_suspension_alerts_open', (SELECT count(*) FROM financial_alerts WHERE source = 'fn_union_enforce_stop_loss'
                          AND context->>'club_id' = '{OTHER_CLUB}' AND NOT resolved));
"""))


def sweep():
    run(f"SELECT public.fn_union_age_invoices('{UNION}'); SELECT public.fn_union_enforce_stop_loss('{UNION}');")


def definition(file, name):
    source = (MIGRATIONS / file).read_text()
    found = list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name)
                             + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S))
    if not found:
        raise ValueError('missing definition: ' + name + ' in ' + file)
    return found[-1].group(0)


def block(file, tag):
    source = (MIGRATIONS / file).read_text()
    m = re.search(r'DO \$' + tag + r'\$.*?\$' + tag + r'\$;', source, re.S)
    if not m:
        raise ValueError('missing block $' + tag + '$ in ' + file)
    return m.group(0)


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


try:
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-A', 'trust', '-U', 'postgres'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses=''", '-l', cluster / 'log', '-w', 'start'])
    run(SCHEMA)
    # The live text, rebuilt from the migrations that wrote it.
    run(definition('20260907183130_an_unpaid_statement_ages_and_is_chased.sql', 'fn_union_age_invoices'))
    run(block('20261003024413_the_books_close.sql', 'age'))
    run(definition('20260926042119_the_union_sweep_evaluates_what_the_open_week_can_prove.sql',
                   'fn_union_enforce_stop_loss'))
    run(GRANTS)
    check('the rebuilt definitions are the production text', md5('public.fn_union_age_invoices(uuid)') == LIVE_AGE_MD5
          and md5('public.fn_union_enforce_stop_loss(uuid)') == LIVE_ENF_MD5)

    # Baseline: the live text duns the house and suspends its own club.
    sweep()
    s = state()
    check('baseline: the live text escalates the house statement', s['house_escalations'] == 1 and s['house_status'] == 'overdue', s)
    check('baseline: the live text suspends the house club for a debt to itself', s['house_terms'] == 'suspended', s)
    check('baseline: a different owner is chased and suspended', s['other_terms'] == 'suspended' and s['other_escalations'] == 1, s)

    # The candidate migration, exactly as it will be installed.
    run(MIGRATION.read_text())
    check('postimage md5 equals the one derived on production',
          md5('public.fn_union_age_invoices(uuid)') == POST_AGE_MD5
          and md5('public.fn_union_enforce_stop_loss(uuid)') == POST_ENF_MD5)
    acl = run("SELECT string_agg(proname || ':' || proacl::text || ':' || prosecdef::text || ':' || array_to_string(proconfig, ','), ' ' ORDER BY proname) FROM pg_proc WHERE proname IN ('fn_union_age_invoices','fn_union_enforce_stop_loss')")
    check('owner, security, settings and grants kept', acl.count('service_role=X/postgres') == 2 and acl.count(':true:search_path=public') == 2, acl)

    # The next :35 sweep restores the house club and closes its suspension alert.
    before = state()
    sweep()
    s = state()
    check('after: the house club is restored', s['house_terms'] == 'active', s)
    check('after: the suspension alert closes with the suspension',
          s['house_suspension_alerts_open'] == 0 and s['house_suspension_alerts'] == before['house_suspension_alerts'], s)
    check('after: the house statement is not chased again',
          s['house_reminded'] == before['house_reminded'] and s['house_escalations'] == before['house_escalations'], s)
    check('after: a different owner stays suspended with its alert open',
          s['other_terms'] == 'suspended' and s['other_suspension_alerts_open'] == 1, s)

    # A fresh same-owner statement past grace is never touched; a fresh
    # different-owner one still is.
    run(f"""
INSERT INTO settlement_invoices(id, invoice_number, club_id, invoice_type, from_entity_type, net_amount,
                                status, due_at, reminders_sent, breakdown) VALUES
  ('c0000000-0000-0000-0000-000000000016', 'MIDWAY-2026-000016', '{HOUSE_CLUB}', 'union_weekly_squareup', 'club', 90.00,
   'generated', now() - interval '9 days', 0, jsonb_build_object('union_id', '{UNION}', 'club_name', 'House Club')),
  ('c0000000-0000-0000-0000-000000000098', 'MIDWAY-2026-000098', '{OTHER_CLUB}', 'union_weekly_squareup', 'club', 90.00,
   'generated', now() - interval '9 days', 0, jsonb_build_object('union_id', '{UNION}', 'club_name', 'Other Club'));
""")
    sweep()
    fresh = json.loads(run("""
SELECT jsonb_build_object(
  'house', (SELECT jsonb_build_object('status', status, 'reminders', reminders_sent) FROM settlement_invoices WHERE invoice_number = 'MIDWAY-2026-000016'),
  'other', (SELECT jsonb_build_object('status', status, 'reminders', reminders_sent) FROM settlement_invoices WHERE invoice_number = 'MIDWAY-2026-000098'),
  'house_terms', (SELECT status FROM union_club_terms WHERE club_id = 'a0000000-0000-0000-0000-000000000001'))
"""))
    check('a new same-owner statement is a statement, not a receivable',
          fresh['house'] == {'status': 'generated', 'reminders': 0} and fresh['house_terms'] == 'active', fresh)
    check('a new different-owner statement is still chased to level 3',
          fresh['other'] == {'status': 'overdue', 'reminders': 3}, fresh)
    results['passed'] = True
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')

print(json.dumps(results, indent=2))
