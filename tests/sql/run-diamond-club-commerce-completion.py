#!/usr/bin/env python3
"""Club and union diamond commerce: catalog visibility, service terms, the trial
waiver, quote rate limits, written quotes above 2,500 members and trial reviews.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2). Qualifies
supabase/migrations/20260924182605_diamond_commerce_catalog_terms_written_quotes_and_trial_reviews.sql
in a private, socket-only PostgreSQL cluster, reusing the cluster, fixture and
identity plumbing of tests/sql/run-diamond-club-commerce.py (imported, not
modified). Identity is presented exactly as PostgREST presents it
(request.jwt.claims plus SET ROLE).

  TEMPLATE  Prompt 1's registry, then the installed commerce migrations
            (base, fixes, 20260924102040), then the base seed.
  RED       every scenario runs on a copy WITHOUT the migration and must fail.
  GREEN     every scenario runs on a copy WITH it and must pass.
  REGRESSION the base harness's scenarios pass with the migration on top.

Nothing here connects to production.

Run:  python3 tests/sql/run-diamond-club-commerce-completion.py
"""
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('diamond_club_commerce_harness_c', ROOT / 'tests/sql/run-diamond-club-commerce.py')
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
h.work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce-completion.'))
h.sock = h.work / 'socket'
h.sock.mkdir()
h.data = h.work / 'data'
h.PG_BIN = PG_BIN
h.PORT = '55653'
h.PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(h.sock), '-p', h.PORT, '-U', 'postgres']

MIGRATION = Path(os.environ.get('COMMERCE_COMPLETION_MIGRATION',
                                ROOT / 'supabase/migrations/20260924182605_diamond_commerce_catalog_terms_written_quotes_and_trial_reviews.sql'))
TEMPLATE = h.DB
RED, GREEN = 'completion_red', 'completion_green'
EM_DASH = chr(8212)

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


# ---------------------------------------------------------------------------
# Plumbing on an explicit database
# ---------------------------------------------------------------------------
def q(db, text, user=None, role=None, ok=True):
    return h.sql(text, ok=ok, db=db, user=user, role=role)


def rpc(db, fn, args, user, role='authenticated'):
    out = q(db, f'SELECT public.{fn}({args})', user=user, role=role)
    return json.loads(out)


def js(db, text):
    return json.loads(q(db, text))


def u(tag):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'completion:' + tag))


def lit(s):
    return 'NULL' if s is None else "'" + str(s).replace("'", "''") + "'"


def person(db, tag, diamonds=0, role='user'):
    uid = u('user:' + tag)
    q(db, f"""INSERT INTO auth.users(id) VALUES ('{uid}');
      INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role) VALUES ('{uid}','cmp_{tag[:24]}',{diamonds},{diamonds},'{role}');""")
    return uid


def club(db, tag, owner, union_id=None):
    cid = u('club:' + tag)
    un = 'NULL' if union_id is None else f"'{union_id}'"
    q(db, f"""INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union) VALUES ('{cid}','Completion {tag}','{owner}',{un},0,0,false);
      INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{cid}','{owner}','owner','active',0);""")
    return cid


def lines(sku, qty=1):
    return json.dumps([{'sku': sku, 'quantity': qty}]).replace("'", "''")


def quote(db, user, kind, scope, sku, qty=1, sponsorship=None):
    sp = f"'{sponsorship}'::uuid" if sponsorship else 'NULL'
    return rpc(db, 'fn_ca_commerce_quote', f"'{kind}','{scope}','{lines(sku, qty)}'::jsonb,{sp},NULL,'purchase'", user)


def buy(db, user, quote_id, key):
    return rpc(db, 'fn_ca_commerce_purchase', f"'{quote_id}','{key}','purchase'", user)


def settings(db, checkout=None, visible=None):
    c = 'NULL' if checkout is None else str(checkout).lower()
    v = 'NULL' if visible is None else str(visible).lower()
    r = rpc(db, 'fn_ca_commerce_settings_set', f"{c},{v},NULL,false", h.S)
    ck(r.get('success'), 'staff change the settings', r)


def title_case(text):
    words = re.findall(r"[A-Za-z][A-Za-z']*", text or '')
    return EM_DASH not in (text or '') and all(w[0].isupper() for w in words)


# ---------------------------------------------------------------------------
# Scenarios (each fails on RED)
# ---------------------------------------------------------------------------
def s_catalog_visibility(db, t):
    settings(db, checkout=True, visible=True)
    o = person(db, t + 'o1', 5000)
    k = club(db, t + 'k1', o)
    settings(db, visible=False)
    cat = rpc(db, 'fn_ca_commerce_catalog', "'club'", o)
    ck(cat.get('catalog_visible') is False and cat['products'] and all(p['price'] is None for p in cat['products']),
       'visibility: while the catalog is off, an owner reads products without prices', cat.get('products', [])[:2])
    staff = rpc(db, 'fn_ca_commerce_catalog', "'club'", h.S)
    ck(any(p['price'] for p in staff['products']), 'visibility: staff still read prices while it is off')
    r = quote(db, o, 'club', k, 'capacity_60')
    ck(r == {'success': False, 'error': 'catalog_not_visible'}, 'visibility: the quote door refuses while it is off', r)
    settings(db, visible=True)
    r = quote(db, o, 'club', k, 'capacity_60')
    ck(r.get('success'), 'visibility: switched back on, the same quote prices', r)
    ins = [p for p in rpc(db, 'fn_ca_commerce_catalog', "'club'", o)['products'] if p['sku'] == 'club_insurance_module']
    ck(ins and ins[0].get('platform_capability_id') == 'cash.insurance_ev_cashout' and ins[0].get('platform_available') is True,
       'catalog: a product names the platform capability it sells and whether it is available', ins)
    return 'the Catalog Visible switch is honoured by the catalog and the quote door; products name their platform capability'


def s_terms_and_waiver(db, t):
    settings(db, checkout=True, visible=True)
    pol = rpc(db, 'fn_ca_commerce_policies', "'service_terms'", h.A)
    cur = [p for p in pol.get('policies', []) if p['current']]
    ck(len(cur) == 1 and cur[0]['version'] == 1 and title_case(cur[0]['title']) and title_case(cur[0]['body']),
       'terms: service terms version 1 is published in Title Case with no em dash', pol)
    o = person(db, t + 'o2', 5000)
    k = club(db, t + 'k2', o)
    tr = rpc(db, 'fn_ca_commerce_activate_trial', f"'club','{k}'", o)
    ck(tr.get('success'), 'trial activation', tr)
    row = js(db, f"SELECT to_jsonb(t) FROM public.ca_commerce_trials t WHERE t.id = '{tr['trial_id']}'")
    ck(row.get('terms_version') == 1 and row.get('waiver_reason') == 'Free Operating Month For A New Operator'
       and (row.get('waiver_catalog_version') or '').startswith('catalog:') and (row.get('waiver_prices') or {}).get('capacity_60') == 500,
       'waiver: the trial records the terms accepted, why it is free, the catalog version and every price it waived', row)
    o2 = person(db, t + 'o2b', 5000)
    k2 = club(db, t + 'k2b', o2)
    qt = quote(db, o2, 'club', k2, 'capacity_60')
    rc = buy(db, o2, qt['quote_id'], t + 'terms-0001')
    ck(rc.get('success'), 'purchase', rc)
    tv = q(db, f"SELECT terms_version FROM public.ca_commerce_purchases WHERE id = '{rc['purchase_id']}'")
    ck(tv == '1', 'terms: the purchase records the service terms version in effect when it was accepted', tv)
    return 'service terms are versioned and recorded on trials and purchases; the trial records the waiver it grants'


def s_free_month_flag(db, t):
    settings(db, checkout=True, visible=True)
    o = person(db, t + 'o3', 5000)
    k = club(db, t + 'k3', o)
    r = quote(db, o, 'club', k, 'capacity_60')
    ck(r.get('success') and r.get('free_month_available') is True,
       'free month: an owner who never had a free month is told before paying', r)
    rpc(db, 'fn_ca_commerce_activate_trial', f"'club','{k}'", o)
    r = quote(db, o, 'club', k, 'capacity_60')
    ck(r.get('success') and r.get('free_month_available') is False, 'free month: once enrolled, the quote says so', r)
    return 'a quote tells an owner who never had a free month that it is available, and never refuses them'


def s_rate_limit(db, t):
    settings(db, checkout=True, visible=True)
    o = person(db, t + 'o4', 5000)
    k = club(db, t + 'k4', o)
    other = person(db, t + 'o4b', 5000)
    k2 = club(db, t + 'k4b', other)
    # 119 quotes already this window (written directly: the limit reads the
    # quote rows themselves), then the 120th and 121st through the door.
    q(db, f"""INSERT INTO public.ca_commerce_quotes (actor_id, payer_id, scope_kind, scope_id, lines, basket_hash, context_hash, catalog_version, gross, net, expires_at)
      SELECT '{o}', '{o}', 'club', '{k}', '[]'::jsonb, 'x', 'x', 'catalog:none', 0, 0, now() FROM generate_series(1,119)""")
    r1 = quote(db, o, 'club', k, 'capacity_60')
    r2 = quote(db, o, 'club', k, 'capacity_60')
    r3 = quote(db, other, 'club', k2, 'capacity_60')
    ck(r1.get('success') and r2.get('error') == 'rate_limited' and r3.get('success'),
       'rate limit: the 121st quote in 10 minutes is refused; another person is unaffected', {'r1': r1.get('error'), 'r2': r2, 'r3': r3.get('error')})
    q(db, f"UPDATE public.ca_commerce_quotes SET created_at = now() - interval '11 minutes' WHERE actor_id = '{o}'")
    ck(quote(db, o, 'club', k, 'capacity_60').get('success'), 'rate limit: the window moves on')
    return 'quotes are limited to 120 per person per 10 minutes'


def s_written_quotes(db, t):
    settings(db, checkout=True, visible=True)
    o = person(db, t + 'o5', 20000)
    k = club(db, t + 'k5', o)
    stranger = person(db, t + 'n5', 20000)
    ks = club(db, t + 'k5s', stranger)
    ck(rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k}',2500,NULL", o).get('error') == 'written_quote_capacity_out_of_range',
       'written quote: 2,500 and below is sold from the catalog')
    ck(rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k}',3000,NULL", stranger).get('error') == 'owner_required',
       'written quote: only the owner asks')
    r = rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k}',3000,'Weekend Leagues For Three Towns'", o)
    ck(r.get('success') and r['written_quote']['state'] == 'requested', 'written quote: the owner asks for 3,000 members', r)
    wid = r['written_quote']['written_quote_id']
    ck(rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k}',4000,NULL", o).get('error') == 'written_quote_already_requested',
       'written quote: one open request per club')
    ck(rpc(db, 'fn_ca_commerce_written_quote_offer', f"'{wid}',3000,9000,14,NULL", o).get('error') == 'staff_required',
       'written quote: only staff offer')
    ck(rpc(db, 'fn_ca_commerce_written_quotes', f"'club','{k}'", stranger).get('error') == 'access_denied',
       'written quote: another owner cannot read it')
    off = rpc(db, 'fn_ca_commerce_written_quote_offer', f"'{wid}',3000,9000,14,'Priced For Three Towns'", h.S)
    ck(off.get('success') and off['written_quote']['state'] == 'offered' and off['written_quote']['sku'].startswith('capacity_wq_'),
       'written quote: staff offer 3,000 members for 9,000 diamonds', off)
    sku = off['written_quote']['sku']
    ck(all(p['sku'] != sku for p in rpc(db, 'fn_ca_commerce_catalog', "'club'", o)['products']),
       'written quote: the offer is not in anyone\'s public catalog')
    ck(any(p['sku'] == sku and p['private_scope_id'] == k for p in rpc(db, 'fn_ca_commerce_catalog', "'club'", h.S)['products']),
       'written quote: staff see the private offer and whose it is')
    ck(quote(db, stranger, 'club', ks, sku).get('error') == 'unknown_sku', 'written quote: another club cannot price the offer')
    ck(q(db, f"SELECT count(*) FROM public.ca_commerce_notices WHERE dedupe_key = 'written-quote-offered:{wid}'") == '1',
       'written quote: the owner is told the offer is ready')
    qt = quote(db, o, 'club', k, sku)
    ck(qt.get('success') and qt['net'] == 9000, 'written quote: the owner prices the offer at 9,000', qt)
    rc = buy(db, o, qt['quote_id'], t + 'wq-000001')
    ck(rc.get('success'), 'written quote: the owner buys it through the ordinary purchase', rc)
    ent = js(db, f"SELECT to_jsonb(e) FROM public.ca_commerce_entitlements e WHERE e.scope_id = '{k}' AND e.sku = '{sku}'")
    ck(ent['kind'] == 'capacity' and ent['capacity'] == 3000, 'written quote: the right carries the offered capacity', ent)
    lst = rpc(db, 'fn_ca_commerce_written_quotes', f"'club','{k}'", o)
    ck(lst['written_quotes'][0]['state'] == 'accepted', 'written quote: the request now reads accepted', lst)
    adm = rpc(db, 'fn_ca_commerce_admission', f"'club','{k}','open_table'", o) if q(db, "SELECT to_regprocedure('public.fn_ca_commerce_admission(text,uuid,text)') IS NOT NULL") == 't' else {'reason': 'entitled'}
    ck(adm.get('reason') in ('entitled',), 'written quote: the bought offer is an operating right like any capacity', adm)
    # An offer that expires unbought cannot be bought.
    k6 = club(db, t + 'k6', o)
    w2 = rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k6}',5000,NULL", o)['written_quote']['written_quote_id']
    off2 = rpc(db, 'fn_ca_commerce_written_quote_offer', f"'{w2}',5000,14000,1,NULL", h.S)
    q(db, f"UPDATE public.ca_commerce_written_quotes SET valid_until = now() - interval '1 minute' WHERE id = '{w2}'")
    r = quote(db, o, 'club', k6, off2['written_quote']['sku'])
    ck(r.get('error') == 'written_quote_expired', 'written quote: an expired offer is not sold', r)
    ck(rpc(db, 'fn_ca_commerce_written_quotes', f"'club','{k6}'", o)['written_quotes'][0]['state'] == 'expired', 'written quote: it reads expired')
    # Decline needs a note; withdraw is the owner's.
    k7 = club(db, t + 'k7', o)
    w3 = rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k7}',8000,NULL", o)['written_quote']['written_quote_id']
    ck(rpc(db, 'fn_ca_commerce_written_quote_decline', f"'{w3}',NULL", h.S).get('error') == 'note_required', 'written quote: a decline says why')
    d = rpc(db, 'fn_ca_commerce_written_quote_decline', f"'{w3}','Tested Capacity Is Not Available At That Size Yet'", h.S)
    ck(d.get('success') and d['written_quote']['state'] == 'declined', 'written quote: staff decline with a note', d)
    k8 = club(db, t + 'k8', o)
    w4 = rpc(db, 'fn_ca_commerce_written_quote_request', f"'club','{k8}',3500,NULL", o)['written_quote']['written_quote_id']
    wd = rpc(db, 'fn_ca_commerce_written_quote_withdraw', f"'{w4}'", o)
    ck(wd.get('success') and wd['written_quote']['state'] == 'withdrawn', 'written quote: the owner withdraws an open request', wd)
    queue = rpc(db, 'fn_ca_commerce_written_quotes', 'NULL,NULL', h.S)
    ck(queue.get('success') and len(queue['written_quotes']) >= 4, 'written quote: staff read the queue', queue)
    ck(rpc(db, 'fn_ca_commerce_written_quotes', 'NULL,NULL', o).get('error') == 'staff_required', 'written quote: only staff read the whole queue')
    return 'written quotes above 2,500 members: asked by the owner, offered or declined by staff, bought and renewed like any capacity'


def s_trial_reviews(db, t):
    settings(db, checkout=True, visible=True)
    o = person(db, t + 'o9', 5000)
    ka = club(db, t + 'k9a', o)
    tr = rpc(db, 'fn_ca_commerce_activate_trial', f"'club','{ka}'", o)
    ck(rpc(db, 'fn_ca_commerce_trial_review_request', f"'club','{ka}','A New Independent Operation In Another City'", o).get('error') == 'trial_still_running',
       'review: nothing to review while the free month runs')
    # The free month ends; a new club inherits the ended trial.
    q(db, f"""UPDATE public.ca_commerce_trials SET trial_start = trial_start - interval '800 hours', trial_end = trial_end - interval '800 hours' WHERE id = '{tr['trial_id']}';
      UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '800 hours', ends_at = ends_at - interval '800 hours' WHERE trial_id = '{tr['trial_id']}';""")
    kb = club(db, t + 'k9b', o)
    tb = rpc(db, 'fn_ca_commerce_activate_trial', f"'club','{kb}'", o)
    ck(tb.get('success') and tb.get('created') is False and tb.get('trial_id') == tr['trial_id'],
       'review: a later club of the same operator inherits the ended trial', tb)
    ck(q(db, f"SELECT public.fn_ca_commerce_in_trial('club','{kb}')") == 'f', 'review: so it has no free days')
    ck(rpc(db, 'fn_ca_commerce_trial_review_request', f"'club','{kb}','Too Short'", o).get('error') == 'statement_too_short',
       'review: the owner explains in at least 20 characters')
    r = rpc(db, 'fn_ca_commerce_trial_review_request', f"'club','{kb}','A New Independent Operation With Its Own Members In Another City'", o)
    ck(r.get('success') and r['review']['state'] == 'requested', 'review: the owner asks', r)
    rid = r['review']['review_id']
    ck(rpc(db, 'fn_ca_commerce_trial_review_request', f"'club','{kb}','A New Independent Operation With Its Own Members In Another City'", o).get('error') == 'trial_review_already_requested',
       'review: one open request per scope')
    ck(rpc(db, 'fn_ca_commerce_trial_review_decide', f"'{rid}',true,NULL", o).get('error') == 'staff_required', 'review: only staff decide')
    d = rpc(db, 'fn_ca_commerce_trial_review_decide', f"'{rid}',true,'Separate Operation Confirmed'", h.S)
    ck(d.get('success') and d['review']['state'] == 'approved' and d['review']['granted_trial_end'], 'review: staff approve', d)
    ck(q(db, f"SELECT public.fn_ca_commerce_in_trial('club','{kb}')") == 't', 'review: the approved club now has its own free month')
    g = js(db, f"SELECT to_jsonb(t) FROM public.ca_commerce_trials t WHERE t.id = '{d['review']['granted_trial_id']}'")
    ck(g['cohort'] == 'review_granted' and g['terms_version'] == 1 and g['waiver_reason'].startswith('Free Operating Month Granted On Review'),
       'review: the grant is recorded as a review grant with its reason', g)
    ck(q(db, f"SELECT count(*) FROM public.ca_commerce_notices WHERE dedupe_key IN ('trial-review-approved:{rid}','trial-reminder-21:{g['id']}','trial-reminder-27:{g['id']}')") == '3',
       'review: the owner is told, and gets the free month\'s reminders')
    ck(q(db, f"SELECT count(*) FROM public.ca_commerce_entitlements WHERE scope_id = '{kb}' AND trial_id = '{g['id']}'") == '1',
       'review: one free-month right for the approved club')
    ck(rpc(db, 'fn_ca_commerce_admission', f"'club','{kb}','open_table'", o).get('reason') == 'trial'
       if q(db, "SELECT to_regprocedure('public.fn_ca_commerce_admission(text,uuid,text)') IS NOT NULL") == 't' else True,
       'review: admission reads the granted free month')
    # A third club still inherits the operator's initial trial, not the grant.
    kc = club(db, t + 'k9c', o)
    tc = rpc(db, 'fn_ca_commerce_activate_trial', f"'club','{kc}'", o)
    ck(tc.get('trial_id') == tr['trial_id'] and q(db, f"SELECT public.fn_ca_commerce_in_trial('club','{kc}')") == 'f',
       'review: a grant is for one club; the next club still inherits the initial trial', tc)
    r = q(db, f"INSERT INTO public.ca_commerce_trials (operator_id, trial_start, trial_end, policy_version, cohort) VALUES ('{o}', now(), now() + interval '1 day', 'x', 'new_operator')", ok=False)
    ck(r.returncode != 0 and 'one_initial_per_operator' in r.stderr, 'review: an operator still has exactly one initial trial', r.stderr[-200:])
    # Decline needs a note, and a club approved once is not approved again.
    ck(rpc(db, 'fn_ca_commerce_trial_review_request', f"'club','{kb}','Another Request After The Grant For The Same Club'", o).get('error') in ('trial_still_running', 'trial_review_already_granted'),
       'review: a club granted once cannot ask again')
    r2 = rpc(db, 'fn_ca_commerce_trial_review_request', f"'club','{kc}','A Third Operation That Is Not Independent At All'", o)
    ck(rpc(db, 'fn_ca_commerce_trial_review_decide', f"'{r2['review']['review_id']}',false,NULL", h.S).get('error') == 'note_required', 'review: a decline says why')
    dd = rpc(db, 'fn_ca_commerce_trial_review_decide', f"'{r2['review']['review_id']}',false,'Same Operation As Your First Club'", h.S)
    ck(dd.get('success') and dd['review']['state'] == 'declined', 'review: staff decline with a note', dd)
    ck(rpc(db, 'fn_ca_commerce_trial_reviews', 'NULL,NULL', o).get('error') == 'staff_required', 'review: only staff read the whole queue')
    ck(len(rpc(db, 'fn_ca_commerce_trial_reviews', f"'club','{kb}'", o).get('reviews', [])) == 1, 'review: the owner reads their own')
    return 'a genuinely new operation can ask for its own free month; staff approve one club at a time or decline with a note'


def s_grants(db, t):
    for fn, args in (('fn_ca_commerce_written_quote_offer', "gen_random_uuid(),3000,1,1,NULL"),
                     ('fn_ca_commerce_trial_review_decide', "gen_random_uuid(),true,NULL")):
        r = q(db, f'SELECT public.{fn}({args})', role='anon', ok=False)
        ck(r.returncode != 0 and 'permission denied' in r.stderr, f'grants: anon cannot call {fn}', r.stderr[-200:])
    r = q(db, 'SELECT count(*) FROM public.ca_commerce_written_quotes', user=h.A, role='authenticated', ok=False)
    ck(r.returncode != 0 and 'permission denied' in r.stderr, 'grants: written quotes are read only through their doors', r.stderr[-200:])
    return 'the new doors keep their grants; the tables are not browser-readable'


SCENARIOS = [s_catalog_visibility, s_terms_and_waiver, s_free_month_flag, s_rate_limit, s_written_quotes, s_trial_reviews, s_grants]


def run_scenarios(db, expect_fail):
    tag = 'r' if expect_fail else 'g'
    for fn in SCENARIOS:
        name = fn.__name__[2:].replace('_', ' ')
        try:
            summary = fn(db, tag)
            err = None
        except (CheckFailed, AssertionError, json.JSONDecodeError, KeyError, TypeError) as e:
            summary, err = None, str(e)
        if expect_fail:
            record(f'RED   {name}: fails without the migration', err is not None, '' if err else 'passed without its fix')
        else:
            record(f'GREEN {summary or name}', err is None, err or '')


def main():
    try:
        h.start_cluster()
        h.load_fixture()
        h.install_registry()
        for m in h.MIGRATIONS:
            r = h.run(h.PSQL + ['-d', TEMPLATE, '-f', str(m)])
            if r.returncode:
                raise SystemExit(f'migration {m.name} failed:\n' + r.stderr)
        h.seed()
        q('postgres', f'CREATE DATABASE {RED} TEMPLATE {TEMPLATE}')
        q('postgres', f'CREATE DATABASE {GREEN} TEMPLATE {TEMPLATE}')

        r = h.run(h.PSQL + ['-d', GREEN, '-f', str(MIGRATION)])
        if r.returncode:
            raise SystemExit('migration failed:\n' + r.stderr)
        record('INSTALL the migration applies in one transaction with its baseline pins and post-conditions', True)
        r = h.run(h.PSQL + ['-d', GREEN, '-f', str(MIGRATION)])
        record('SAFETY a second apply refuses at its baseline pin and changes nothing', r.returncode != 0 and 'commerce baseline changed' in r.stderr, r.stderr[-200:])

        # REGRESSION on the template (the harness's own database), with the
        # migration on top. The RED and GREEN copies were taken before this.
        r = h.run(h.PSQL + ['-d', TEMPLATE, '-f', str(MIGRATION)])
        if r.returncode:
            raise SystemExit('migration failed on the regression database:\n' + r.stderr)
        h.passed = 0
        h.scenarios()
        record(f'REGRESSION the base commerce harness passes {h.passed} scenarios with this migration on top', h.passed >= 159, h.passed)

        run_scenarios(RED, expect_fail=True)
        run_scenarios(GREEN, expect_fail=False)
        print(f'PASS {passed} checks: diamond commerce catalog, terms, written quotes and trial reviews qualified in isolation')
        out = os.environ.get('COMMERCE_COMPLETION_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'migration': MIGRATION.name}, indent=1))
    except (AssertionError, CheckFailed) as e:
        print('FAIL', e, file=sys.stderr)
        sys.exit(1)
    finally:
        h.stop_cluster()


if __name__ == '__main__':
    main()
