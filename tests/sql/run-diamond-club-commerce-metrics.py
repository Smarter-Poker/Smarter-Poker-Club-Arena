#!/usr/bin/env python3
"""Club and union diamond commerce: the staff operating metrics read.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2) section 7.5. Qualifies
supabase/migrations/20260924183529_diamond_commerce_staff_metrics.sql in a
private, socket-only PostgreSQL cluster, reusing the cluster, fixture and
identity plumbing of tests/sql/run-diamond-club-commerce.py (imported, not
modified). Identity is presented exactly as PostgREST presents it
(request.jwt.claims plus SET ROLE).

  TEMPLATE  Prompt 1's registry, the installed commerce migrations (base,
            fixes, 20260924102040), the completion migration 20260924182605,
            then the base seed.
  RED       without this migration there is no metrics read at all.
  INSTALL   the migration applies in one transaction; a second apply refuses.
  GREEN     purchases, a replay, refunds, trials, a sponsorship, a renewal
            authorization and notices are created through the real doors,
            and every metric is asserted exactly. Rows only a consumer writes
            (a replayed refund execution, a postcondition failure) are
            recorded as that consumer records them, since no fixture can make
            the canonical journal disagree with itself.
  GRANTS    an owner is refused staff_required; anon cannot call it.

Nothing here connects to production.

Run:  PG_BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1) python3 tests/sql/run-diamond-club-commerce-metrics.py
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
_spec = importlib.util.spec_from_file_location('diamond_club_commerce_harness_m', ROOT / 'tests/sql/run-diamond-club-commerce.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)

PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
if 'PG_BIN' not in os.environ and not Path(PG_BIN, 'initdb').exists():
    _found = sorted(Path('/usr/lib/postgresql').glob('*/bin/initdb'), key=lambda p: int(p.parts[-3]) if p.parts[-3].isdigit() else 0)
    if _found:
        PG_BIN = str(_found[-1].parent)
shutil.rmtree(h.work, ignore_errors=True)
h.work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce-metrics.'))
h.sock = h.work / 'socket'
h.sock.mkdir()
h.data = h.work / 'data'
h.PG_BIN = PG_BIN
h.PORT = '55663'
h.PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(h.sock), '-p', h.PORT, '-U', 'postgres']

COMPLETION = ROOT / 'supabase/migrations/20260924182605_diamond_commerce_catalog_terms_written_quotes_and_trial_reviews.sql'
MIGRATION = Path(os.environ.get('COMMERCE_METRICS_MIGRATION',
                                ROOT / 'supabase/migrations/20260924183529_diamond_commerce_staff_metrics.sql'))
DB = h.DB

passed = 0
results = []


def record(label, ok, detail=''):
    global passed
    results.append({'test': label, 'result': 'PASS' if ok else 'FAIL', **({'detail': str(detail)[:600]} if detail else {})})
    if ok:
        passed += 1
        print('PASS', label, flush=True)
    else:
        print('FAIL', label, str(detail)[:1200], flush=True)
        raise AssertionError(f'{label} {detail}')


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------
def q(text, user=None, role=None, ok=True):
    return h.sql(text, ok=ok, db=DB, user=user, role=role)


def rpc(fn, args, user, role='authenticated'):
    return json.loads(q(f'SELECT public.{fn}({args})', user=user, role=role))


def svc(fn, args):
    return json.loads(q(f'SELECT public.{fn}({args})', role='service_role'))


def u(tag):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'metrics:' + tag))


def person(tag, diamonds=0, role='user'):
    uid = u('user:' + tag)
    q(f"""INSERT INTO auth.users(id) VALUES ('{uid}');
      INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role) VALUES ('{uid}','met_{tag[:24]}',{diamonds},{diamonds},'{role}');""")
    return uid


def club(tag, owner):
    cid = u('club:' + tag)
    q(f"""INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union) VALUES ('{cid}','Metrics {tag}','{owner}',NULL,0,0,false);
      INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{cid}','{owner}','owner','active',0);""")
    return cid


def lines(sku):
    return json.dumps([{'sku': sku, 'quantity': 1}]).replace("'", "''")


def quote(user, scope, sku, sponsorship=None):
    sp = f"'{sponsorship}'::uuid" if sponsorship else 'NULL'
    r = rpc('fn_ca_commerce_quote', f"'club','{scope}','{lines(sku)}'::jsonb,{sp},NULL,'purchase'", user)
    record(f'setup: quote {sku}', r.get('success') is True, r)
    return r


def buy(user, quote_id, key):
    return rpc('fn_ca_commerce_purchase', f"'{quote_id}','{key}','purchase'", user)


def bought(user, scope, key, sponsorship=None):
    qt = quote(user, scope, 'capacity_60', sponsorship)
    r = buy(user, qt['quote_id'], key)
    record(f'setup: purchase {key} charges 500', r.get('success') is True and r.get('charged_this_attempt') == 500, r)
    return r


def refund_request(user, purchase, key):
    r = rpc('fn_ca_commerce_refund_request', f"'{purchase}',0,'purchase_in_error','{key}',NULL", user)
    record(f'setup: refund request {key}', r.get('success') is True and r['request']['state'] == 'requested', r)
    return r['request']['request_id']


def decide(request_id, approve, amount=None, note=None):
    a = 'NULL' if amount is None else str(amount)
    n = 'NULL' if note is None else "'" + note.replace("'", "''") + "'"
    r = rpc('fn_ca_commerce_refund_decide', f"'{request_id}',{'true' if approve else 'false'},{a},{n}", h.S)
    record(f'setup: staff {"approve" if approve else "decline"} {request_id[:8]}', r.get('success') is True, r)
    return r


def metrics(days=30, user=None, role='authenticated'):
    return rpc('fn_ca_commerce_metrics', str(days), user or h.S, role)


def event(kind, detail, age="interval '0'"):
    q(f"INSERT INTO public.ca_commerce_events (occurred_at, kind, detail) VALUES (clock_timestamp() - {age}, '{kind}', '{json.dumps(detail)}'::jsonb)")


# ---------------------------------------------------------------------------
# The scenario
# ---------------------------------------------------------------------------
def build():
    r = rpc('fn_ca_commerce_settings_set', 'true,true,NULL,false', h.S)
    record('setup: checkout and the catalog are on', r.get('success') is True, r)

    # Five owners buy 500-diamond capacity; one purchase is replayed.
    o1, o2, o3, o4, o6 = (person(t, 5000) for t in ('o1', 'o2', 'o3', 'o4', 'o6'))
    k1, k2, k3, k4, k6 = (club(t, o) for t, o in (('k1', o1), ('k2', o2), ('k3', o3), ('k4', o4), ('k6', o6)))
    q1 = quote(o1, k1, 'capacity_60')
    p1 = buy(o1, q1['quote_id'], 'metrics-p1-000001')
    record('setup: the first purchase charges 500', p1.get('success') is True and p1['charged_this_attempt'] == 500, p1)
    replay = buy(o1, q1['quote_id'], 'metrics-p1-000001')
    record('setup: the same request replays its receipt and charges nothing', replay.get('is_replay') is True and replay['charged_this_attempt'] == 0, replay)
    p2 = bought(o2, k2, 'metrics-p2-000001')
    p3 = bought(o3, k3, 'metrics-p3-000001')
    p4 = bought(o4, k4, 'metrics-p4-000001')
    p6 = bought(o6, k6, 'metrics-p6-000001')

    # Quotes that were not bought: withdrawn, open, expired by time.
    quote(o1, k1, 'capacity_100')
    r = rpc('fn_ca_commerce_product_support', "'capacity_100',false", h.S)
    record('setup: withdrawing a product withdraws its open quote', r.get('success') is True and r.get('quotes_withdrawn') == 1, r)
    r = rpc('fn_ca_commerce_product_support', "'capacity_100',true", h.S)
    record('setup: the product is offered again', r.get('success') is True, r)
    quote(o1, k1, 'capacity_60')
    qe = quote(o1, k1, 'capacity_60')
    q(f"UPDATE public.ca_commerce_quotes SET expires_at = now() - interval '1 minute' WHERE id = '{qe['quote_id']}'")

    # A union sponsor pays for a member club.
    b, d = h.B, h.D
    sp = rpc('fn_ca_commerce_sponsorship_set', f"'{h.U}',NULL,2000,NULL,NULL,NULL,false", b)
    record('setup: the union owner sponsors 2,000 diamonds', sp.get('success') is True, sp)
    bought(b, h.C3, 'metrics-sp-000001', sponsorship=sp['sponsorship_id'])

    # Refunds: one executed, one approved and waiting, one awaiting a decision, one declined.
    r2 = refund_request(o2, p2['purchase_id'], 'metrics-r2-000001')
    r3 = refund_request(o3, p3['purchase_id'], 'metrics-r3-000001')
    r4 = refund_request(o4, p4['purchase_id'], 'metrics-r4-000001')
    r6 = refund_request(o6, p6['purchase_id'], 'metrics-r6-000001')
    decide(r2, True)
    ex = svc('fn_ca_commerce_execute_approved_refunds', f"'{uuid.uuid4()}',10")
    record('setup: the consumer returns the approved refund', ex.get('refunded') == 1, ex)
    decide(r3, True, amount=100)
    decide(r6, False, note='Bought On Purpose')
    q(f"""UPDATE public.ca_commerce_refund_requests SET decided_at = now() - interval '5 hours 10 minutes' WHERE id = '{r3}';
          UPDATE public.ca_commerce_refund_requests SET created_at = now() - interval '30 hours 10 minutes' WHERE id = '{r4}';
          UPDATE public.ca_commerce_refund_requests SET attempts = 3 WHERE id = '{r2}';""")

    # The free month: one new operator, two clubs (the second inherits).
    o5 = person('o5', 0)
    k5, k5b = club('k5', o5), club('k5b', o5)
    t1 = rpc('fn_ca_commerce_activate_trial', f"'club','{k5}'", o5)
    t2 = rpc('fn_ca_commerce_activate_trial', f"'club','{k5b}'", o5)
    record('setup: a free month, and a second club that inherits it', t1.get('created') is True and t2.get('trial_id') == t1.get('trial_id'), [t1, t2])

    # A renewal authorized on o1's right, now 7 hours overdue.
    ent = p1['lines'][0]['entitlement_id']
    m = rpc('fn_ca_commerce_set_renewal', f"'{ent}',true,1000,NULL,NULL", o1)
    record('setup: o1 authorizes renewal up to 1,000 diamonds', m.get('success') is True and m['state'] == 'authorized', m)
    q(f"UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '7 hours 10 minutes' WHERE id = '{m['mandate_id']}'")

    # One trial reminder is 3 hours overdue for delivery.
    q(f"UPDATE public.ca_commerce_notices SET due_at = now() - interval '3 hours 10 minutes' WHERE dedupe_key = 'trial-reminder-21:{t1['trial_id']}'")

    # What only the consumers write: a refund execution the core answered as a
    # replay, a renewal debit refused as a reused reference, and accounting
    # postcondition failures, one of them 40 days old.
    event('refund_request_executed', {'is_replay': True, 'gross': 1})
    event('renewal_needs_attention', {'outcome': 'needs_attention', 'reason': 'debit_reference_reused'})
    event('renewal_needs_attention', {'outcome': 'needs_attention', 'reason': 'lots_unproved'})
    event('renewal_needs_attention', {'outcome': 'needs_attention', 'reason': 'journal_unproved'}, "interval '40 days'")
    event('refund_request_owed', {'success': False, 'error': 'refund_journal_unproved'})


def assert_metrics():
    m = metrics(30)
    record('the read answers for staff', m.get('success') is True and m['days'] == 30, m)
    record('quotes: priced, proposed diamonds, consumed, open, expired and withdrawn',
           m['quotes'] == {'priced': 9, 'proposed_diamonds': 4700, 'consumed': 6, 'open': 1, 'expired': 1, 'withdrawn': 1}, m['quotes'])
    record('purchases: six committed, 3,000 net paid, the replay not counted, sponsor-paid apart',
           m['purchases'] == {'committed': 6, 'paid': 6, 'zero_net': 0, 'net_paid_diamonds': 3000, 'sponsored_net_diamonds': 500,
                              'trial_waiver_diamonds': 0,
                              'by_kind': {'purchase': {'committed': 6, 'net_paid_diamonds': 3000},
                                          'upgrade': {'committed': 0, 'net_paid_diamonds': 0},
                                          'renewal': {'committed': 0, 'net_paid_diamonds': 0}}}, m['purchases'])
    record('trial waivers: two scopes under one free month, no diamonds',
           m['trial_waivers'] == {'scopes': 2, 'trials': 1, 'net_paid_diamonds': 0}, m['trial_waivers'])
    record('refunds: one committed for 500, kept apart from purchases',
           m['refunds'] == {'committed': 1, 'gross_diamonds': 500, 'debt_settled_diamonds': 0, 'added_to_balance_diamonds': 500}, m['refunds'])
    rr = m['refund_requests']
    record('refund requests: by state, oldest awaiting a decision (30 hours) and awaiting execution (5 hours, 100 diamonds)',
           rr['by_state'] == {'requested': 1, 'approved': 1, 'owed': 0, 'refunded': 1, 'declined': 1, 'failed': 0}
           and rr['awaiting_decision'] == 1 and rr['oldest_awaiting_decision_hours'] == 30 and rr['oldest_awaiting_decision_at']
           and rr['awaiting_execution'] == 1 and rr['awaiting_execution_diamonds'] == 100 and rr['oldest_awaiting_execution_hours'] == 5
           and rr['oldest_awaiting_execution_at'], rr)
    rn = m['renewals']
    record('renewals: one authorized and due, 7 hours overdue; two not completed in the window',
           rn['authorized'] == 1 and rn['due_now'] == 1 and rn['oldest_overdue_hours'] == 7 and rn['oldest_due_at']
           and rn['needs_attention'] == 0 and rn['renewed'] == 0 and rn['not_completed'] == 2, rn)
    record('sponsorships: 500 of 2,000 committed',
           m['sponsorships'] == {'active': 1, 'budget_diamonds': 2000, 'committed_diamonds': 500}, m['sponsorships'])
    n = m['notices']
    record('notices: two due and undelivered (oldest 3 hours), two still scheduled, none suppressed',
           n['undelivered_due'] == 2 and n['oldest_undelivered_hours'] == 3 and n['oldest_undelivered_due_at']
           and n['scheduled'] == 2 and n['suppressed'] == 0, n)
    record('duplicates: what is recorded is counted; purchase replays are said to be unrecorded',
           m['duplicates'] == {'refund_execution_replays': 1, 'renewal_debit_reference_reused': 1, 'purchase_replays_recorded': False}, m['duplicates'])
    record('postconditions: one renewal and one refund failure in 30 days; the 40-day one is outside',
           m['postconditions'] == {'renewal': 1, 'refund': 1, 'purchase_failures_recorded': False}, m['postconditions'])
    record('retries: claims beyond the first are counted apart',
           m['retries'] == {'refund_execution_retries': 2, 'renewal_claim_retries': 0}, m['retries'])

    m90 = metrics(90)
    record('a 90-day window reaches the 40-day postcondition failure',
           m90['days'] == 90 and m90['postconditions']['renewal'] == 2 and m90['purchases']['net_paid_diamonds'] == 3000, m90['postconditions'])
    record('the window is clamped to 1 through 90 days', metrics(0)['days'] == 1 and metrics(500)['days'] == 90)
    sv = rpc('fn_ca_commerce_metrics', '30', None, 'service_role')
    record('the service role reads it', sv.get('success') is True and sv['purchases']['committed'] == 6, sv.get('error'))
    before = q("SELECT (SELECT count(*) FROM public.ca_commerce_events) || ':' || (SELECT count(*) FROM public.ca_commerce_notices) || ':' || (SELECT count(*) FROM public.ca_commerce_quotes)")
    metrics(30)
    after = q("SELECT (SELECT count(*) FROM public.ca_commerce_events) || ':' || (SELECT count(*) FROM public.ca_commerce_notices) || ':' || (SELECT count(*) FROM public.ca_commerce_quotes)")
    record('the read writes nothing', before == after, [before, after])


def assert_grants():
    owner = u('user:o1')
    r = metrics(30, user=owner)
    record('an owner is refused staff_required', r == {'success': False, 'error': 'staff_required'}, r)
    r = q('SELECT public.fn_ca_commerce_metrics(30)', role='anon', ok=False)
    record('anon cannot call it', r.returncode != 0 and 'permission denied' in r.stderr, r.stderr[-200:])


def main():
    try:
        h.start_cluster()
        h.load_fixture()
        h.install_registry()
        for mig in [*h.MIGRATIONS, COMPLETION]:
            r = h.run(h.PSQL + ['-d', DB, '-f', str(mig)])
            if r.returncode:
                raise SystemExit(f'migration {mig.name} failed:\n' + r.stderr)
        h.seed()

        r = q('SELECT public.fn_ca_commerce_metrics(30)', user=h.S, role='authenticated', ok=False)
        record('RED   without the migration there is no metrics read', r.returncode != 0 and 'does not exist' in r.stderr, r.stderr[-200:])
        r = h.run(h.PSQL + ['-d', DB, '-f', str(MIGRATION)])
        record('INSTALL the migration applies in one transaction with its baseline and post-conditions', r.returncode == 0, r.stderr[-400:])
        r = h.run(h.PSQL + ['-d', DB, '-f', str(MIGRATION)])
        record('SAFETY a second apply refuses at its baseline and changes nothing',
               r.returncode != 0 and 'commerce baseline changed' in r.stderr, r.stderr[-200:])

        empty = metrics(30)
        record('GREEN an empty ledger reads zero everywhere, with no ages',
               empty.get('success') is True and empty['purchases']['committed'] == 0 and empty['quotes']['priced'] == 0
               and empty['refund_requests']['oldest_awaiting_decision_hours'] is None
               and empty['renewals']['oldest_overdue_hours'] is None and empty['sponsorships']['budget_diamonds'] == 0, empty)
        build()
        assert_metrics()
        assert_grants()
        print(f'PASS {passed} checks: diamond commerce staff metrics qualified in isolation')
        out = os.environ.get('COMMERCE_METRICS_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'migration': MIGRATION.name}, indent=1))
    except AssertionError as e:
        print('FAIL', e, file=sys.stderr)
        sys.exit(1)
    finally:
        h.stop_cluster()


if __name__ == '__main__':
    main()
