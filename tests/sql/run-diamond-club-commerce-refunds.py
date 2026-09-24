#!/usr/bin/env python3
"""Club and union diamond commerce: refunds, notices and catalog lifecycle.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2). Qualifies
supabase/migrations/20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql
in a private, socket-only PostgreSQL cluster. It reuses the cluster, fixture
and identity plumbing of tests/sql/run-diamond-club-commerce.py (imported, not
modified): identity is presented exactly as PostgREST presents it
(request.jwt.claims plus SET ROLE), and the production-captured Diamond Games
fixture supplies the real wallet, journal, lot and register writers.

Migrations applied in order: the installed base, its fixes, then this one.
Nothing here connects to production.

Run:  python3 tests/sql/run-diamond-club-commerce-refunds.py
      COMMERCE_REFUNDS_MIGRATION=<path> swaps the migration under test (used
      to prove each check fails without its fix).
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
_spec = importlib.util.spec_from_file_location('diamond_club_commerce_harness', ROOT / 'tests/sql/run-diamond-club-commerce.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)

# The server binaries: PG_BIN and nothing else from the environment chooses
# anything about the server (same rule as the base harness).
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
if 'PG_BIN' not in os.environ and not Path(PG_BIN, 'initdb').exists():
    _found = sorted(Path('/usr/lib/postgresql').glob('*/bin/initdb'), key=lambda p: int(p.parts[-3]) if p.parts[-3].isdigit() else 0)
    if _found:
        PG_BIN = str(_found[-1].parent)
# A cluster of its own, in a directory it creates and destroys, on a socket
# there and a port of its own, so this runner and the base harness can run side
# by side. h.start_cluster starts it socket-only; the first check below proves
# the server really has listen_addresses= empty.
shutil.rmtree(h.work, ignore_errors=True)
h.work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce-refunds.'))
h.sock = h.work / 'socket'
h.sock.mkdir()
h.data = h.work / 'data'
h.PG_BIN = PG_BIN
h.PORT = '55623'
h.PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(h.sock), '-p', h.PORT, '-U', 'postgres']
MIGRATION = Path(os.environ.get('COMMERCE_REFUNDS_MIGRATION',
                                ROOT / 'supabase/migrations/20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql'))
MIGRATIONS = [ROOT / 'supabase/migrations/20260922143541_club_and_union_diamond_commerce.sql',
              ROOT / 'supabase/migrations/20260924033509_club_and_union_diamond_commerce_fixes.sql',
              MIGRATION]

sql, rpc, check, count, balance = h.sql, h.rpc, h.check, h.count, h.balance
EM_DASH = chr(8212)


def apply_migrations():
    for m in MIGRATIONS:
        r = h.run(h.PSQL + ['-d', h.DB, '-f', str(m)])
        if r.returncode:
            raise SystemExit(f'migration {m.name} failed:\n' + r.stderr)


def svc(q):
    return sql(q, role='service_role')


def js(q):
    return json.loads(sql(q))


def claim():
    return int(svc(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{uuid.uuid4()}',10)"))


def claim_token():
    tok = str(uuid.uuid4())
    n = int(svc(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{tok}',10)"))
    return tok, n


def execute(mid, tok):
    return json.loads(svc(f"SELECT public.fn_ca_commerce_execute_renewal('{mid}','{tok}')"))


def run_refunds():
    return json.loads(svc(f"SELECT public.fn_ca_commerce_execute_approved_refunds('{uuid.uuid4()}',10)"))


def deliver():
    return int(svc("SELECT public.fn_ca_commerce_deliver_due_notices(200)"))


def title_case(text):
    words = re.findall(r"[A-Za-z][A-Za-z']*", text or '')
    return EM_DASH not in (text or '') and all(w[0].isupper() for w in words)


def refund_request(user, purchase, line, reason, key, details=None):
    d = 'NULL' if details is None else "'" + details.replace("'", "''") + "'"
    return rpc('fn_ca_commerce_refund_request', f"'{purchase}',{line},'{reason}','{key}',{d}", user)


def decide(user, request_id, approve, amount=None, note=None):
    a = 'NULL' if amount is None else str(amount)
    n = 'NULL' if note is None else "'" + note.replace("'", "''") + "'"
    return rpc('fn_ca_commerce_refund_decide', f"'{request_id}',{'true' if approve else 'false'},{a},{n}", user)


# Synthetic identities (a cluster of their own; no production account).
O1 = 'a1000000-0000-4000-8000-0000000000a1'   # standalone owner, two clubs
O2 = 'a2000000-0000-4000-8000-0000000000a2'   # refund payer, later transfers K2
O3 = 'a3000000-0000-4000-8000-0000000000a3'   # club owner inside the union
O4 = 'a4000000-0000-4000-8000-0000000000a4'   # thin wallet: the 72-hour check
O5 = 'a5000000-0000-4000-8000-0000000000a5'   # wallet at its ceiling: owed refund
SP = 'b1000000-0000-4000-8000-0000000000b1'   # union owner and sponsor
HO = 'c1000000-0000-4000-8000-0000000000c1'   # a horse that owns a club
NW = 'c2000000-0000-4000-8000-0000000000c2'   # the club's next owner
ST1 = 'f1000000-0000-4000-8000-0000000000f1'  # platform staff
ST2 = 'f2000000-0000-4000-8000-0000000000f2'  # a second staff member
K1 = '31000000-0000-4000-8000-000000000001'
K1B = '31000000-0000-4000-8000-00000000001b'
K2 = '31000000-0000-4000-8000-000000000002'
K3 = '31000000-0000-4000-8000-000000000003'
K4 = '31000000-0000-4000-8000-000000000004'
K5 = '31000000-0000-4000-8000-000000000005'
KS = '31000000-0000-4000-8000-00000000000f'
KH = '31000000-0000-4000-8000-0000000000c1'
KR = '31000000-0000-4000-8000-0000000000e1'   # retired
KP = '31000000-0000-4000-8000-0000000000e2'   # platform
UN = '41000000-0000-4000-8000-000000000001'


def seed():
    sql(f"""
    INSERT INTO auth.users(id) VALUES ('{O1}'),('{O2}'),('{O3}'),('{O4}'),('{O5}'),('{SP}'),('{HO}'),('{NW}'),('{ST1}'),('{ST2}');
    INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role,is_horse) VALUES
      ('{O1}','refunds_owner_one',5000,5000,'user',false),('{O2}','refunds_owner_two',3000,3000,'user',false),
      ('{O3}','refunds_owner_three',100,100,'user',false),('{O4}','refunds_owner_four',800,800,'user',false),
      ('{O5}','refunds_owner_five',1000,1000,'user',false),('{SP}','refunds_sponsor',5000,5000,'user',false),
      ('{HO}','refunds_horse_owner',0,0,'user',true),('{NW}','refunds_next_owner',40,40,'user',false),
      ('{ST1}','refunds_staff_one',1000,1000,'admin',false),('{ST2}','refunds_staff_two',0,0,'admin',false);
    INSERT INTO public.unions(id,name,owner_id,slug) VALUES ('{UN}','Refunds Union','{SP}','refunds-union');
    INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union,lifecycle_status,is_platform,asset) VALUES
      ('{K1}','Refunds Club One','{O1}',NULL,0,0,false,'active',false,'chips'),
      ('{K1B}','Refunds Club One Annex','{O1}',NULL,0,0,false,'active',false,'chips'),
      ('{K2}','Refunds Club Two','{O2}',NULL,0,0,false,'active',false,'chips'),
      ('{K3}','Refunds Club Three','{O3}','{UN}',0,0,false,'active',false,'chips'),
      ('{K4}','Refunds Club Four','{O4}',NULL,0,0,false,'active',false,'chips'),
      ('{K5}','Refunds Club Five','{O5}',NULL,0,0,false,'active',false,'chips'),
      ('{KS}','Refunds Staff Club','{ST1}',NULL,0,0,false,'active',false,'chips'),
      ('{KH}','Refunds Horse Club','{HO}',NULL,0,0,false,'active',false,'chips'),
      ('{KR}','Refunds Retired Club','{O1}',NULL,0,0,false,'retired',false,'chips'),
      ('{KP}','Refunds Platform Club','{O1}',NULL,0,0,false,'active',true,'diamonds');
    INSERT INTO public.union_clubs(union_id,club_id) VALUES ('{UN}','{K3}');
    INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES
      ('{K1}','{O1}','owner','active',0),('{K1B}','{O1}','owner','active',0),('{K2}','{O2}','owner','active',0),
      ('{K3}','{O3}','owner','active',0),('{K4}','{O4}','owner','active',0),('{K5}','{O5}','owner','active',0),
      ('{KS}','{ST1}','owner','active',0),('{KH}','{HO}','owner','active',0);
    INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued,consumed,refunded,arena_reserved) VALUES
      ('{O1}',gen_random_uuid(),1000,0,0,150);
    """)


def expire_all_trials():
    sql("""UPDATE public.ca_commerce_trials SET trial_start = trial_start - interval '800 hours', trial_end = trial_end - interval '800 hours';
           UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '800 hours', ends_at = ends_at - interval '800 hours' WHERE source = 'trial'""")


def install_facts():
    check(sql('SHOW listen_addresses') == '' and sql('SHOW unix_socket_directories') == str(h.sock),
          'the cluster is private and socket-only (listen_addresses= empty, its own temporary socket directory)')
    pol = js("SELECT jsonb_agg(jsonb_build_object('kind',kind,'version',version,'title',title,'body',body) ORDER BY kind) FROM public.ca_commerce_policies")
    check(len(pol) == 3 and {p['kind'] for p in pol} == {'refund', 'renewal_terms', 'renewal_ceiling'} and all(p['version'] == 1 for p in pol)
          and all(title_case(p['title']) and title_case(p['body'].replace('{product}', 'X').replace('{ceiling}', '1').replace('{payer}', 'X')) for p in pol),
          'policy v1: refund policy, renewal terms and the ceiling sentence are installed in Title Case with no em dash', pol)
    refund = [p for p in pol if p['kind'] == 'refund'][0]['body']
    check(all(s in refund for s in ('Within 24 Hours Of Purchase', 'Unused Whole Days', 'Pro Rata', 'Free Month Is Never Charged', 'Refunded To The Sponsor')),
          'refund policy v1 states all four rules: error within 24 hours, pro rata unused days, the free month, the sponsor', refund)
    r = sql("UPDATE public.ca_commerce_policies SET body = body || ' Edited.' WHERE kind='refund'", ok=False)
    check(r.returncode != 0 and 'Never Edited' in r.stderr, 'a policy version is never edited in place')
    pr = rpc('fn_ca_commerce_policies', 'NULL', O1)
    check(pr['success'] and len(pr['policies']) == 3 and all(p['current'] for p in pr['policies']), 'owners read the policy texts they accept, with the current version marked')
    for fn, args in (('fn_ca_commerce_execute_approved_refunds', f"'{uuid.uuid4()}',1"), ('fn_ca_commerce_refundable', f"'{uuid.uuid4()}',0"),
                     ('fn_ca_commerce_refund_policy', f"'{uuid.uuid4()}',0,'platform_defect',now()")):
        r = sql(f"SELECT public.{fn}({args})", ok=False, user=ST1, role='authenticated')
        check(r.returncode != 0 and 'permission denied' in r.stderr, f'{fn} is not browser-executable, not even by staff')


def heartbeat_and_launch_cohort():
    r = rpc('fn_ca_commerce_activate_launch_cohort', 'now()', O1)
    check(r.get('error') == 'staff_required', 'launch cohort: the existing staff guard still answers first', r)
    r = rpc('fn_ca_commerce_activate_launch_cohort', "now() - interval '2 hours'", ST1)
    check(r.get('error') == 'cohort_must_be_prospective', 'launch cohort: the existing prospective guard still answers', r)
    r = rpc('fn_ca_commerce_activate_launch_cohort', 'now()', ST1)
    check(r.get('error') == 'consumer_not_running' and count('public.ca_commerce_trials') == 0,
          'launch cohort: refused in JSON while the consumer has never woken, and nothing is enrolled', r)
    claim()
    hb = sql("SELECT extract(epoch FROM (clock_timestamp() - consumer_heartbeat_at)) FROM public.ca_commerce_settings WHERE id=1")
    check(hb != '' and 0 <= float(hb) < 5, 'the consumer heartbeat is stamped by the claim door on every call, due work or not', hb)
    sql("UPDATE public.ca_commerce_settings SET consumer_heartbeat_at = now() - interval '11 minutes' WHERE id=1")
    r = rpc('fn_ca_commerce_activate_launch_cohort', 'now()', ST1)
    check(r.get('error') == 'consumer_not_running' and count('public.ca_commerce_trials') == 0,
          'launch cohort: refused when the last consumer wake is older than ten minutes', r)
    claim()
    eligible = js("""SELECT jsonb_build_object(
        'scopes', (SELECT count(*) FROM public.clubs c WHERE c.owner_id IS NOT NULL AND COALESCE(c.lifecycle_status,'active') <> 'retired' AND NOT COALESCE(c.is_platform,false))
                + (SELECT count(*) FROM public.unions u WHERE u.owner_id IS NOT NULL),
        'owners', (SELECT count(DISTINCT o) FROM (SELECT owner_id o FROM public.clubs c WHERE c.owner_id IS NOT NULL AND COALESCE(c.lifecycle_status,'active') <> 'retired' AND NOT COALESCE(c.is_platform,false)
                    UNION SELECT owner_id FROM public.unions WHERE owner_id IS NOT NULL) x),
        'wallets', (SELECT COALESCE(sum(diamonds),0) FROM public.profiles), 'tx', (SELECT count(*) FROM public.diamond_transactions))""")
    eff = sql("SELECT (now() + interval '1 hour')::text")
    r = rpc('fn_ca_commerce_activate_launch_cohort', f"'{eff}'::timestamptz", ST1)
    check(r.get('success') and r['scopes_enrolled'] == eligible['scopes'] and r['trials_created'] == eligible['owners']
          and r['notices_recorded'] == eligible['scopes'], 'launch cohort: every eligible scope is enrolled, one trial per operator', {'r': r, 'eligible': eligible})
    check(count("(SELECT operator_id FROM public.ca_commerce_trials GROUP BY operator_id HAVING count(*) > 1) d") == 0
          and count(f"public.ca_commerce_trials WHERE operator_id='{O1}'") == 1
          and count(f"public.ca_commerce_trial_scopes s JOIN public.ca_commerce_trials t ON t.id=s.trial_id WHERE t.operator_id='{O1}'") == 2,
          'launch cohort: an operator with two clubs holds one trial covering both')
    starts = js(f"""SELECT jsonb_build_object('bad_start', count(*) FILTER (WHERE trial_start <> '{eff}'::timestamptz),
                  'bad_len', count(*) FILTER (WHERE trial_end - trial_start <> interval '720 hours')) FROM public.ca_commerce_trials WHERE cohort='launch_cohort'""")
    check(starts == {'bad_start': 0, 'bad_len': 0}, 'launch cohort: prospective, every trial starts at the recorded effective moment and lasts 720 hours', starts)
    check(count(f"public.ca_commerce_trial_scopes WHERE scope_id IN ('{KR}','{KP}')") == 0, 'launch cohort: retired and platform clubs are not enrolled')
    check(count(f"public.ca_commerce_trial_scopes WHERE scope_id='{KH}'") == 1
          and count(f"public.ca_commerce_notices WHERE user_id='{HO}' AND kind='club_commerce_launch'") == 1,
          'horses are players: a horse-owned club is enrolled and its owner is told like anyone else')
    notes = js("SELECT jsonb_agg(jsonb_build_object('u',n.user_id,'t',n.title,'m',n.message,'d',n.delivered_at IS NOT NULL)) FROM public.ca_commerce_notices n WHERE kind='club_commerce_launch'")
    end_text = sql(f"SELECT to_char(trial_end AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') FROM public.ca_commerce_trials WHERE operator_id='{O1}'")
    o1 = [n for n in notes if n['u'] == O1]
    check(len(notes) == eligible['scopes'] and all(n['d'] and title_case(n['t']) and title_case(n['m']) for n in notes)
          and count("public.notifications WHERE type='club_commerce_launch'") == eligible['scopes']
          and len(o1) == 2 and all(end_text in n['m'] and 'Nothing Is Charged Unless You Authorize' in n['m'] and 'Club And Union Diamond Costs' in n['m'] for n in o1),
          'launch cohort: every enrolled owner is told, in Title Case, the free month, its end date, that nothing is charged unless they authorize, and where to manage it', o1)
    after = js("SELECT jsonb_build_object('wallets',(SELECT COALESCE(sum(diamonds),0) FROM public.profiles),'tx',(SELECT count(*) FROM public.diamond_transactions))")
    check(after == {'wallets': eligible['wallets'], 'tx': eligible['tx']}, 'launch cohort: no wallet moves and no journal row is written')
    claim()
    r2 = rpc('fn_ca_commerce_activate_launch_cohort', f"'{eff}'::timestamptz", ST1)
    check(r2.get('success') and r2['scopes_enrolled'] == 0 and r2['trials_created'] == 0 and r2['notices_recorded'] == 0
          and count("public.ca_commerce_notices WHERE kind='club_commerce_launch'") == eligible['scopes'],
          'launch cohort: a replay enrols nobody twice and tells nobody twice', r2)
    expire_all_trials()


def consent_funds_and_price_notices():
    global ENT_K1, MANDATE_K1
    q = h.quote(O1, 'club', K1, 'capacity_100', renewal_max=900)
    b = h.buy(O1, q['quote_id'], 'o1-capacity-0001')
    check(b.get('success') and b['charged_this_attempt'] == 700, 'fixture: O1 buys a 100-member period with renewal authorized at checkout', b)
    ENT_K1 = b['lines'][0]['entitlement_id']
    m = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m WHERE entitlement_id='{ENT_K1}'")
    MANDATE_K1 = m['id']
    check(m['terms_version'] == 1 and m['ceiling_text_version'] == 1,
          'consent: a renewal authorized at checkout records the terms and ceiling text versions in effect', m)
    funds = js(f"SELECT COALESCE(jsonb_agg(jsonb_build_object('due',due_at,'delivered',delivered_at,'k',dedupe_key) ORDER BY created_at), '[]') FROM public.ca_commerce_notices WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{MANDATE_K1}'")
    due_ok = sql(f"SELECT (due_at = (SELECT ends_at FROM public.ca_commerce_entitlements WHERE id='{ENT_K1}') - interval '72 hours')::text FROM public.ca_commerce_notices WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{MANDATE_K1}'")
    check(len(funds) == 1 and funds[0]['delivered'] is None and due_ok == 'true',
          'funds notice: authorizing a renewal records one balance check due 72 hours before the due date, not yet delivered', funds)

    s = rpc('fn_ca_commerce_set_renewal', f"'{ENT_K1}',true,800,NULL,NULL", O1)
    expected = 'I Authorize Club Arena To Renew Up To 100 Approved Members For Up To 800 Diamonds Per Period, Paid From My Diamond Balance, Until I Cancel.'
    check(s.get('success') and s['terms_version'] == 1 and s['ceiling_text_version'] == 1 and s['accepted_ceiling_text'] == expected,
          'consent: re-authorizing records the versions and returns the exact ceiling sentence accepted', s)
    st = rpc('fn_ca_commerce_scope_status', f"'club','{K1}'", O1)
    ren = [e['renewal'] for e in st['entitlements'] if e['id'] == ENT_K1][0]
    check(ren['accepted_ceiling_text'] == expected and ren['terms_version'] == 1, 'consent: the status shows the accepted terms version and the exact ceiling sentence', ren)
    check(count(f"public.ca_commerce_notices WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{MANDATE_K1}'") == 2,
          'funds notice: a re-authorization records its own balance check')

    # The checkout authorization's check is superseded by the newer one.
    sql(f"UPDATE public.ca_commerce_notices SET due_at = now() - interval '1 minute' WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{MANDATE_K1}'")
    before_n = count('public.notifications')
    deliver()
    sup = js(f"SELECT jsonb_agg(suppressed_reason ORDER BY created_at) FROM public.ca_commerce_notices WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{MANDATE_K1}'")
    check(sup == ['mandate_no_longer_due', 'funds_sufficient'] and count('public.notifications') == before_n
          and count("public.notifications WHERE type='club_commerce_renewal_funds'") == 0,
          'funds notice: a covered balance is suppressed on record (funds_sufficient) and a superseded check is suppressed, nothing sent', sup)
    # Cancel, then re-authorize at the same due date: a fresh check exists.
    rpc('fn_ca_commerce_set_renewal', f"'{ENT_K1}',false,NULL,NULL,NULL", O1)
    rpc('fn_ca_commerce_set_renewal', f"'{ENT_K1}',true,800,NULL,NULL", O1)
    check(count(f"public.ca_commerce_notices WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{MANDATE_K1}' AND suppressed_at IS NULL AND delivered_at IS NULL") == 1,
          'funds notice: re-authorizing after a cancellation at the same due date records a fresh balance check')

    # O4: a thin wallet. 800 - 700 leaves 100 against a 700 renewal.
    q = h.quote(O4, 'club', K4, 'capacity_100', renewal_max=700)
    b4 = h.buy(O4, q['quote_id'], 'o4-capacity-0001')
    check(b4.get('success') and balance(O4) == 100, 'fixture: O4 buys a period and is left with 100 diamonds', b4)
    m4 = sql(f"SELECT id FROM public.ca_commerce_renewal_mandates WHERE entitlement_id='{b4['lines'][0]['entitlement_id']}'")
    sql(f"UPDATE public.ca_commerce_notices SET due_at = now() - interval '1 minute' WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{m4}'")
    n = deliver()
    note = js(f"SELECT to_jsonb(n) FROM public.notifications n WHERE user_id='{O4}' AND type='club_commerce_renewal_funds'")
    due_text = sql(f"SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') FROM public.ca_commerce_renewal_mandates WHERE id='{m4}'")
    check(n == 1 and note['title'] == 'Add Diamonds Before Your Renewal' and 'Costs 700 Diamonds' in note['message'] and 'Your Balance Is 100 Diamonds' in note['message']
          and 'Add At Least 600 Diamonds' in note['message'] and due_text in note['message'] and title_case(note['title']) and title_case(note['message'])
          and note['data']['shortfall'] == 600,
          'funds notice: a short balance is delivered with the price, the balance, the shortfall and the deadline, in Title Case', note)
    check(deliver() == 0 and count(f"public.notifications WHERE user_id='{O4}' AND type='club_commerce_renewal_funds'") == 1,
          'funds notice: delivery is idempotent')

    # A higher price is announced to every payer it affects, with their ceiling.
    d = rpc('fn_ca_commerce_price_draft', "'capacity_100',800,'flat',NULL,'Price increase authority for the notice test'", ST1)
    rpc('fn_ca_commerce_price_validate', f"'{d['price_version_id']}'", ST1)
    eff = sql("SELECT (now() + interval '1 hour')::text")
    p = rpc('fn_ca_commerce_price_publish', f"'{d['price_version_id']}','{eff}'::timestamptz", ST1)
    pn = js("SELECT COALESCE(jsonb_object_agg(user_id, jsonb_build_object('t',title,'m',message,'p',payload,'d',delivered_at IS NOT NULL)), '{}') FROM public.ca_commerce_notices WHERE kind='club_commerce_price_change'")
    eff_text = sql(f"SELECT to_char('{eff}'::timestamptz AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM')")
    check(p.get('success') and p['price_change_notices'] == 2 and set(pn) == {O1, O4}
          and all(v['d'] and v['p']['old_price'] == 700 and v['p']['new_price'] == 800 and 'From 700 To 800 Diamonds' in v['m'] and eff_text in v['m']
                  and title_case(v['t']) and title_case(v['m']) for v in pn.values())
          and 'Ceiling Is 800 Diamonds' in pn[O1]['m'] and 'Renewals Continue' in pn[O1]['m']
          and 'Ceiling Is 700 Diamonds' in pn[O4]['m'] and 'Waits For Your Approval' in pn[O4]['m'] and pn[O4]['p']['above_ceiling'],
          'price notice: a higher price is announced to every payer holding a renewal on it, naming old and new price, the date and their ceiling', pn)
    d2 = rpc('fn_ca_commerce_price_draft', "'capacity_100',650,'flat',NULL,'Price decrease authority for the notice test'", ST1)
    rpc('fn_ca_commerce_price_validate', f"'{d2['price_version_id']}'", ST1)
    p2 = rpc('fn_ca_commerce_price_publish', f"'{d2['price_version_id']}',now() + interval '2 hours'", ST1)
    check(p2.get('success') and p2['price_change_notices'] == 0 and count("public.ca_commerce_notices WHERE kind='club_commerce_price_change'") == 2,
          'price notice: a price that does not rise sends nothing', p2)

    # The owner-paid renewal still renews, and its authorization carries
    # forward with the consent it was given (not re-created as a new one).
    orig = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m WHERE id='{MANDATE_K1}'")
    sql(f"""UPDATE public.ca_commerce_entitlements SET starts_at = now() - interval '720 hours' - interval '1 minute', ends_at = now() - interval '1 minute' WHERE id='{ENT_K1}';
            UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '1 minute' WHERE id='{MANDATE_K1}'""")
    tok, n = claim_token()
    before = balance(O1)
    ex = execute(MANDATE_K1, tok)
    check(n >= 1 and ex.get('outcome') == 'renewed' and int(ex['charged']) == 700 and balance(O1) == before - 700,
          'owner renewal: an owner-paid mandate still renews at the price in effect, once', ex)
    carried = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m JOIN public.ca_commerce_entitlements e ON e.id = m.entitlement_id WHERE e.purchase_id='{ex['purchase_id']}'")
    check(carried['state'] == 'authorized' and carried['accepted_at'] == orig['accepted_at'] and carried['accepted_by'] == O1
          and carried['terms_version'] == orig['terms_version'] and carried['ceiling_text_version'] == orig['ceiling_text_version']
          and carried['max_diamonds'] == 800 and carried['sponsorship_id'] is None,
          'consent: the authorization carries forward with the consent it was given, its versions and its original acceptance', {'orig': orig, 'carried': carried})
    check(count(f"public.ca_commerce_notices WHERE kind='club_commerce_renewal_funds' AND payload->>'mandate_id'='{carried['id']}'") == 1,
          'funds notice: a carried-forward authorization records its own balance check for the next due date')

    # Versioning: a new ceiling text applies to new consent only.
    sql("INSERT INTO public.ca_commerce_policies(kind,version,title,body) VALUES ('renewal_ceiling',2,'Renewal Authorization','I Authorize Renewal Of {product} Up To {ceiling} Diamonds Per Period From {payer} Until I Cancel.')")
    st = rpc('fn_ca_commerce_scope_status', f"'club','{K1}'", O1)
    old_ren = [e['renewal'] for e in st['entitlements'] if e['renewal'] and e['renewal']['mandate_id'] == carried['id']][0]
    s2 = rpc('fn_ca_commerce_set_renewal', f"'{carried['entitlement_id']}',true,850,NULL,NULL", O1)
    check(old_ren['ceiling_text_version'] == 1 and old_ren['accepted_ceiling_text'].startswith('I Authorize Club Arena To Renew')
          and s2['ceiling_text_version'] == 2 and s2['accepted_ceiling_text'] == 'I Authorize Renewal Of Up To 100 Approved Members Up To 850 Diamonds Per Period From My Diamond Balance Until I Cancel.',
          'consent: a newer text version governs new consent only; the accepted sentence of earlier consent is preserved', {'old': old_ren, 'new': s2})


def sponsored_renewals():
    sp = rpc('fn_ca_commerce_sponsorship_set', f"'{UN}',NULL,1000,NULL,NULL,NULL,false", SP)
    check(sp.get('success'), 'fixture: the union owner records a 1,000 diamond sponsorship', sp)
    q = rpc('fn_ca_commerce_quote', f"'club','{K3}','{h.lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", SP)
    b = h.buy(SP, q['quote_id'], 'sponsor-k3-0001')
    check(b.get('success') and b['charged_this_attempt'] == 500, 'fixture: the sponsor buys capacity for a covered club', b)
    ent = b['lines'][0]['entitlement_id']
    r = rpc('fn_ca_commerce_set_renewal', f"'{ent}',true,500,NULL,NULL", O3)
    check(r.get('error') == 'payer_required' and count(f"public.ca_commerce_renewal_mandates WHERE entitlement_id='{ent}'") == 0,
          'sponsored renewal: the club owner still cannot put the sponsor\'s diamonds behind a mandate', r)
    r = rpc('fn_ca_commerce_set_renewal', f"'{ent}',true,500,NULL,NULL", O1)
    check(r.get('error') == 'owner_required', 'sponsored renewal: an unrelated account cannot authorize it', r)
    before_sp, before_o3 = balance(SP), balance(O3)
    m = rpc('fn_ca_commerce_set_renewal', f"'{ent}',true,500,NULL,NULL", SP)
    check(m.get('success') and m['state'] == 'authorized' and m['payer_id'] == SP and m['sponsorship_id'] == sp['sponsorship_id']
          and 'Within My Sponsorship Budget' in m['accepted_ceiling_text'] and m['terms_version'] == 1,
          'sponsored renewal: the sponsor authorizes renewal of the right their sponsorship paid for, within that sponsorship', m)
    check(balance(SP) == before_sp and balance(O3) == before_o3, 'sponsored renewal: authorizing charges nobody')

    def due_now(entitlement, mandate):
        sql(f"""UPDATE public.ca_commerce_entitlements SET starts_at = now() - interval '720 hours' - interval '1 minute', ends_at = now() - interval '1 minute' WHERE id='{entitlement}';
                UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '1 minute' WHERE id='{mandate}'""")
    due_now(ent, m['mandate_id'])
    tok, _ = claim_token()
    ex = execute(m['mandate_id'], tok)
    check(ex.get('outcome') == 'renewed' and int(ex['charged']) == 500 and balance(SP) == before_sp - 500 and balance(O3) == before_o3,
          'sponsored renewal: charged to the sponsor, never to the club owner', ex)
    p = js(f"SELECT to_jsonb(p) FROM public.ca_commerce_purchases p WHERE id='{ex['purchase_id']}'")
    check(p['sponsorship_id'] == sp['sponsorship_id'] and p['payer_id'] == SP and p['kind'] == 'renewal'
          and int(sql(f"SELECT committed FROM public.ca_commerce_sponsorships WHERE id='{sp['sponsorship_id']}'")) == 1000
          and count(f"public.ca_commerce_entitlements WHERE purchase_id='{ex['purchase_id']}' AND source='sponsor'") == 1,
          'sponsored renewal: the receipt names the sponsorship and the budget counts the charge', p)
    carried = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m JOIN public.ca_commerce_entitlements e ON e.id=m.entitlement_id WHERE e.purchase_id='{ex['purchase_id']}'")
    check(carried['state'] == 'authorized' and carried['payer_id'] == SP and carried['sponsorship_id'] == sp['sponsorship_id'],
          'sponsored renewal: the authorization carries forward with its sponsorship', carried)
    # The budget is spent: the next renewal stops at a visible attention state.
    due_now(carried['entitlement_id'], carried['id'])
    tok, _ = claim_token()
    before_sp = balance(SP)
    ex2 = execute(carried['id'], tok)
    check(ex2.get('outcome') == 'needs_attention' and ex2.get('reason') == 'sponsorship_budget_exceeded' and balance(SP) == before_sp and balance(O3) == before_o3,
          'sponsored renewal: the existing budget check applies; beyond it nothing is charged to anyone', ex2)
    # Budget raised, renewal re-authorized, then the sponsorship revoked.
    rpc('fn_ca_commerce_sponsorship_set', f"'{UN}',NULL,3000,NULL,NULL,'{sp['sponsorship_id']}',false", SP)
    m3 = rpc('fn_ca_commerce_set_renewal', f"'{carried['entitlement_id']}',true,500,NULL,NULL", SP)
    rpc('fn_ca_commerce_sponsorship_set', f"'{UN}',NULL,NULL,NULL,NULL,'{sp['sponsorship_id']}',true", SP)
    sql(f"UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '1 minute' WHERE id='{carried['id']}'")
    tok, _ = claim_token()
    ex3 = execute(carried['id'], tok)
    check(m3.get('state') == 'authorized' and ex3.get('outcome') == 'needs_attention' and ex3.get('reason') == 'sponsorship_not_effective'
          and balance(SP) == before_sp and balance(O3) == before_o3,
          'sponsored renewal: a revoked sponsorship never renews, and the club owner is not charged instead', ex3)
    r = rpc('fn_ca_commerce_set_renewal', f"'{carried['entitlement_id']}',true,500,NULL,NULL", SP)
    check(r.get('error') == 'sponsorship_not_effective', 'sponsored renewal: a revoked sponsorship cannot be re-authorized', r)
    global SPONSORSHIP
    SPONSORSHIP = sp['sponsorship_id']


def refunds():
    # R1: a purchase made in error, refunded in full through the consumer.
    q = h.quote(O2, 'club', K2, 'club_insurance_module')
    b = h.buy(O2, q['quote_id'], 'o2-insurance-0001')
    check(b.get('success') and b['charged_this_attempt'] == 200, 'fixture: O2 buys the insurance module', b)
    pid = b['purchase_id']
    r = refund_request(O1, pid, 0, 'purchase_in_error', 'o1-steals-0001')
    check(r.get('error') == 'payer_required', 'refund request: only the payer may ask for their diamonds back', r)
    r = refund_request(O2, pid, 0, 'changed_my_mind', 'o2-req-bad-0001')
    check(r.get('error') == 'invalid_reason' and 'purchase_in_error' in r['allowed'], 'refund request: an unknown reason is a named refusal', r)
    r = refund_request(O2, pid, 0, 'purchase_in_error', 'short')
    check(r.get('error') == 'request_key_required', 'refund request: a request key is required', r)
    r = refund_request(O2, str(uuid.uuid4()), 0, 'purchase_in_error', 'o2-missing-0001')
    check(r.get('error') == 'purchase_not_found', 'refund request: an unknown purchase is a JSON refusal, never a raw error', r)
    before = balance(O2)
    rq = refund_request(O2, pid, 0, 'purchase_in_error', 'o2-req-0001', 'I bought the module for the wrong club')
    req = rq.get('request', {})
    check(rq.get('success') and not rq['is_replay'] and req['state'] == 'requested' and req['policy_amount'] == 200 and req['policy_basis'] == 'error_full'
          and req['policy_version'] == 1 and req['policy_detail']['right_started'] is True and balance(O2) == before,
          'refund request: the server computes the policy amount (in full, within 24 hours) and records it; nothing moves yet', rq)
    rid = req['request_id']
    n = js(f"SELECT to_jsonb(n) FROM public.notifications n WHERE user_id='{O2}' AND type='club_commerce_refund_request'")
    check(n['title'] == 'Refund Request Received' and '200 Diamonds' in n['message'] and title_case(n['message']), 'refund request: the payer is told, in Title Case', n)
    rr = refund_request(O2, pid, 0, 'purchase_in_error', 'o2-req-0001')
    check(rr.get('success') and rr['is_replay'] and rr['request']['request_id'] == rid, 'refund request: the same key replays the same request', rr)
    rr = refund_request(O2, pid, 0, 'platform_defect', 'o2-req-0001')
    check(rr.get('error') == 'request_key_reused', 'refund request: the same key with another reason refuses', rr)
    rr = refund_request(O2, pid, 0, 'platform_defect', 'o2-req-0002')
    check(rr.get('error') == 'request_already_open' and rr['request']['request_id'] == rid, 'refund request: one open request per purchase line', rr)
    st = rpc('fn_ca_commerce_scope_status', f"'club','{K2}'", O2)
    check(any(x['request_id'] == rid and x['state'] == 'requested' for x in st['refund_requests'])
          and st['balance_breakdown']['pending_refunds'] == 200 and st['balance_breakdown']['pending_requested'] == 200
          and st['balance_breakdown']['available'] == before,
          'owner reads: the scope status shows the open request and counts it as pending, apart from the available balance', st['balance_breakdown'])
    rec = [x for x in rpc('fn_ca_commerce_receipts', f"'club','{K2}'", O2) if x['purchase_id'] == pid][0]
    check(len(rec['refund_requests']) == 1 and rec['refund_requests'][0]['state'] == 'requested'
          and rec['rights'][0]['refundable'] == 200 and rec['rights'][0]['state'] == 'effective',
          'owner reads: the receipt shows its refund request and the refundable remainder of each right', rec)

    r = decide(O2, rid, True)
    check(r.get('error') == 'staff_required', 'refund decision: platform staff decide, not the owner', r)
    r = decide(ST1, rid, True, amount=500)
    check(r.get('error') == 'exceeds_refundable' and r['refundable'] == 200, 'refund decision: the amount may not exceed the refundable remainder', r)
    r = decide(ST1, rid, False)
    check(r.get('error') == 'note_required', 'refund decision: a decline says why', r)
    ap = decide(ST1, rid, True)
    check(ap.get('success') and ap['request']['state'] == 'approved' and ap['request']['approved_amount'] == 200 and balance(O2) == before,
          'refund decision: staff approve at the policy amount; nothing moves until the consumer executes it', ap)
    n = js(f"SELECT to_jsonb(n) FROM public.notifications n WHERE user_id='{O2}' AND type='club_commerce_refund_decision'")
    check(n['title'] == 'Refund Approved' and title_case(n['message']), 'refund decision: the payer is told', n)
    qq = rpc('fn_ca_commerce_refund_queue', "'approved',50", ST2)
    check(qq.get('success') and [x['request_id'] for x in qq['requests']] == [rid] and rpc('fn_ca_commerce_refund_queue', 'NULL,NULL', O2).get('error') == 'staff_required',
          'refund queue: staff read requests by state; an owner cannot read the queue', qq)
    r = decide(ST2, rid, True)
    check(r.get('success') and r['is_replay'], 'refund decision: a repeated approval is a replay', r)
    r = decide(ST2, rid, False, note='Changed my mind')
    check(r.get('error') == 'already_decided', 'refund decision: a decided request cannot be reversed', r)
    r = rpc('fn_ca_commerce_refund', f"'{pid}',0,200,'Staff browser refund attempt','browser-refund-0001'", ST1)
    check(r.get('error') == 'refund_requires_service_route', 'the exact-value core keeps its JSON answer for browser sessions', r)

    ex = run_refunds()
    refund = js(f"SELECT to_jsonb(r) FROM public.ca_commerce_refunds r WHERE purchase_id='{pid}'")
    reqrow = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rid}'")
    check(ex.get('success') and ex['refunded'] == 1 and balance(O2) == before + 200 and refund['request_key'] == rid and refund['gross'] == 200
          and reqrow['state'] == 'refunded' and reqrow['refund_id'] == refund['id'],
          'refund execution: the consumer executes the approved request through the exact core, with the request id as its key', ex)
    tx = js(f"SELECT to_jsonb(t) FROM public.diamond_transactions t WHERE id='{refund['diamond_tx_id']}'")
    mint = js(f"SELECT jsonb_agg(jsonb_build_object('a',action,'n',amount)) FROM public.ca_mint_ledger WHERE diamond_tx_id='{refund['diamond_tx_id']}'")
    check(tx['amount'] == 200 and tx['issuance_class'] == 'refund' and mint == [{'a': 'mint', 'n': 200}]
          and count(f"public.ca_commerce_entitlements WHERE purchase_id='{pid}' AND state='revoked'") == 1,
          'refund execution: one exact journal row, one exact issuance, and the fully refunded right is revoked', {'tx': tx, 'mint': mint})
    ex2 = run_refunds()
    check(ex2.get('claimed') == 0 and balance(O2) == before + 200 and count(f"public.ca_commerce_refunds WHERE purchase_id='{pid}'") == 1,
          'refund execution: exactly once; the next wake finds nothing to do', ex2)
    check(count(f"public.notifications WHERE user_id='{O2}' AND type='club_commerce_refund'") == 1, 'refund execution: the payer is told the refund was paid')

    # R2: pro rata unused whole days.
    q = h.quote(O2, 'club', K2, 'capacity_60')
    b2 = h.buy(O2, q['quote_id'], 'o2-capacity-0001')
    pid2 = b2['purchase_id']
    ent2 = b2['lines'][0]['entitlement_id']
    sql(f"SET session_replication_role = replica; UPDATE public.ca_commerce_purchases SET created_at = now() - interval '25 hours' WHERE id='{pid2}'")
    r = refund_request(O2, pid2, 0, 'purchase_in_error', 'o2-late-0001')
    check(r.get('error') == 'error_window_passed' and count(f"public.ca_commerce_refund_requests WHERE purchase_id='{pid2}'") == 0,
          'refund policy: after 24 hours an error purchase is not refundable in full', r)
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = now() - interval '252 hours', ends_at = now() + interval '468 hours' WHERE id='{ent2}'")
    rq2 = refund_request(O2, pid2, 0, 'service_unavailable', 'o2-prorata-0001', 'Tables would not open for two days')
    check(rq2.get('success') and rq2['request']['policy_basis'] == 'pro_rata_unused_days' and rq2['request']['policy_amount'] == 316
          and rq2['request']['policy_detail']['unused_days'] == 19,
          'refund policy: the unused whole days of the period, pro rata: 19 of 30 days of 500 is 316', rq2)
    ap2 = decide(ST2, rq2['request']['request_id'], True, amount=300, note='Two days of outage confirmed')
    check(ap2.get('success') and ap2['request']['approved_amount'] == 300, 'refund decision: staff may approve an amount of their own within the remainder', ap2)
    before = balance(O2)
    ex = run_refunds()
    check(ex['refunded'] == 1 and balance(O2) == before + 300 and count(f"public.ca_commerce_entitlements WHERE id='{ent2}' AND state='effective'") == 1,
          'refund execution: a partial refund pays exactly the approved amount and leaves the right in place', ex)
    # R3: a decline, told in Title Case.
    rq3 = refund_request(O2, pid2, 0, 'platform_defect', 'o2-defect-0001')
    check(rq3.get('success') and rq3['request']['policy_amount'] == 200, 'refund policy: the pro rata amount is capped at what is left to refund (500 - 300)', rq3)
    dc = decide(ST1, rq3['request']['request_id'], False, note='duplicate of an earlier request.')
    msg = sql(f"SELECT message FROM public.notifications WHERE user_id='{O2}' AND type='club_commerce_refund_decision' ORDER BY created_at DESC LIMIT 1")
    check(dc['request']['state'] == 'declined' and 'Note From Platform Staff: Duplicate Of An Earlier Request.' in msg and title_case(msg)
          and run_refunds()['claimed'] == 0,
          'refund decision: a decline is recorded, the payer is told why in Title Case, and nothing executes', msg)
    # Staff never decide their own request.
    q = h.quote(ST1, 'club', KS, 'club_insurance_module')
    bs = h.buy(ST1, q['quote_id'], 'st1-insurance-0001')
    rs = refund_request(ST1, bs['purchase_id'], 0, 'purchase_in_error', 'st1-req-0001')
    r = decide(ST1, rs['request']['request_id'], True)
    check(r.get('error') == 'cannot_decide_own_request', 'refund decision: a staff member cannot decide their own request', r)
    decide(ST2, rs['request']['request_id'], False, note='Test fixture closed')

    # R4: the wallet cannot receive the refund yet: owed, visible, paid later.
    q = h.quote(O5, 'club', K5, 'club_insurance_module')
    b5 = h.buy(O5, q['quote_id'], 'o5-insurance-0001')
    rq5 = refund_request(O5, b5['purchase_id'], 0, 'purchase_in_error', 'o5-req-0001')
    decide(ST1, rq5['request']['request_id'], True)
    cur = balance(O5)
    svc(f"SELECT public.add_diamonds_to_balance('{O5}',{2147483600 - cur},'purchase','Fixture: approach the wallet ceiling','ceiling-{uuid.uuid4()}')")
    ex = run_refunds()
    row = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rq5['request']['request_id']}'")
    check(ex['owed'] == 1 and row['state'] == 'owed' and row['owed_reason'] in ('diamond_balance_limit', 'wallet_cannot_receive_yet') and balance(O5) == 2147483600
          and count(f"public.ca_commerce_refunds WHERE purchase_id='{b5['purchase_id']}'") == 0,
          'owed refund: a refund the wallet cannot receive is not lost and not paid partly; it is owed with its reason', row)
    n = js(f"SELECT jsonb_agg(to_jsonb(n)) FROM public.notifications n WHERE user_id='{O5}' AND type='club_commerce_refund_owed'")
    check(len(n) == 1 and ('Diamond Balance Limit' in n[0]['message'] or 'Wallet Cannot Receive Yet' in n[0]['message']) and title_case(n[0]['title']) and title_case(n[0]['message']),
          'owed refund: the payer is told once, in words', n)
    st = rpc('fn_ca_commerce_scope_status', f"'club','{K5}'", O5)
    check(st['balance_breakdown']['owed_refunds'] == 200 and st['balance_breakdown']['pending_refunds'] == 200
          and any(x['state'] == 'owed' and x['owed_reason'] in ('diamond_balance_limit', 'wallet_cannot_receive_yet') for x in st['refund_requests']),
          'owed refund: the status shows the owed refund and its reason, apart from the available balance', st['balance_breakdown'])
    ex = run_refunds()
    row = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rq5['request']['request_id']}'")
    check(ex['owed'] == 1 and row['attempts'] == 2 and count(f"public.notifications WHERE user_id='{O5}' AND type='club_commerce_refund_owed'") == 1,
          'owed refund: the owning consumer attempts it again on its next wake without telling the payer twice', row)
    svc(f"SELECT public.deduct_diamonds('{O5}',2147483600-2000,'Fixture: leave the ceiling','fixture_spend','fixture_spend','{{}}'::jsonb,'ceiling-out-{uuid.uuid4()}',0)")
    before = balance(O5)
    ex = run_refunds()
    ex_again = run_refunds()
    check(ex['refunded'] == 1 and ex_again['claimed'] == 0 and balance(O5) == before + 200
          and count(f"public.ca_commerce_refunds WHERE purchase_id='{b5['purchase_id']}'") == 1
          and js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rq5['request']['request_id']}'")['state'] == 'refunded',
          'owed refund: paid exactly once as soon as the wallet can receive it', ex)

    # R5: a sponsored purchase refunds to the sponsor.
    sp2 = rpc('fn_ca_commerce_sponsorship_set', f"'{UN}',NULL,1000,NULL,NULL,NULL,false", SP)
    q = rpc('fn_ca_commerce_quote', f"'club','{K3}','{h.lines('club_insurance_module')}'::jsonb,'{sp2['sponsorship_id']}',NULL,'purchase'", SP)
    bsp = h.buy(SP, q['quote_id'], 'sponsor-insurance-0001')
    r = refund_request(O3, bsp['purchase_id'], 0, 'purchase_in_error', 'o3-req-0001')
    check(r.get('error') == 'payer_required', 'sponsored refund: the club owner cannot claim the sponsor\'s refund', r)
    rsp = refund_request(SP, bsp['purchase_id'], 0, 'purchase_in_error', 'sp-req-0001')
    decide(ST1, rsp['request']['request_id'], True)
    before_sp, before_o3 = balance(SP), balance(O3)
    committed = int(sql(f"SELECT committed FROM public.ca_commerce_sponsorships WHERE id='{sp2['sponsorship_id']}'"))
    run_refunds()
    check(balance(SP) == before_sp + 200 and balance(O3) == before_o3
          and int(sql(f"SELECT committed FROM public.ca_commerce_sponsorships WHERE id='{sp2['sponsorship_id']}'")) == committed - 200,
          'sponsored refund: the sponsor who paid is refunded, the club owner is not, and the budget is released', rsp)


def former_owner_reads():
    mine = {x['purchase_id'] for x in rpc('fn_ca_commerce_receipts', 'NULL,NULL', O2)}
    sql(f"""UPDATE public.clubs SET owner_id='{NW}' WHERE id='{K2}';
            UPDATE public.club_members SET role='player' WHERE club_id='{K2}' AND user_id='{O2}';
            INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{K2}','{NW}','owner','active',0)""")
    st = rpc('fn_ca_commerce_scope_status', f"'club','{K2}'", O2)
    rec = rpc('fn_ca_commerce_receipts', 'NULL,NULL', O2)
    rec_scope = rpc('fn_ca_commerce_receipts', f"'club','{K2}'", O2)
    check(st.get('error') == 'access_denied' and {x['purchase_id'] for x in rec} == mine and len(mine) == 2
          and {x['purchase_id'] for x in rec_scope} == mine and all(x['refund_requests'] for x in rec_scope),
          'former owner: receipts they paid for, with their refund requests, remain readable after losing the club; its status does not', {'st': st, 'n': len(rec)})
    new_rec = rpc('fn_ca_commerce_receipts', f"'club','{K2}'", NW)
    new_st = rpc('fn_ca_commerce_scope_status', f"'club','{K2}'", NW)
    check(new_rec == [] and new_st.get('success') and new_st['refund_requests'] == []
          and new_st['balance_breakdown']['available'] == balance(NW) and new_st['balance_breakdown']['pending_refunds'] == 0,
          "former owner: the new owner sees none of the former owner's receipts, refund requests or wallet figures", new_st.get('balance_breakdown'))
    staff = rpc('fn_ca_commerce_scope_status', f"'club','{K2}'", ST1)
    check(staff.get('success') and len(staff['refund_requests']) == 3, 'staff see every refund request on a scope')
    renew_payer = [r for x in rpc('fn_ca_commerce_receipts', 'NULL,NULL', SP) for r in x['rights'] if r['renewal']]
    other = [r for x in rpc('fn_ca_commerce_receipts', 'NULL,NULL', O3) for r in x['rights']]
    check(renew_payer and all(r['renewal']['sponsorship_id'] for r in renew_payer) and other == [],
          'receipts: a renewal is shown to its payer only; a beneficiary who paid nothing reads no receipt', renew_payer)
    bb = rpc('fn_ca_commerce_scope_status', f"'club','{K1}'", O1)['balance_breakdown']
    check(bb['reserved'] == 150 and bb['available'] == balance(O1), 'owner reads: reserved is what open purchased lots hold for custody, apart from available', bb)


def catalog_lifecycle_and_comparison():
    d = rpc('fn_ca_commerce_price_draft', "'capacity_250',1600,'flat',NULL,'Lifecycle authority for capacity 250'", ST1)
    check(d.get('success') and d['status'] == 'draft' and sql(f"SELECT status FROM public.ca_commerce_price_versions WHERE id='{d['price_version_id']}'") == 'draft',
          'catalog: a new price version starts as a draft', d)
    r = rpc('fn_ca_commerce_price_publish', f"'{d['price_version_id']}',NULL", ST1)
    check(r.get('error') == 'not_validated', 'catalog: a draft cannot be published', r)
    r = rpc('fn_ca_commerce_price_validate', f"'{d['price_version_id']}'", O1)
    check(r.get('error') == 'staff_required', 'catalog: validation is staff only', r)
    v = rpc('fn_ca_commerce_price_validate', f"'{d['price_version_id']}'", ST1)
    check(v.get('success') and v['status'] == 'validated', 'catalog: staff validate a draft', v)
    r = rpc('fn_ca_commerce_price_validate', f"'{d['price_version_id']}'", ST1)
    check(r.get('error') == 'not_draft', 'catalog: only a draft is validated', r)
    p = rpc('fn_ca_commerce_price_publish', f"'{d['price_version_id']}',NULL", ST1)
    ev = js(f"SELECT jsonb_agg(kind ORDER BY id) FROM public.ca_commerce_events WHERE reference_id='{d['price_version_id']}'")
    check(p.get('success') and ev == ['price_drafted', 'price_validated', 'price_published'], 'catalog: draft, validation and publication are each audited', ev)
    for args, err in (("'capacity_250',1600,'per_unit',NULL", 'price_rule_does_not_fit_product'),
                      ("'union_insurance_module',200,'per_unit_capped',NULL", 'cap_required'),
                      ("'union_insurance_module',200,'per_unit_capped',100", 'cap_below_unit_price'),
                      ("'capacity_250',0,'flat',NULL", 'zero_price_not_allowed'),
                      ("'union_back_office',1000,'flat',NULL", 'price_rule_does_not_fit_product')):
        dd = rpc('fn_ca_commerce_price_draft', f"{args},'Lifecycle authority for a failing draft'", ST1)
        vv = rpc('fn_ca_commerce_price_validate', f"'{dd['price_version_id']}'", ST1)
        check(vv.get('error') == err and sql(f"SELECT status FROM public.ca_commerce_price_versions WHERE id='{dd['price_version_id']}'") == 'draft',
              f'catalog: validation refuses {err} and the version stays a draft', vv)
    rt = rpc('fn_ca_commerce_price_retire', f"'{dd['price_version_id']}',NULL", ST1)
    check(rt.get('success') and rt['status'] == 'retired', 'catalog: a failed draft is withdrawn', rt)
    dv = rpc('fn_ca_commerce_price_draft', "'capacity_500',2600,'flat',NULL,'Lifecycle authority for capacity 500'", ST1)
    rpc('fn_ca_commerce_price_validate', f"'{dv['price_version_id']}'", ST1)
    rt = rpc('fn_ca_commerce_price_retire', f"'{dv['price_version_id']}',NULL", ST1)
    check(rt.get('success') and rt['status'] == 'retired' and rpc('fn_ca_commerce_price_publish', f"'{dv['price_version_id']}',NULL", ST1).get('error') == 'not_validated',
          'catalog: a retired validated version can never be published', rt)
    cur = sql("SELECT id FROM public.ca_commerce_price_versions WHERE sku='capacity_2500' AND status='published'")
    r = rpc('fn_ca_commerce_price_retire', f"'{cur}',NULL", ST1)
    check(r.get('error') == 'supported_product_needs_a_price', 'catalog: the only price of a supported product cannot be retired', r)
    r = rpc('fn_ca_commerce_price_retire', f"'{cur}',now() - interval '2 hours'", ST1)
    check(r.get('error') in ('retirement_is_prospective', 'supported_product_needs_a_price'), 'catalog: retirement is never backdated', r)
    rpc('fn_ca_commerce_product_support', "'capacity_2500',false", ST1)
    r = rpc('fn_ca_commerce_price_retire', f"'{cur}',now() - interval '2 hours'", ST1)
    check(r.get('error') == 'retirement_is_prospective', 'catalog: retirement is prospective', r)
    r1 = rpc('fn_ca_commerce_price_retire', f"'{cur}',now() + interval '1 hour'", ST1)
    row = js(f"SELECT jsonb_build_object('s',status,'future',effective_to > now()) FROM public.ca_commerce_price_versions WHERE id='{cur}'")
    check(r1.get('success') and row == {'s': 'published', 'future': True}, 'catalog: a prospective retirement keeps the price in effect until its date', row)
    r2 = rpc('fn_ca_commerce_price_retire', f"'{cur}',NULL", ST1)
    cat = rpc('fn_ca_commerce_catalog', "'club'", O1)
    check(r2.get('success') and r2['status'] == 'retired' and [x['price'] for x in cat['products'] if x['sku'] == 'capacity_2500'] == [None]
          and rpc('fn_ca_commerce_price_retire', f"'{cur}',NULL", ST1).get('is_replay'),
          'catalog: a retirement now takes the price out of the catalog, and a repeat is a replay', r2)
    check(count(f"public.ca_commerce_events WHERE kind='price_retired' AND reference_id='{cur}'") == 2, 'catalog: each retirement step is audited')

    pv = sql("SELECT id FROM public.ca_commerce_price_versions WHERE sku='capacity_60' AND status='published' AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())")
    args = f"'capacity_60','Competitor Club Software','https://example.com/pricing',9.23,'USD per 30 days for 100 members',now() - interval '1 day','1,200 of 13,000 diamonds bought at 99.99 USD; whole package cash measured separately','{pv}'"
    r = rpc('fn_ca_commerce_comparison_record', args, O1)
    check(r.get('error') == 'staff_required', 'comparison: evidence is recorded by staff only', r)
    r = rpc('fn_ca_commerce_comparison_record', args.replace('https://', 'http://'), ST1)
    check(r.get('error') == 'invalid_source_url', 'comparison: evidence names a secure source address', r)
    e = rpc('fn_ca_commerce_comparison_record', args, ST1)
    cat = rpc('fn_ca_commerce_catalog', "'club'", O1)
    check(e.get('success') and not e['verified'] and all(not x['price']['comparison_verified'] for x in cat['products'] if x['price']),
          'comparison: recorded evidence alone sets no badge', e)
    r = rpc('fn_ca_commerce_comparison_verify', f"'{e['evidence_id']}','{pv}'", ST1)
    check(r.get('error') == 'second_staff_member_required' and sql(f"SELECT comparison_verified::text FROM public.ca_commerce_price_versions WHERE id='{pv}'") == 'false',
          'comparison: the recorder cannot verify their own evidence', r)
    r = rpc('fn_ca_commerce_comparison_verify', f"'{e['evidence_id']}','{pv}'", O2)
    check(r.get('error') == 'staff_required', 'comparison: verification is staff only', r)
    vr = rpc('fn_ca_commerce_comparison_verify', f"'{e['evidence_id']}','{pv}'", ST2)
    cat = rpc('fn_ca_commerce_catalog', "'club'", O1)
    verified = {x['sku'] for x in cat['products'] if x['price'] and x['price']['comparison_verified']}
    ev = js(f"SELECT comparison_evidence FROM public.ca_commerce_price_versions WHERE id='{pv}'")
    check(vr.get('success') and verified == {'capacity_60'} and ev['verified_by'] == ST2 and ev['recorded_by'] == ST1 and ev['source_url'] == 'https://example.com/pricing',
          "comparison: a second staff member's verification sets comparison_verified on that version only, with the evidence attached", {'verified': verified, 'ev': ev})
    check(rpc('fn_ca_commerce_comparison_verify', f"'{e['evidence_id']}','{pv}'", ST2).get('is_replay'), 'comparison: a repeated verification is a replay')


def conservation():
    c = js("""SELECT jsonb_build_object(
        'purchases_net', (SELECT COALESCE(SUM(net),0) FROM public.ca_commerce_purchases),
        'burns', (SELECT COALESCE(SUM(m.amount),0) FROM public.ca_mint_ledger m JOIN public.ca_commerce_purchases p ON p.diamond_tx_id = m.diamond_tx_id WHERE m.action='burn'),
        'refunds_gross', (SELECT COALESCE(SUM(gross),0) FROM public.ca_commerce_refunds),
        'mints', (SELECT COALESCE(SUM(m.amount),0) FROM public.ca_mint_ledger m JOIN public.ca_commerce_refunds r ON r.diamond_tx_id = m.diamond_tx_id WHERE m.action='mint'),
        'executed', (SELECT COALESCE(SUM(approved_amount),0) FROM public.ca_commerce_refund_requests WHERE state='refunded'),
        'linked', (SELECT COALESCE(SUM(r.gross),0) FROM public.ca_commerce_refunds r JOIN public.ca_commerce_refund_requests q ON q.refund_id = r.id))""")
    c = {k: float(v) for k, v in c.items()}
    check(c['purchases_net'] == c['burns'] and c['refunds_gross'] == c['mints'] and c['executed'] == c['linked'] == c['refunds_gross'],
          'conservation: every paid diamond has one retirement, every refund one exact issuance, every executed request one linked refund', c)
    bad = count("public.ca_commerce_notices WHERE delivered_at IS NOT NULL AND (position(chr(8212) in title || message) > 0)")
    check(bad == 0, 'no delivered commerce notice carries an em dash')
    check(count("pg_proc WHERE proname LIKE 'fn_ca_commerce%' AND (proname ~* '(repair|backpay|redrive|catchup|backfill|heal|reconcile|sweep)')") == 0,
          'no band-aid: nothing in the commerce boundary repairs its outcomes later')


def main():
    try:
        h.start_cluster()
        h.load_fixture()
        apply_migrations()
        seed()
        install_facts()
        heartbeat_and_launch_cohort()
        consent_funds_and_price_notices()
        sponsored_renewals()
        refunds()
        former_owner_reads()
        catalog_lifecycle_and_comparison()
        conservation()
        print(f'PASS {h.passed} scenarios: diamond commerce refunds, notices and catalog lifecycle qualified in isolation')
    except AssertionError as e:
        print('FAIL', e, file=sys.stderr)
        sys.exit(1)
    finally:
        h.stop_cluster()


if __name__ == '__main__':
    main()
