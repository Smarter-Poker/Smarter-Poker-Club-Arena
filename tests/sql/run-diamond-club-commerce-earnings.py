#!/usr/bin/env python3
"""Club and union diamond commerce: the settled earnings coverage readout, and a
union sponsor buying the club insurance module for a covered club.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2) 5.2 and 5.3. Qualifies
supabase/migrations/20260924183657_diamond_commerce_settled_earnings_coverage.sql
in a private, socket-only PostgreSQL cluster, reusing the cluster, fixture and
identity plumbing of tests/sql/run-diamond-club-commerce.py (imported, not
modified). Identity is presented exactly as PostgREST presents it
(request.jwt.claims plus SET ROLE).

  TEMPLATE  Prompt 1's registry, the installed commerce migrations (base,
            fixes, 20260924102040), 20260924182605 on top, then the base seed.
            The captured diamond-games fixture does not carry the Diamond Spins
            daily statement, so its production shape (20260919152614 plus the
            burn columns of 20260921202834, credited_net generated exactly as
            production generates it) is declared here, like the base harness
            declares notifications. Wallet receipts are written by the fixture's
            own add_diamonds_to_balance, with the reference and type the
            production settler uses.
  RED       every earnings scenario runs on a copy WITHOUT the migration and
            must fail.
  GREEN     every earnings scenario runs on a copy WITH it and must pass.
  VERIFY    the sponsored club insurance order (no migration needed: the
            server already accepts it) is proven end to end on GREEN.

Nothing here connects to production.

Run:  python3 tests/sql/run-diamond-club-commerce-earnings.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('diamond_club_commerce_harness_e', ROOT / 'tests/sql/run-diamond-club-commerce.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)

PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
if 'PG_BIN' not in os.environ and not Path(PG_BIN, 'initdb').exists():
    _found = sorted(Path('/usr/lib/postgresql').glob('*/bin/initdb'), key=lambda p: int(p.parts[-3]) if p.parts[-3].isdigit() else 0)
    if _found:
        PG_BIN = str(_found[-1].parent)
shutil.rmtree(h.work, ignore_errors=True)
# A private cluster in a directory this runner makes and removes. The base
# harness's start_cluster starts it socket-only (listen_addresses= empty), so
# nothing reaches it over the network.
h.work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce-earnings.'))
h.sock = h.work / 'socket'
h.sock.mkdir()
h.data = h.work / 'data'
h.PG_BIN = PG_BIN
h.PORT = '55673'
h.PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(h.sock), '-p', h.PORT, '-U', 'postgres']

COMPLETION = ROOT / 'supabase/migrations/20260924182605_diamond_commerce_catalog_terms_written_quotes_and_trial_reviews.sql'
MIGRATION = Path(os.environ.get('COMMERCE_EARNINGS_MIGRATION',
                                ROOT / 'supabase/migrations/20260924183657_diamond_commerce_settled_earnings_coverage.sql'))
TEMPLATE = h.DB
RED, GREEN = 'earnings_red', 'earnings_green'

# The production shape of the Diamond Spins daily statement: 20260919152614's
# table, with 20260921202834's burn columns. Only a read runs against it.
SPIN_DAYS = """
CREATE TABLE public.diamond_spin_days (
 owner_id uuid NOT NULL,
 day date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','settling','settled')),
 pending_diamonds bigint NOT NULL DEFAULT 0,
 entry_diamonds bigint NOT NULL DEFAULT 0,
 settled_net bigint,
 wallet_transaction_id uuid,
 notification_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 profit_burn_bps integer NOT NULL DEFAULT 0 CHECK(profit_burn_bps BETWEEN 0 AND 10000),
 profit_burn bigint NOT NULL DEFAULT 0 CHECK(profit_burn>=0),
 credited_net bigint GENERATED ALWAYS AS (settled_net-profit_burn) STORED,
 PRIMARY KEY(owner_id,day));
ALTER TABLE public.diamond_spin_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_spin_days FROM PUBLIC,anon,authenticated,service_role;
"""

passed = 0
results = []


class CheckFailed(AssertionError):
    pass


def ck(cond, label, detail=''):
    if not cond:
        raise CheckFailed(f'{label} :: {str(detail)[:600]}')


def record(label, ok, detail=''):
    global passed
    results.append({'test': label, 'result': 'PASS' if ok else 'FAIL', **({'detail': str(detail)[:600]} if detail else {})})
    if ok:
        passed += 1
        print('PASS', label, flush=True)
    else:
        print('FAIL', label, detail, flush=True)
        raise CheckFailed(f'{label} {detail}')


def q(db, text, user=None, role=None, ok=True):
    return h.sql(text, ok=ok, db=db, user=user, role=role)


def rpc(db, fn, args, user, role='authenticated'):
    return json.loads(q(db, f'SELECT public.{fn}({args})', user=user, role=role))


def u(tag):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'earnings:' + tag))


def person(db, tag, diamonds=0, role='user'):
    uid = u('user:' + tag)
    q(db, f"""INSERT INTO auth.users(id) VALUES ('{uid}');
      INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role) VALUES ('{uid}','ern_{tag[:24]}',{diamonds},{diamonds},'{role}');""")
    return uid


def club(db, tag, owner, union_id=None):
    cid = u('club:' + tag)
    un = 'NULL' if union_id is None else f"'{union_id}'"
    q(db, f"""INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union) VALUES ('{cid}','Earnings {tag}','{owner}',{un},0,0,false);
      INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{cid}','{owner}','owner','active',0);""")
    if union_id:
        q(db, f"INSERT INTO public.union_clubs(union_id,club_id) VALUES ('{union_id}','{cid}')")
    return cid


def union(db, tag, owner):
    uid = u('union:' + tag)
    q(db, f"INSERT INTO public.unions(id,name,owner_id,slug) VALUES ('{uid}','Earnings Union {tag}','{owner}','earnings-{tag}')")
    return uid


def lines(sku, qty=1):
    return json.dumps([{'sku': sku, 'quantity': qty}]).replace("'", "''")


def quote(db, user, kind, scope, sku, sponsorship=None):
    sp = f"'{sponsorship}'::uuid" if sponsorship else 'NULL'
    return rpc(db, 'fn_ca_commerce_quote', f"'{kind}','{scope}','{lines(sku)}'::jsonb,{sp},NULL,'purchase'", user)


def buy(db, user, quote_id, key):
    return rpc(db, 'fn_ca_commerce_purchase', f"'{quote_id}','{key}','purchase'", user)


def open_checkout(db):
    r = rpc(db, 'fn_ca_commerce_settings_set', 'true,true,NULL,false', h.S)
    ck(r.get('success'), 'staff open checkout and the catalog', r)


def settle_day(db, owner, days_ago, net, burn=0, settled_days_ago=None, matched=True):
    """One settled Diamond Spins day, written as the production settler leaves
    it: the day row plus, when anything moved, ONE wallet receipt with the
    settler's type and reference."""
    day = f"((now() AT TIME ZONE 'America/Chicago')::date - {days_ago})"
    at = f"now() - interval '{settled_days_ago if settled_days_ago is not None else days_ago - 1} days' - interval '1 hour'"
    credit = net - burn
    tx = 'NULL'
    if credit != 0:
        if matched:
            ref = q(db, f"SELECT 'diamond-spin-day:{owner}:' || {day}::text")
            r = json.loads(q(db, f"SELECT public.add_diamonds_to_balance('{owner}',{credit},'transfer','Diamond Spins Daily Net Settlement','{ref}','{owner}')"))
            ck(r.get('success'), 'fixture: the settler credits the wallet', r)
            tx = f"'{r['transaction_id']}'"
        else:
            tx = 'gen_random_uuid()'
    q(db, f"""INSERT INTO public.diamond_spin_days(owner_id,day,status,pending_diamonds,settled_net,profit_burn_bps,profit_burn,wallet_transaction_id,notification_id,settled_at)
      VALUES ('{owner}',{day},'settled',0,{net},{2000 if burn else 0},{burn},{tx},gen_random_uuid(),{at})""")


def coverage(db, user, kind, scope, days=30, role='authenticated'):
    return rpc(db, 'fn_ca_commerce_earnings_coverage', f"'{kind}','{scope}',{days}", user, role=role)


# ---------------------------------------------------------------------------
# Scenarios (each fails on RED)
# ---------------------------------------------------------------------------
def s_earnings_comparison(db, t):
    open_checkout(db)
    o = person(db, t + 'o1', 5000)
    k = club(db, t + 'k1', o)
    k2 = club(db, t + 'k2', o)
    other = person(db, t + 'x1', 5000)
    # Settled days in the last 30: +210 net burning 42 (credits 168); -50;
    # +80 that first settles a 30 diamond debt; a zero day; an unmatched row.
    settle_day(db, o, 2, 210, burn=42)
    settle_day(db, o, 3, -50)
    q(db, f"INSERT INTO public.diamond_debts(user_id,purchase_id,amount,reason) VALUES ('{o}',gen_random_uuid(),30,'Fixture: reversed purchase')")
    settle_day(db, o, 4, 80)
    settle_day(db, o, 5, 0)
    settle_day(db, o, 6, 77, matched=False)
    # Outside the window, another owner's day, and today's open day.
    settle_day(db, o, 41, 500)
    settle_day(db, other, 2, 999)
    q(db, f"""INSERT INTO public.diamond_spin_days(owner_id,day,status,pending_diamonds,entry_diamonds)
      VALUES ('{o}',(now() AT TIME ZONE 'America/Chicago')::date,'open',25,25)""")
    # Operating purchases: 500 for this club (200 of it refunded), 500 for another.
    qt = quote(db, o, 'club', k, 'capacity_60')
    rc = buy(db, o, qt['quote_id'], t + 'earn-0001')
    ck(rc.get('success'), 'purchase for this club', rc)
    rf = rpc(db, 'fn_ca_commerce_refund', f"'{rc['purchase_id']}',0,200,'Fixture: partial return for the comparison','{t}earn-refund-01'", h.S, role='service_role')
    ck(rf.get('success'), 'staff refund part of it', rf)
    qt2 = quote(db, o, 'club', k2, 'capacity_60')
    ck(buy(db, o, qt2['quote_id'], t + 'earn-0002').get('success'), 'purchase for another club')

    r = coverage(db, o, 'club', k)
    ck(r.get('success') is True and r['days'] == 30 and r['owner_id'] == o, 'coverage: the owner reads their club', r)
    e, op = r['earnings'], r['operating']
    ck(e['source'] == 'diamond_spins_daily_settlement' and e['scope'] == 'owner_all_hosts', 'coverage: names its only source', e)
    ck((e['settled_days'], e['credited'], e['debited'], e['applied_to_debt']) == (3, 248, 50, 30),
       'coverage: each settled day counted once, at what the wallet actually moved (after the burn)', e)
    ck(e['net_settled'] == 168, 'coverage: net settled earnings are credits less debits less what settled a debt', e)
    ck(e['unmatched_days'] == 1, 'coverage: a day without its wallet receipt is not counted, and is named', e)
    ck(e['pending_unsettled'] == 25, 'coverage: an open day is shown apart as not yet settled', e)
    ck((op['purchases'], op['paid'], op['refunded'], op['net_paid']) == (1, 500, 200, 300),
       'coverage: operating purchases for this scope, each refund counted once against its purchase', op)
    ck(op['owner_all_scopes_net_paid'] == 800 and op['paid_by_others'] == 0, 'coverage: the owner\'s whole operating spend is shown apart', op)
    ck(r['comparison_covered'] == 168 and r['lot_provenance'] is False, 'coverage: the comparison claims no lot provenance', r)
    wide = coverage(db, o, 'club', k, days=60)
    ck(wide['earnings']['credited'] == 748 and wide['earnings']['settled_days'] == 4, 'coverage: the window is honoured', wide['earnings'])
    return 'settled Diamond Spins earnings are compared with operating purchases once each, with no lot provenance claimed'


def s_earnings_sponsored(db, t):
    open_checkout(db)
    b = person(db, t + 'b2', 8000)
    d = person(db, t + 'd2', 100)
    un = union(db, t + 'u2', b)
    kc = club(db, t + 'k3', d, un)
    sp = rpc(db, 'fn_ca_commerce_sponsorship_set', f"'{un}',NULL,5000,NULL,NULL,NULL,false", b)
    ck(sp.get('success'), 'sponsorship recorded', sp)
    qt = quote(db, b, 'club', kc, 'capacity_60', sponsorship=sp['sponsorship_id'])
    ck(qt.get('success'), 'sponsored quote', qt)
    ck(buy(db, b, qt['quote_id'], t + 'earn-sp-01').get('success'), 'sponsored purchase')
    r = coverage(db, d, 'club', kc)
    ck(r['operating']['net_paid'] == 0 and r['operating']['paid_by_others'] == 500,
       'coverage: a sponsor\'s payment is not the club owner\'s cost, and is shown apart', r['operating'])
    ru = coverage(db, b, 'union', un)
    ck(ru.get('success') and ru['operating']['owner_all_scopes_net_paid'] == 500,
       'coverage: the sponsor reads their own spend on the union page', ru['operating'])
    return 'a sponsored purchase is counted as the sponsor\'s spend, never the club owner\'s'


def s_earnings_access(db, t):
    o = person(db, t + 'o4', 0)
    k = club(db, t + 'k4', o)
    stranger = person(db, t + 'n4', 0)
    admin = person(db, t + 'a4', 0)
    q(db, f"INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{k}','{admin}','admin','active',0)")
    ck(coverage(db, stranger, 'club', k).get('error') == 'owner_required', 'access: another person cannot read an owner\'s earnings')
    ck(coverage(db, admin, 'club', k).get('error') == 'owner_required', 'access: a club administrator cannot read the owner\'s earnings')
    ck(coverage(db, h.S, 'club', k).get('success') is True, 'access: platform staff read it')
    ck(coverage(db, h.S, 'club', k, role='service_role').get('success') is True, 'access: the service role reads it')
    ck(coverage(db, o, 'club', k, days=0).get('error') == 'invalid_window' and coverage(db, o, 'club', k, days=366).get('error') == 'invalid_window',
       'access: the window is 1 to 365 days')
    ck(rpc(db, 'fn_ca_commerce_earnings_coverage', f"'table','{k}',30", o).get('error') == 'invalid_scope', 'access: only clubs and unions')
    r = q(db, f"SELECT public.fn_ca_commerce_earnings_coverage('club','{k}',30)", role='anon', ok=False)
    ck(r.returncode != 0 and 'permission denied' in r.stderr, 'access: anon cannot call it', r.stderr[-200:])
    out = q(db, f"START TRANSACTION READ ONLY; SELECT public.fn_ca_commerce_earnings_coverage('club','{k}',30); COMMIT;", user=o, role='authenticated')
    ck(json.loads(out).get('success') is True, 'no writes: it answers inside a read only transaction', out)
    ck(q(db, "SELECT provolatile FROM pg_proc WHERE proname='fn_ca_commerce_earnings_coverage'") == 's', 'no writes: declared STABLE')
    return 'the scope owner, staff and the service role read it; nobody else; it writes nothing'


EARNINGS = [s_earnings_comparison, s_earnings_sponsored, s_earnings_access]


# ---------------------------------------------------------------------------
# VERIFY: a union sponsor buys the club insurance module (R2 5.2)
# ---------------------------------------------------------------------------
def v_sponsor_insurance(db):
    open_checkout(db)
    b = person(db, 'vb', 8000)
    d = person(db, 'vd', 100)
    un = union(db, 'vu', b)
    kc = club(db, 'vk', d, un)
    ins = [p for p in rpc(db, 'fn_ca_commerce_catalog', "'club'", b)['products'] if p['sku'] == 'club_insurance_module']
    ck(ins and ins[0]['supported'] and ins[0]['platform_available'] is True and ins[0]['price'],
       'insurance: the catalog offers the club insurance module as supported and available', ins)
    sp = rpc(db, 'fn_ca_commerce_sponsorship_set', f"'{un}',NULL,5000,NULL,NULL,NULL,false", b)
    qt = quote(db, b, 'club', kc, 'club_insurance_module', sponsorship=sp['sponsorship_id'])
    ck(qt.get('success') and qt['sponsorship_id'] == sp['sponsorship_id'] and qt['lines'][0]['sku'] == 'club_insurance_module',
       'insurance: the sponsor quotes it for a covered club', qt)
    before = int(q(db, f"SELECT diamonds FROM public.profiles WHERE id='{b}'"))
    rc = buy(db, b, qt['quote_id'], 'verify-insurance-0001')
    ck(rc.get('success') and rc['original_total_diamonds'] == qt['net'] and rc['payer_id'] == b, 'insurance: the sponsor buys it', rc)
    after = int(q(db, f"SELECT diamonds FROM public.profiles WHERE id='{b}'"))
    ck(before - after == qt['net'], 'insurance: charged to the sponsor once', (before, after, qt['net']))
    ent = json.loads(q(db, f"SELECT to_jsonb(e) FROM public.ca_commerce_entitlements e WHERE e.scope_id = '{kc}' AND e.sku = 'club_insurance_module'"))
    ck(ent['kind'] == 'club_insurance_module' and ent['source'] == 'sponsor', 'insurance: the club holds the right, paid by the sponsor', ent)
    owner_quote = quote(db, d, 'club', kc, 'club_insurance_module', sponsorship=sp['sponsorship_id'])
    ck(owner_quote.get('error') == 'sponsor_payer_required', 'insurance: the club owner cannot spend the sponsorship', owner_quote)
    return 'a union sponsor quotes and buys the club insurance module for a covered club through the ordinary sponsored order'


def run_scenarios(db, expect_fail):
    tag = 'r' if expect_fail else 'g'
    for fn in EARNINGS:
        name = fn.__name__[2:].replace('_', ' ')
        try:
            summary = fn(db, tag)
            err = None
        except (CheckFailed, AssertionError, json.JSONDecodeError, KeyError, TypeError) as e:
            summary, err = None, str(e)
        if expect_fail:
            record(f'RED   {name}: fails without the migration', err is not None, '' if err else 'passed without its fix')
            if err:
                results[-1]['why'] = err[:300]
        else:
            record(f'GREEN {summary or name}', err is None, err or '')


def main():
    try:
        h.start_cluster()
        h.load_fixture()
        h.install_registry()
        for m in [*h.MIGRATIONS, COMPLETION]:
            r = h.run(h.PSQL + ['-d', TEMPLATE, '-f', str(m)])
            if r.returncode:
                raise SystemExit(f'migration {m.name} failed:\n' + r.stderr)
        q(TEMPLATE, SPIN_DAYS)
        h.seed()
        q('postgres', f'CREATE DATABASE {RED} TEMPLATE {TEMPLATE}')
        q('postgres', f'CREATE DATABASE {GREEN} TEMPLATE {TEMPLATE}')

        r = h.run(h.PSQL + ['-d', GREEN, '-f', str(MIGRATION)])
        if r.returncode:
            raise SystemExit('migration failed:\n' + r.stderr)
        record('INSTALL the migration applies in one transaction with its baseline pins and post-conditions', True)
        r = h.run(h.PSQL + ['-d', GREEN, '-f', str(MIGRATION)])
        record('SAFETY a second apply refuses at its baseline pin and changes nothing', r.returncode != 0 and 'commerce baseline changed' in r.stderr, r.stderr[-200:])

        run_scenarios(RED, expect_fail=True)
        run_scenarios(GREEN, expect_fail=False)
        try:
            record(f'VERIFY {v_sponsor_insurance(GREEN)}', True)
        except (CheckFailed, AssertionError, json.JSONDecodeError, KeyError, TypeError) as e:
            record('VERIFY sponsor insurance', False, str(e))
        print(f'PASS {passed} checks: settled earnings coverage and sponsored club insurance qualified in isolation')
        out = os.environ.get('COMMERCE_EARNINGS_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'migration': MIGRATION.name}, indent=1))
    except (AssertionError, CheckFailed) as e:
        print('FAIL', e, file=sys.stderr)
        sys.exit(1)
    finally:
        h.stop_cluster()


if __name__ == '__main__':
    main()
