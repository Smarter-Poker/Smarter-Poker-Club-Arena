#!/usr/bin/env python3
"""Club and union diamond commerce: isolated PostgreSQL qualification.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), Phase 8. Builds a private,
socket-only cluster, loads the production-captured Diamond Games fixture
(real deduct_diamonds, add_diamonds_to_balance, purchased-lot consumption,
register-following trigger, DR6 writer allowlist), applies the commerce
migration and exercises the applicable D-series scenarios with real
transactions and two-connection races. Nothing here connects to production.

Run:  PG_BIN=/usr/lib/postgresql/17/bin python3 tests/sql/run-diamond-club-commerce.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
if 'PG_BIN' not in os.environ and not Path(PG_BIN, 'initdb').exists():
    # A Linux runner: the newest installed server's binaries.
    _found = sorted(Path('/usr/lib/postgresql').glob('*/bin/initdb'), key=lambda p: int(p.parts[-3]) if p.parts[-3].isdigit() else 0)
    if _found:
        PG_BIN = str(_found[-1].parent)
PORT = '55611'
DB = 'diamond_club_commerce_probe'
MIGRATIONS = [ROOT / 'supabase/migrations/20260922143541_club_and_union_diamond_commerce.sql',
              ROOT / 'supabase/migrations/20260924033509_club_and_union_diamond_commerce_fixes.sql',
              ROOT / 'supabase/migrations/20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql']
# 20260924102056 (admission in shadow) amends doors this fixture set does not
# carry; tests/sql/run-diamond-club-commerce-admission.py applies it over the
# captured live doors.
MIGRATION = MIGRATIONS[-1]
FIXTURE = ROOT / 'tests/fixtures/accounting-delivery/diamond-games'

work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce.'))
sock = work / 'socket'
sock.mkdir()
data = work / 'data'
PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', PORT, '-U', 'postgres']
ENV = {**{k: v for k, v in os.environ.items() if not k.startswith('PG')},
       'PGOPTIONS': '-c statement_timeout=90000 -c lock_timeout=3000 -c timezone=UTC'}
started = False
passed = 0
results = []


def run(cmd, **kw):
    return subprocess.run(cmd, text=True, capture_output=True, env=ENV, **kw)


def initdb_as():
    # A root runner (containers) must hand the cluster to an unprivileged user.
    if os.geteuid() == 0:
        try:
            import pwd
            pw = pwd.getpwnam('postgres')
            os.chown(work, pw.pw_uid, pw.pw_gid)
            os.chown(sock, pw.pw_uid, pw.pw_gid)
            return ['runuser', '-u', 'postgres', '--']
        except KeyError:
            raise SystemExit('run as an unprivileged user or with a postgres account')
    return []


def start_cluster():
    global started
    pre = initdb_as()
    r = run(pre + [PG_BIN + '/initdb', '-D', str(data), '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'postgres'])
    if r.returncode:
        raise SystemExit(r.stderr)
    r = run(pre + [PG_BIN + '/pg_ctl', '-D', str(data), '-l', str(work / 'server.log'), '-w',
                   '-o', f"-k {sock} -p {PORT} -c listen_addresses= -c max_connections=20", 'start'])
    if r.returncode:
        raise SystemExit(r.stderr + open(work / 'server.log').read())
    started = True


def stop_cluster():
    if started:
        pre = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
        run(pre + [PG_BIN + '/pg_ctl', '-D', str(data), '-m', 'immediate', 'stop'])
    shutil.rmtree(work, ignore_errors=True)


def sql(q, ok=True, db=DB, user=None, role=None):
    """One statement (or script) in one transaction. Optional synthetic identity."""
    # Present identity exactly as PostgREST does: the whole claims object in
    # request.jwt.claims AND the database role switched to the JWT role. The
    # production guards read both (fn_is_service_context reads the claims
    # object; EXECUTE grants follow the role), so a harness that only set the
    # legacy per-claim settings ran every call as an unguarded superuser.
    prefix = ''
    if user:
        prefix += f"SELECT set_config('request.jwt.claim.sub','{user}',false);"
    if role:
        prefix += f"SELECT set_config('request.jwt.claim.role','{role}',false);"
    if user or role:
        claims = json.dumps({k: v for k, v in (('sub', user), ('role', role or 'authenticated')) if v})
        prefix += f"SELECT set_config('request.jwt.claims','{claims}',false); SET ROLE {role or 'authenticated'};"
    r = run(PSQL + ['-d', db, '-At', '-c', prefix + q])
    if ok and r.returncode:
        raise AssertionError(f'{q[:200]}\n{r.stderr}')
    if not ok:
        return r
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ''


def rpc(fn, args, user, role='authenticated'):
    q = f"SELECT public.{fn}({args})"
    out = sql(q, user=user, role=role)
    return json.loads(out)


def check(cond, label, detail=''):
    global passed
    if not cond:
        results.append({'test': label, 'result': 'FAIL', 'detail': str(detail)[:500]})
        raise AssertionError(f'FAIL {label} {detail}')
    passed += 1
    results.append({'test': label, 'result': 'PASS'})
    print('PASS', label, flush=True)


def load_fixture():
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;', db='postgres')
    sql(f'CREATE DATABASE {DB} OWNER postgres', db='postgres')
    files = ['schema.sql', 'auth.sql', 'functions.sql', 'constraints.sql', 'policy.sql', 'seed.sql', 'triggers.sql']
    r = run(PSQL + ['-d', DB] + sum([['-f', str(FIXTURE / f)] for f in files], []))
    if r.returncode:
        raise SystemExit(r.stderr)
    union_clubs = (FIXTURE / 'union-clubs-schema.sql').read_text()
    version = int(sql("SHOW server_version_num"))
    if version < 170000:
        union_clubs = union_clubs.replace(', MAINTAIN', '')
    r = run(PSQL + ['-d', DB], input=union_clubs)
    if r.returncode:
        raise SystemExit(r.stderr)
    # Relations the commerce migration touches that the captured fixture does not carry.
    sql("""
    CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, title text, message text,
      data jsonb, read boolean DEFAULT false, is_read boolean DEFAULT false, action_url text, metadata jsonb, link text, created_at timestamptz DEFAULT now());
    CREATE TABLE public.feature_pricing(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feature text UNIQUE, diamond_cost integer, usage_type text, description text);
    INSERT INTO public.feature_pricing(feature,diamond_cost,usage_type,description) VALUES ('club_creation',100,'permanent','Create Club'),('rabbit_hunt',5,'per_use','Rabbit Hunt');
    CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role IN ('admin','superadmin','god')) $$;
    """)


def apply_migration():
    # The installed migration, then its forward fix, in order: the path
    # production takes. Each file is its own transaction.
    for m in MIGRATIONS:
        r = run(PSQL + ['-d', DB, '-f', str(m)])
        if r.returncode:
            raise SystemExit(f'migration {m.name} failed:\n' + r.stderr)


# Synthetic identities.
A = 'a0000000-0000-4000-8000-00000000000a'   # standalone club owner
B = 'b0000000-0000-4000-8000-00000000000b'   # union owner, owns C2
D = 'd0000000-0000-4000-8000-00000000000d'   # owns C3 inside B's union
P = 'e0000000-0000-4000-8000-00000000000e'   # a player
S = 'f0000000-0000-4000-8000-00000000000f'   # platform staff
X = 'c0000000-0000-4000-8000-00000000000c'   # unrelated owner of C4
C1 = '10000000-0000-4000-8000-000000000001'
C2 = '10000000-0000-4000-8000-000000000002'
C3 = '10000000-0000-4000-8000-000000000003'
C4 = '10000000-0000-4000-8000-000000000004'
U = '20000000-0000-4000-8000-000000000001'


def seed():
    sql(f"""
    INSERT INTO auth.users(id) VALUES ('{A}'),('{B}'),('{D}'),('{P}'),('{S}'),('{X}');
    INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role) VALUES
      ('{A}','commerce_owner_a',1000,1000,'user'),('{B}','commerce_union_b',5000,5000,'user'),('{D}','commerce_owner_d',100,100,'user'),
      ('{P}','commerce_player',0,0,'user'),('{S}','commerce_staff',0,0,'admin'),('{X}','commerce_owner_x',3000,3000,'user');
    INSERT INTO public.unions(id,name,owner_id,slug) VALUES ('{U}','Commerce Union','{B}','commerce-union');
    INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union) VALUES
      ('{C1}','Commerce Club One','{A}',NULL,0,0,false),
      ('{C2}','Commerce Club Two','{B}','{U}',0,0,false),
      ('{C3}','Commerce Club Three','{D}','{U}',0,0,false),
      ('{C4}','Commerce Club Four','{X}',NULL,0,0,false);
    INSERT INTO public.union_clubs(union_id,club_id) VALUES ('{U}','{C2}'),('{U}','{C3}');
    INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES
      ('{C1}','{A}','owner','active',0),('{C1}','{P}','player','active',0),
      ('{C2}','{B}','owner','active',0),('{C3}','{D}','owner','active',0),('{C4}','{X}','owner','active',0);
    -- A purchased 600 of A's 1,000 diamonds; the other 400 are promotional.
    INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued,consumed,refunded) VALUES ('{A}',gen_random_uuid(),600,0,0);
    """)


def balance(u):
    return int(sql(f"SELECT diamonds FROM public.profiles WHERE id='{u}'"))


def count(q):
    return int(sql(f"SELECT count(*) FROM {q}"))


def lines(sku, qty=1):
    return json.dumps([{'sku': sku, 'quantity': qty}]).replace("'", "''")


def quote(user, kind, scope, sku, qty=1, sponsorship=None, renewal_max=None, purchase_kind='purchase'):
    sp = f"'{sponsorship}'::uuid" if sponsorship else 'NULL'
    rm = str(renewal_max) if renewal_max is not None else 'NULL'
    return rpc('fn_ca_commerce_quote', f"'{kind}','{scope}','{lines(sku, qty)}'::jsonb,{sp},{rm},'{purchase_kind}'", user)


def buy(user, quote_id, key, kind='purchase'):
    return rpc('fn_ca_commerce_purchase', f"'{quote_id}','{key}','{kind}'", user)


def mint_rows(tx):
    return json.loads(sql(f"SELECT COALESCE(jsonb_agg(jsonb_build_object('action',action,'amount',amount,'holder',holder_id,'op',op_id)),'[]') FROM public.ca_mint_ledger WHERE diamond_tx_id='{tx}'"))


def scenarios():
    # ---- Install-state facts (D29, catalog) -------------------------------
    check(count("public.feature_pricing WHERE feature='club_creation'") == 0, 'D29 the orphaned club_creation price row is removed at install')
    cat = rpc('fn_ca_commerce_catalog', "'club'", A)
    supported = [p for p in cat['products'] if p['supported']]
    check(all(p['price'] is not None for p in supported) and all(not p['price']['comparison_verified'] for p in supported),
          'D26 every supported product has a published price and no comparison claim')
    check(all(p['price'] is None for p in cat['products'] if not p['supported']), 'D80 unsupported offerings carry no published price')
    check(int(sql("SELECT count(*) FROM public.ca_commerce_price_versions WHERE status='published'")) == 9, 'catalog v1 publishes nine prices')
    check(count("public.feature_pricing f JOIN public.ca_commerce_products p ON p.sku = f.feature") == 0,
          'D67 no operator product is reachable through the personal feature door')

    # ---- D74 immutability -------------------------------------------------
    r = sql("UPDATE public.ca_commerce_price_versions SET diamonds=1 WHERE sku='capacity_100' AND status='published'", ok=False)
    check(r.returncode != 0 and 'Cannot Change In Place' in r.stderr, 'D74 a published price cannot be edited in place')
    r = sql("DELETE FROM public.ca_commerce_price_versions WHERE sku='capacity_100'", ok=False)
    check(r.returncode != 0, 'D74 a price version is never deleted')

    # ---- D19 direct helper access ----------------------------------------
    r = sql(f"SET ROLE authenticated; SELECT public.fn_ca_commerce_purchase_impl('{A}',gen_random_uuid(),'k','purchase')", ok=False, user=A)
    check(r.returncode != 0 and 'permission denied' in r.stderr, 'D19 the internal purchase helper is not browser-executable')
    r = sql("SET ROLE authenticated; SELECT public.fn_ca_commerce_claim_due_renewals(gen_random_uuid(),1)", ok=False, user=A)
    check(r.returncode != 0 and 'permission denied' in r.stderr, 'D19 the renewal consumer door is service-only')
    r = sql("SET ROLE authenticated; SELECT * FROM public.ca_commerce_purchases", ok=False, user=A)
    check(r.returncode != 0 and 'permission denied' in r.stderr, 'D19 commerce tables are not browser-readable')
    st = rpc('fn_ca_commerce_scope_status', f"'club','{C1}'", X)
    check(st.get('error') == 'access_denied', 'D19 cross-tenant scope status is refused')
    q = quote(X, 'club', C1, 'capacity_100')
    check(q.get('error') == 'owner_required', 'D19 a non-owner cannot quote for another club')

    # ---- D01 / D47 trial ---------------------------------------------------
    t1 = rpc('fn_ca_commerce_activate_trial', f"'club','{C1}'", A)
    check(t1['success'] and t1['created'] and not t1['replay'], 'D01 trial activation creates one grant')
    t2 = rpc('fn_ca_commerce_activate_trial', f"'club','{C1}'", A)
    check(t2['success'] and t2['replay'] and t2['trial_end'] == t1['trial_end'], 'D01 trial activation replay returns the same grant')
    check(count(f"public.ca_commerce_trials WHERE operator_id='{A}'") == 1 and balance(A) == 1000, 'D01 no duplicate trial and no diamond issuance')
    hours = sql(f"SELECT extract(epoch FROM (trial_end - trial_start))/3600 FROM public.ca_commerce_trials WHERE operator_id='{A}'")
    check(float(hours) == 720.0, 'D51 the trial is a fixed 720-hour interval')
    r = rpc('fn_ca_commerce_activate_trial', f"'club','{C1}'", P)
    check(r.get('error') == 'owner_required', 'D19 only the owner activates a trial')
    # A recreated club by the same operator inherits the end time.
    C1b = '10000000-0000-4000-8000-00000000001b'
    sql(f"INSERT INTO public.clubs(id,name,owner_id,chip_treasury,promo_balance,is_union) VALUES ('{C1b}','Commerce Club One Again','{A}',0,0,false)")
    t3 = rpc('fn_ca_commerce_activate_trial', f"'club','{C1b}'", A)
    check(t3['success'] and not t3['created'] and t3['enrolled'] and t3['trial_end'] == t1['trial_end'], 'D47 a later scope of the same operator inherits the original trial end')
    adm = rpc('fn_ca_commerce_admission', f"'club','{C1}','open_table'", A)
    check(adm['allowed'] and adm['reason'] == 'trial', 'D02 included operating actions are admitted during the trial')
    st = rpc('fn_ca_commerce_scope_status', f"'club','{C1}'", A)
    trial_ent = [e for e in st['entitlements'] if e['kind'] == 'trial_operating']
    check(len(trial_ent) == 1 and trial_ent[0]['net_paid'] == 0, 'D02 the trial right records zero paid principal')

    # D02: a purchase inside the trial does not debit; the owner authorizes instead.
    q = quote(A, 'club', C1, 'capacity_100')
    check(q['success'] and q['net'] == 700 and q['starts_at'] if 'starts_at' in q else True, 'quote inside trial prices 700')
    check(q['lines'][0]['starts_at'] == t1['trial_end'], 'D02 a period quoted inside the trial starts at the trial end')
    b = buy(A, q['quote_id'], 'trial-attempt-0001')
    check(b.get('error') == 'trial_active_authorize_instead' and balance(A) == 1000, 'D02 no operator-service debit before the trial ends, even by direct call')
    m = rpc('fn_ca_commerce_set_renewal', f"'{trial_ent[0]['id']}',true,700,'capacity_100',1", A)
    check(m['success'] and m['state'] == 'authorized' and m['due_at'] == t1['trial_end'], 'D02 post-trial authorization attaches to the trial right at the trial end')
    check(balance(A) == 1000, 'D02 an authorization records no debit')
    # The page cancels a post-trial authorization without naming a product.
    mc = rpc('fn_ca_commerce_set_renewal', f"'{trial_ent[0]['id']}',false,NULL,NULL,NULL", A)
    check(mc.get('success') and mc.get('state') == 'cancelled', 'D50 a post-trial authorization is cancelled without naming its product', mc)
    m250 = rpc('fn_ca_commerce_set_renewal', f"'{trial_ent[0]['id']}',true,1500,'capacity_250',1", A)
    st = rpc('fn_ca_commerce_scope_status', f"'club','{C1}'", A)
    check(m250.get('success') and m250.get('mandate_id') == m['mandate_id'] and st.get('success')
          and count(f"public.ca_commerce_renewal_mandates WHERE entitlement_id='{trial_ent[0]['id']}'") == 1,
          'D09 one right carries one renewal mandate: authorizing another product replaces it, never a second charge for the same period', m250)
    m = rpc('fn_ca_commerce_set_renewal', f"'{trial_ent[0]['id']}',true,700,'capacity_100',1", A)
    check(m['success'] and m['state'] == 'authorized' and m['sku'] == 'capacity_100' and m['max_diamonds'] == 700, 'D09 the owner re-authorizes the first paid period')

    # ---- D27 notices --------------------------------------------------------
    check(count(f"public.ca_commerce_notices WHERE user_id='{A}' AND kind='club_commerce_trial_reminder'") == 2, 'D27 two trial reminders are recorded durably')
    delivered = int(sql("SELECT public.fn_ca_commerce_deliver_due_notices(50)", role='service_role'))
    check(delivered == 0 and count("public.notifications") == 0, 'D27 reminders are not delivered before they are due')
    sql(f"UPDATE public.ca_commerce_notices SET due_at = now() - interval '1 minute' WHERE dedupe_key LIKE 'trial-reminder-21:%'")
    delivered = int(sql("SELECT public.fn_ca_commerce_deliver_due_notices(50)", role='service_role'))
    delivered2 = int(sql("SELECT public.fn_ca_commerce_deliver_due_notices(50)", role='service_role'))
    check(delivered == 1 and delivered2 == 0 and count("public.notifications") == 1, 'D27 a due reminder is delivered exactly once')

    # ---- Simulated clock: the trial ends; the consumer buys the first period --
    sql(f"UPDATE public.ca_commerce_trials SET trial_start = trial_start - interval '721 hours', trial_end = trial_end - interval '721 hours' WHERE operator_id='{A}'")
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '721 hours', ends_at = ends_at - interval '721 hours' WHERE trial_id=(SELECT id FROM public.ca_commerce_trials WHERE operator_id='{A}')")
    sql(f"UPDATE public.ca_commerce_renewal_mandates SET due_at = due_at - interval '721 hours' WHERE scope_id='{C1}'")
    trial_end = sql(f"SELECT trial_end FROM public.ca_commerce_trials WHERE operator_id='{A}'")
    adm = rpc('fn_ca_commerce_admission', f"'club','{C1}','open_table'", A)
    check(adm['allowed'] and (not adm['would_allow']) and adm['reason'] == 'no_effective_entitlement' and not adm['enforced'],
          'D22 after expiry with enforcement in shadow the answer names the refusal without refusing')
    st_c1 = rpc('fn_ca_commerce_scope_status', f"'club','{C1}'", A)
    auth_renewals = [e['renewal'] for e in st_c1['entitlements'] if e.get('renewal')]
    check(len(auth_renewals) == 1 and auth_renewals[0]['sku'] == 'capacity_100' and auth_renewals[0]['quantity'] == 1,
          'D50 the status names the product and quantity a standing authorization will buy', auth_renewals)
    token = str(uuid.uuid4())
    claimed = sql(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{token}',10)", role='service_role')
    check(int(claimed) == 1, 'D09 the due first-period authorization is claimed under a lease')
    claimed_again = sql(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{uuid.uuid4()}',10)", role='service_role')
    check(int(claimed_again) == 0, 'D73 a leased obligation is not handed to a second worker')
    mid = sql(f"SELECT id FROM public.ca_commerce_renewal_mandates WHERE scope_id='{C1}' AND lease_token='{token}'")
    lost = json.loads(sql(f"SELECT public.fn_ca_commerce_execute_renewal('{mid}','{uuid.uuid4()}')", role='service_role'))
    check(lost.get('error') == 'lease_lost', 'D73 execution under a stale lease is refused')
    before = balance(A)
    # Lock order: an upgrade or refund holds the scope lock and then writes the
    # mandate row. The renewal consumer racing it must wait on the scope, not
    # hold the mandate and wait on the scope (a deadlock that aborts one side).
    scope_key = f"ca_commerce_scope:club:{C1}"
    race = {}

    def scope_holder():
        race['holder'] = run(PSQL + ['-d', DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
                                     f"BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('{scope_key}',0)); SELECT pg_sleep(1.2); "
                                     f"UPDATE public.ca_commerce_renewal_mandates SET updated_at = now() WHERE id = '{mid}'; COMMIT;"])

    def renewal_runner():
        time.sleep(0.4)
        try:
            race['ex'] = json.loads(sql(f"SELECT public.fn_ca_commerce_execute_renewal('{mid}','{token}')", role='service_role'))
        except AssertionError as e:
            race['ex'] = {'error': 'raised', 'detail': str(e)[-300:]}
    ths = [threading.Thread(target=scope_holder), threading.Thread(target=renewal_runner)]
    [t.start() for t in ths]; [t.join() for t in ths]
    check(race['holder'].returncode == 0 and 'deadlock' not in (race['holder'].stderr or '') and race['ex'].get('success'),
          'D70 renewal execution takes the scope lock before the mandate: no deadlock against an upgrade or refund in flight',
          {'holder': (race['holder'].stderr or '')[-300:], 'ex': race['ex']})
    ex = race['ex']
    check(ex['success'] and ex['outcome'] == 'renewed' and int(ex['charged']) == 700 and balance(A) == before - 700,
          'D03 the first paid period charges exactly the accepted amount at the trial end')
    ent = json.loads(sql(f"SELECT to_jsonb(e) FROM public.ca_commerce_entitlements e WHERE e.purchase_id='{ex['purchase_id']}'"))
    check(ent['kind'] == 'capacity' and ent['capacity'] == 100 and ent['starts_at'].replace(' ', 'T')[:19] == trial_end.replace(' ', 'T')[:19],
          'D51 the paid period begins exactly where the trial ended, no gap')
    p1 = json.loads(sql(f"SELECT to_jsonb(p) FROM public.ca_commerce_purchases p WHERE p.id='{ex['purchase_id']}'"))
    tx = json.loads(sql(f"SELECT to_jsonb(t) FROM public.diamond_transactions t WHERE t.id='{p1['diamond_tx_id']}'"))
    check(tx['amount'] == -700 and tx['issuance_class'] == 'spend' and tx['counterparty'] == 'revenue:club_commerce', 'D20 the journal carries one exact spend to revenue:club_commerce')
    mr = mint_rows(p1['diamond_tx_id'])
    check(len(mr) == 1 and mr[0]['action'] == 'burn' and float(mr[0]['amount']) == 700 and mr[0]['op'] == p1['mint_op_id'], 'R2-A04 exactly one linked Mint retirement of 700')
    lots = json.loads(sql(f"SELECT jsonb_agg(jsonb_build_object('issued',issued,'consumed',consumed)) FROM public.diamond_purchase_lots WHERE user_id='{A}'"))
    check(lots == [{'issued': 600, 'consumed': 600}] and p1['lot_allocation'][0]['consumed_delta'] == 600,
          'R2-A03 / D37 purchased lots are consumed FIFO first (600 of 700) and the operation-linked delta is retained')
    check(count(f"public.ca_commerce_renewal_mandates WHERE entitlement_id='{ent['id']}' AND state='authorized' AND max_diamonds=700") == 1,
          'D09 the standing authorization carries forward to the new period')
    check(count(f"public.ca_commerce_notices WHERE dedupe_key='receipt:{p1['id']}'") == 1 and count(f"public.notifications WHERE type='club_commerce_receipt'") == 1,
          'D27 one receipt notice per purchase')
    ent_capacity = ent['id']

    # ---- Receipt recovery and replay (D04, D05, D06, D31, D68) -------------
    rec = rpc('fn_ca_commerce_receipts', f"'club','{C1}'", A)
    check(len(rec) == 1 and rec[0]['is_replay'] and rec[0]['original_total_diamonds'] == 700 and rec[0]['charged_this_attempt'] == 0,
          'D68 a recovered receipt keeps the original total and charges nothing')
    st = rpc('fn_ca_commerce_scope_status', f"'club','{C1}'", A)
    check(any(e['id'] == ent_capacity and e['active'] for e in st['entitlements']), 'the scope status shows the active capacity right')

    # A manual prepaid renewal for the following period, then the duplicate barriers.
    q1 = quote(A, 'club', C1, 'capacity_100')
    q2 = quote(A, 'club', C1, 'capacity_100')
    check(q1['success'] and q1['lines'][0]['starts_at'] == ent['ends_at'].replace(' ', 'T').replace('+00:00', '+00:00') or q1['lines'][0]['starts_at'][:19] == ent['ends_at'].replace(' ', 'T')[:19],
          'a renewal quote is placed at the end of the current period')
    sql(f"INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued) VALUES ('{A}',gen_random_uuid(),1000)")
    sql(f"UPDATE public.profiles SET diamonds=diamonds+1000, diamond_balance=diamond_balance+1000 WHERE id='{A}'") if False else None
    # Fund A through the canonical credit door (a purchase-shaped credit), never a direct wallet write.
    sql(f"SELECT public.add_diamonds_to_balance('{A}',1000,'purchase','Test top-up','topup-{uuid.uuid4()}')", role='service_role')
    before = balance(A)
    b1 = buy(A, q1['quote_id'], 'manual-renewal-0001')
    check(b1['success'] and not b1['is_replay'] and b1['charged_this_attempt'] == 700 and balance(A) == before - 700, 'D03 a prepaid renewal charges once')
    b1r = buy(A, q1['quote_id'], 'manual-renewal-0001')
    check(b1r['success'] and b1r['is_replay'] and b1r['charged_this_attempt'] == 0 and b1r['original_total_diamonds'] == 700 and balance(A) == before - 700,
          'D04 same key and payload replays the receipt without a second debit')
    b1k = buy(A, q1['quote_id'], 'manual-renewal-0002')
    check(b1k['success'] and b1k['is_replay'] and b1k['purchase_id'] == b1['purchase_id'] and balance(A) == before - 700,
          'D31 the same quote under a new key names the same purchase and cannot double grant')
    b2 = buy(A, q2['quote_id'], 'manual-renewal-0001')
    check(b2.get('error') == 'request_key_reused', 'D05 the same key with a different payload refuses')
    b2b = buy(A, q2['quote_id'], 'manual-renewal-0003')
    check(b2b.get('error') in ('context_changed', 'period_already_covered') and balance(A) == before - 700,
          'D32 a second quote for the same period cannot buy it twice')
    b1x = buy(P, q1['quote_id'], 'someone-elses-key')
    check(b1x.get('error') == 'quote_belongs_to_another_actor', 'D19 a quote is bound to its actor')
    check(count(f"public.ca_commerce_entitlements WHERE scope_id='{C1}' AND kind='capacity' AND state='effective'") == 2, 'two consecutive capacity periods, no overlap')
    qup = quote(A, 'club', C1, 'capacity_250', purchase_kind='upgrade')
    check(qup.get('success') and qup['lines'][0]['replaces_entitlement_id'] == ent_capacity and qup['lines'][0]['ends_at'][:19] == ent['ends_at'].replace(' ', 'T')[:19],
          'D11 an upgrade amends the current right even when the next period is already prepaid', qup)

    # D06: expired quote, catalog change, owner change.
    q3 = quote(A, 'club', C1, 'club_insurance_module')
    sql(f"UPDATE public.ca_commerce_quotes SET expires_at = now() - interval '1 second' WHERE id='{q3['quote_id']}'")
    b3 = buy(A, q3['quote_id'], 'expired-quote-0001')
    check(b3.get('error') == 'quote_expired' and b3.get('requote'), 'D06 an expired quote refuses and asks for a requote')
    q4 = quote(A, 'club', C1, 'club_insurance_module')
    d = rpc('fn_ca_commerce_price_draft', "'club_insurance_module',250,'flat',NULL,'Test price change authority'", S)
    rpc('fn_ca_commerce_price_validate', f"'{d['price_version_id']}'", S)
    pub = rpc('fn_ca_commerce_price_publish', f"'{d['price_version_id']}',NULL", S)
    check(pub['success'], 'D74 staff publishes a new price version prospectively')
    b4 = buy(A, q4['quote_id'], 'catalog-changed-0001')
    check(b4.get('error') == 'context_changed', 'D06 a catalog change withdraws an unconsumed quote instead of charging a different amount', b4)
    # The staff publications run under the staff browser identity; the
    # version readings between them are the harness's own instrument, taken
    # as the database owner (the internal helper has no browser grant).
    same_tx = sql("""BEGIN; RESET ROLE; CREATE TEMP TABLE cv(v text); GRANT ALL ON cv TO PUBLIC; INSERT INTO cv SELECT public.fn_ca_commerce_catalog_version(); SET ROLE authenticated;
      SELECT public.fn_ca_commerce_price_publish((public.fn_ca_commerce_price_validate((public.fn_ca_commerce_price_draft('club_insurance_module',260,'flat',NULL,'Same second authority one')->>'price_version_id')::uuid)->>'price_version_id')::uuid, NULL);
      RESET ROLE; INSERT INTO cv SELECT public.fn_ca_commerce_catalog_version(); SET ROLE authenticated;
      SELECT public.fn_ca_commerce_price_publish((public.fn_ca_commerce_price_validate((public.fn_ca_commerce_price_draft('club_insurance_module',270,'flat',NULL,'Same second authority two')->>'price_version_id')::uuid)->>'price_version_id')::uuid, NULL);
      RESET ROLE; INSERT INTO cv SELECT public.fn_ca_commerce_catalog_version();
      SELECT count(DISTINCT v) FROM cv; ROLLBACK;""", user=S, role='authenticated')
    check(same_tx == '3', 'D06 two publications inside one second still yield distinct catalog versions, so no quote survives either', same_tx)
    dsr = rpc('fn_ca_commerce_price_draft', "'club_insurance_module',280,'flat',NULL,'Service route price authority'", None, role='service_role')
    r = rpc('fn_ca_commerce_price_publish', f"'{dsr['price_version_id']}',NULL", None, role='service_role')
    check(r.get('error') == 'publisher_required', 'D74 a publication without a named publisher is refused in JSON, not a raw trigger error', r)
    check(count("public.ca_commerce_price_versions WHERE sku='club_insurance_module' AND status='published'") == 1, 'D74 one published price per product after publication')
    check(p1['lines'][0]['unit_diamonds'] == 700 and json.loads(sql(f"SELECT to_jsonb(p) FROM public.ca_commerce_purchases p WHERE p.id='{p1['id']}'"))['lines'][0]['price_version_id'] == p1['lines'][0]['price_version_id'],
          'D18 an accepted purchase keeps its price version and amount')
    r = rpc('fn_ca_commerce_price_draft', "'club_insurance_module',1,'flat',NULL,'Not staff'", A)
    check(r.get('error') == 'staff_required', 'D74 catalog administration requires staff')

    # ---- D07 insufficient funds, D66 benign roster change -----------------
    q5 = quote(D, 'club', C3, 'capacity_60')
    t = rpc('fn_ca_commerce_activate_trial', f"'club','{C3}'", D)
    sql(f"UPDATE public.ca_commerce_trials SET trial_start = trial_start - interval '800 hours', trial_end = trial_end - interval '800 hours' WHERE operator_id='{D}'")
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '800 hours', ends_at = ends_at - interval '800 hours' WHERE trial_id=(SELECT id FROM public.ca_commerce_trials WHERE operator_id='{D}')")
    q5 = quote(D, 'club', C3, 'capacity_60')
    before_p = count('public.ca_commerce_purchases')
    b5 = buy(D, q5['quote_id'], 'insufficient-0001')
    check(b5.get('error') == 'insufficient_diamonds' and balance(D) == 100 and count('public.ca_commerce_purchases') == before_p
          and count(f"public.diamond_transactions WHERE user_id='{D}'") == 0, 'D07 insufficient available balance fails whole, writes nothing')
    q6 = quote(A, 'club', C1, 'club_insurance_module')
    sql(f"INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{C1}','{D}','player','active',0)")
    b6 = buy(A, q6['quote_id'], 'roster-change-0001')
    check(b6['success'] and b6['charged_this_attempt'] == 250, 'D66 a benign roster change between quote and commit does not requote')

    # ---- D33 / D34 fault injection --------------------------------------
    sql("""
    CREATE FUNCTION public.fixture_break_lots() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('test.break_lots', true) = 'on' THEN RAISE EXCEPTION 'fixture: lot write refused'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER zz_fixture_break_lots BEFORE UPDATE ON public.diamond_purchase_lots FOR EACH ROW EXECUTE FUNCTION public.fixture_break_lots();
    CREATE FUNCTION public.fixture_break_register() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('test.break_register', true) = 'on' THEN RAISE EXCEPTION 'fixture: register write refused'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER zz_fixture_break_register BEFORE INSERT ON public.ca_mint_ledger FOR EACH ROW EXECUTE FUNCTION public.fixture_break_register();
    """)
    sql(f"SELECT public.add_diamonds_to_balance('{A}',1000,'purchase','Test top-up','topup-{uuid.uuid4()}')", role='service_role')
    sql(f"INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued) VALUES ('{A}',gen_random_uuid(),1000)")
    q7 = quote(A, 'club', C1, 'capacity_100')  # next period after the two already bought
    before = balance(A); before_tx = count(f"public.diamond_transactions WHERE user_id='{A}'"); before_p = count('public.ca_commerce_purchases')
    before_inc = count('public.ca_diamond_incidents')
    out = sql(f"SELECT set_config('test.break_lots','on',false); SELECT public.fn_ca_commerce_purchase('{q7['quote_id']}','fault-lots-0001','purchase')", user=A, role='authenticated')
    b7 = json.loads(out)
    check(b7.get('error') == 'lots_unproved' and balance(A) == before and count(f"public.diamond_transactions WHERE user_id='{A}'") == before_tx
          and count('public.ca_commerce_purchases') == before_p and count(f"public.ca_commerce_quotes WHERE id='{q7['quote_id']}' AND status='open'") == 1,
          'D33 a swallowed lot-write failure is detected by the persisted-delta postcondition and the whole purchase rolls back')
    out = sql(f"SELECT set_config('test.break_register','on',false); SELECT public.fn_ca_commerce_purchase('{q7['quote_id']}','fault-register-0001','purchase')", user=A, role='authenticated')
    b8 = json.loads(out)
    check(b8.get('error') == 'register_unproved' and balance(A) == before and count(f"public.diamond_transactions WHERE user_id='{A}'") == before_tx
          and count('public.ca_commerce_purchases') == before_p, 'D34 a swallowed register failure is detected by the exact linked Mint row check and the purchase rolls back')
    check(count('public.ca_diamond_incidents') == before_inc, 'D33/D34 an incident filed inside the rolled-back transaction is not left behind as false evidence')
    b9 = buy(A, q7['quote_id'], 'fault-clear-0001')
    check(b9['success'] and b9['charged_this_attempt'] == 700 and balance(A) == before - 700, 'D35 the same quote succeeds once the writes are provable, with its exact register row')
    mr = mint_rows(b9['diamond_tx_id'])
    check(len(mr) == 1 and float(mr[0]['amount']) == 700, 'D35 the verifier accepted the exact matching register row')

    # ---- D36 / D38 / D39 / D40 / D65 refunds --------------------------------
    sql(f"UPDATE public.profiles SET diamond_multiplier=2.00 WHERE id='{A}'")
    r = rpc('fn_ca_commerce_refund', f"'{b9['purchase_id']}',0,200,'Fixture: partial return of an unused right','refund-0001'", A)
    check(r.get('error') == 'staff_required', 'D19 refunds are issued by staff, not self-served')
    before_browser = balance(A)
    r = rpc('fn_ca_commerce_refund', f"'{b9['purchase_id']}',0,200,'Fixture: staff browser session','refund-browser-0001'", S)
    check(r.get('error') == 'refund_requires_service_route' and balance(A) == before_browser
          and count("public.ca_commerce_refunds WHERE request_key='refund-browser-0001'") == 0,
          'R2-A05 a staff browser session is told in JSON that refunds travel the service route, before any work', r)
    sql(f"INSERT INTO public.diamond_debts(user_id,purchase_id,amount,reason) VALUES ('{A}',gen_random_uuid(),50,'fixture chargeback receivable')")
    before = balance(A)
    r1 = rpc('fn_ca_commerce_refund', f"'{b9['purchase_id']}',0,200,'Fixture: partial return of an unused right','refund-0001'", S, role='service_role')
    check(r1['success'] and r1['gross'] == 200 and r1['debt_settled'] == 50 and r1['net_increase'] == 150 and balance(A) == before + 150,
          'D36 / D38 a refund to a 2x-multiplier wallet returns exactly 200 gross, settles 50 of debt and adds 150 to the balance')
    tx = json.loads(sql(f"SELECT to_jsonb(t) FROM public.diamond_transactions t WHERE t.id='{r1['diamond_tx_id']}'"))
    check(tx['amount'] == 200 and tx['issuance_class'] == 'refund', 'D41 the refund journal row is exact and classified refund')
    mr = mint_rows(r1['diamond_tx_id'])
    check(len(mr) == 1 and mr[0]['action'] == 'mint' and float(mr[0]['amount']) == 200, 'D17 the refund is registered as one exact issuance, no excess diamonds')
    check(r1['lot_restoration'] and sum(x['restored'] for x in r1['lot_restoration']) == 200, 'D39 / D65 operation-linked lot provenance is restored, bounded by what this purchase consumed')
    r1r = rpc('fn_ca_commerce_refund', f"'{b9['purchase_id']}',0,200,'Fixture: partial return of an unused right','refund-0001'", S, role='service_role')
    check(r1r['success'] and r1r['is_replay'] and r1r['charged_this_attempt'] == 0 and balance(A) == before + 150, 'D17 a refund replay credits nothing twice')
    r2 = rpc('fn_ca_commerce_refund', f"'{b9['purchase_id']}',0,600,'Fixture: attempt beyond the refundable remainder','refund-0002'", S, role='service_role')
    check(r2.get('error') == 'exceeds_refundable' and r2['refundable'] == 500, 'D40 cumulative returns stay within the net paid allocation')
    r3 = rpc('fn_ca_commerce_refund', f"'{b9['purchase_id']}',0,500,'Fixture: return the remainder in full','refund-0003'", S, role='service_role')
    check(r3['success'] and r3['entitlement_revoked'], 'D17 a full return revokes only that line right')
    check(count(f"public.ca_commerce_entitlements WHERE purchase_id='{b9['purchase_id']}' AND state='revoked'") == 1
          and count(f"public.ca_commerce_entitlements WHERE scope_id='{C1}' AND kind='capacity' AND state='effective'") == 2, 'D17 other overlapping paid rights remain valid')
    rec = {x['purchase_id']: x for x in rpc('fn_ca_commerce_receipts', f"'club','{C1}'", A)}
    check(rec[b9['purchase_id']]['entitlement_status'] == 'revoked' and rec[b1['purchase_id']]['entitlement_status'] == 'effective',
          'D68 a recovered receipt reports the present state of its right: a fully refunded right reads revoked', {k: v['entitlement_status'] for k, v in rec.items()})
    sql(f"UPDATE public.profiles SET diamond_multiplier=1.00 WHERE id='{A}'")

    # ---- D64 wallet headroom ------------------------------------------------
    sql(f"UPDATE public.profiles SET diamonds=2147483600, diamond_balance=2147483600 WHERE id='{A}'") if False else None
    # (a direct wallet write is refused by DR6; use the canonical credit door to approach the ceiling)
    cur = balance(A)
    sql(f"SELECT public.add_diamonds_to_balance('{A}',{2147483600 - cur},'purchase','Fixture: approach the wallet ceiling','ceiling-{uuid.uuid4()}')", role='service_role')
    r4 = rpc('fn_ca_commerce_refund', f"'{b1['purchase_id']}',0,100,'Fixture: refund into a wallet at its ceiling','refund-0004'", S, role='service_role')
    check(not r4['success'] and count("public.ca_commerce_refunds WHERE request_key='refund-0004'") == 0 and balance(A) == 2147483600,
          'D64 a refund the wallet cannot receive is refused whole and remains owed, nothing partially credited')
    sql(f"SELECT public.deduct_diamonds('{A}',2147483600-2000,'Fixture: leave the ceiling','fixture_spend','fixture_spend','{{}}'::jsonb,'ceiling-out-{uuid.uuid4()}',0)", role='service_role')
    r4b = rpc('fn_ca_commerce_refund', f"'{b1['purchase_id']}',0,100,'Fixture: refund into a wallet at its ceiling','refund-0004'", S, role='service_role')
    check(r4b['success'] and not r4b['is_replay'] and r4b['gross'] == 100, 'D64 the same refund request succeeds once the wallet has room, exactly once')
    outs = {}

    def refund_race(name):
        try:
            outs[name] = rpc('fn_ca_commerce_refund', f"'{b1['purchase_id']}',0,50,'Fixture: two staff tabs submit one refund','refund-race-0001'", S, role='service_role')
        except AssertionError as e:
            outs[name] = {'error': 'raised', 'detail': str(e)[-300:]}
    before = balance(A)
    ths = [threading.Thread(target=refund_race, args=(n,)) for n in ('r1', 'r2')]
    [t.start() for t in ths]; [t.join() for t in ths]
    check(all(v.get('success') for v in outs.values()) and sorted(v['is_replay'] for v in outs.values()) == [False, True] and balance(A) == before + 50,
          'D17 two concurrent submissions of one refund request credit once and both return its receipt', outs)

    # ---- D11 / D54 upgrades --------------------------------------------------
    # Owner X: a fresh club with a paid 100-member right at exactly half its period.
    rpc('fn_ca_commerce_activate_trial', f"'club','{C4}'", X)
    sql(f"UPDATE public.ca_commerce_trials SET trial_start = trial_start - interval '800 hours', trial_end = trial_end - interval '800 hours' WHERE operator_id='{X}'")
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '800 hours', ends_at = ends_at - interval '800 hours' WHERE trial_id=(SELECT id FROM public.ca_commerce_trials WHERE operator_id='{X}')")
    # X holds one lot whose arena reserve exceeds its remainder (available -100) and one open lot of 200.
    sql(f"INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued,consumed,refunded,arena_reserved) VALUES ('{X}',gen_random_uuid(),600,300,0,400)")
    sql(f"INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued) VALUES ('{X}',gen_random_uuid(),200)")
    qx = quote(X, 'club', C4, 'capacity_100')
    bx = buy(X, qx['quote_id'], 'x-first-0001')
    check(bx['success'] and bx['charged_this_attempt'] == 700, 'upgrade fixture: X holds a paid 100-member period', bx)
    px = json.loads(sql(f"SELECT to_jsonb(p) FROM public.ca_commerce_purchases p WHERE p.id='{bx['purchase_id']}'"))
    check(sum(x['consumed_delta'] for x in px['lot_allocation']) == 200,
          'R2-A03 an over-reserved lot offers nothing: the expected split equals what the canonical consumer takes, so a funded purchase is not refused', px['lot_allocation'])
    ex_id = bx['lines'][0]['entitlement_id']
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = now() - interval '360 hours', ends_at = now() + interval '360 hours' WHERE id='{ex_id}'")
    qu = quote(X, 'club', C4, 'capacity_250', purchase_kind='upgrade')
    check(qu['success'] and qu['lines'][0]['credit'] in (349, 350) and qu['lines'][0]['gross'] in (750, 751) and 400 <= qu['net'] <= 402,
          'D11 a 700 -> 1,500 upgrade at half period credits the unused 350 against 750 for the remainder: 400 diamonds, whole diamonds, residue never in favor of free capacity', qu['lines'][0])
    before = balance(X)
    mis = buy(X, qu['quote_id'], 'x-upgrade-mislabel', kind='purchase')
    check(mis.get('error') == 'purchase_kind_mismatch' and count(f"public.ca_commerce_purchases WHERE request_key='x-upgrade-mislabel'") == 0,
          'D68 an upgrade quote cannot be committed under another kind: the receipt always names what was bought', mis)
    bu = buy(X, qu['quote_id'], 'x-upgrade-0001', kind='upgrade')
    check(bu['success'] and bu['charged_this_attempt'] == qu['net'] and balance(X) == before - qu['net'], 'D11 the upgrade charges once, exactly the quoted amount')
    old = json.loads(sql(f"SELECT to_jsonb(e) FROM public.ca_commerce_entitlements e WHERE e.id='{ex_id}'"))
    new = json.loads(sql(f"SELECT to_jsonb(e) FROM public.ca_commerce_entitlements e WHERE e.id='{bu['lines'][0]['entitlement_id']}'"))
    check(old['superseded_by'] == new['id'] and new['ends_at'][:19] == qu['lines'][0]['ends_at'][:19] and old['ends_at'] <= new['starts_at'],
          'D11 the old right is superseded at the switch and the new right keeps the original period end')
    check(old['state'] == 'superseded' and new['capacity'] == 250 and new['revision'] == 2 and new['net_paid'] == qu['net'] and new['value_basis'] == qu['net'] + qu['lines'][0]['credit'],
          'D54 the amended right carries its net paid and its value basis (net plus the credited unused value)')
    qu2 = quote(X, 'club', C4, 'capacity_500', purchase_kind='upgrade')
    # Staged: 100 -> 250 -> 500 must not be cheaper than the remaining-value arithmetic allows.
    # Direct 100 -> 500 at half period would be ceil(1250) - floor(350) = 900; staged 100 -> 250 -> 500 must land within a few whole-diamond residues of that.
    staged_total = qu['net'] + qu2['net']
    check(qu2['success'] and qu2['lines'][0]['credit'] <= new['value_basis'] and qu2['net'] >= 0 and 898 <= staged_total <= 904,
          'D54 a staged upgrade costs the same as the direct upgrade within whole-diamond residues, and residues never buy free capacity', {'staged_total': staged_total, 'q2': qu2['lines'][0]})
    qd = quote(X, 'club', C4, 'capacity_60', purchase_kind='upgrade')
    check(qd.get('error') == 'downgrade_applies_at_next_period', 'D11 a downgrade is prospective, never an interrupted period')
    r = rpc('fn_ca_commerce_refund', f"'{bx['purchase_id']}',0,700,'Fixture: refund of a right already credited into an upgrade','refund-x-0001'", S, role='service_role')
    check(r.get('error') == 'exceeds_refundable' and r.get('refundable') == 700 - qu['lines'][0]['credit'],
          'D40 / R2 6.4 unused value credited into an upgrade cannot also come back as a refund', r)
    before = balance(X)
    rb = rpc('fn_ca_commerce_refund', f"'{bu['purchase_id']}',0,100,'Fixture: partial return of the upgraded right','refund-x-0002'", S, role='service_role')
    check(rb['success'] and balance(X) == before + 100, 'fixture: a partial refund of the upgraded right')
    qu3 = quote(X, 'club', C4, 'capacity_500', purchase_kind='upgrade')
    basis = new['value_basis'] - 100
    check(qu3['success'] and basis - 10 <= qu3['lines'][0]['credit'] <= basis,
          'D54 / R2 4.4 an upgrade never credits value that a refund already returned', {'basis_after_refund': basis, 'line': qu3['lines'][0]})

    # ---- D76 bounds --------------------------------------------------------------
    r = rpc('fn_ca_commerce_quote', f"'club','{C1}','[]'::jsonb,NULL,NULL,'purchase'", A)
    check(r.get('error') == 'basket_size', 'D76 an empty basket is refused')
    r = rpc('fn_ca_commerce_quote', f"'club','{C1}','{json.dumps([{'sku': 'capacity_100', 'quantity': 3}])}'::jsonb,NULL,NULL,'purchase'", A)
    check(r.get('error') == 'quantity_not_allowed', 'D76 a flat product cannot be multiplied')
    r = rpc('fn_ca_commerce_quote', f"'union','{U}','{json.dumps([{'sku': 'union_back_office', 'quantity': 0}])}'::jsonb,NULL,NULL,'purchase'", B)
    check(r.get('error') == 'quantity_out_of_range', 'D76 a zero quantity is refused')
    r = rpc('fn_ca_commerce_quote', f"'union','{U}','{json.dumps([{'sku': 'union_back_office', 'quantity': 501}])}'::jsonb,NULL,NULL,'purchase'", B)
    check(r.get('error') == 'quantity_out_of_range', 'D76 an excessive quantity is refused')
    for bad in ('abc', 2.5, -1):
        r = rpc('fn_ca_commerce_quote', f"'union','{U}','{json.dumps([{'sku': 'union_back_office', 'quantity': bad}])}'::jsonb,NULL,NULL,'purchase'", B)
        check(r.get('error') == 'quantity_out_of_range', f'D76 a malformed quantity ({bad!r}) is a named refusal, never a raw cast error', r)
    r = rpc('fn_ca_commerce_quote', f"'club','{C1}','{json.dumps([{'sku': 'capacity_100'}, {'sku': 'capacity_250'}])}'::jsonb,NULL,NULL,'purchase'", A)
    check(r.get('error') == 'duplicate_line', 'D76 two lines of one kind cannot expand rights twice')
    r = rpc('fn_ca_commerce_quote', f"'club','{C1}','{json.dumps([{'sku': 'report_export_7d'}])}'::jsonb,NULL,NULL,'purchase'", A)
    check(r.get('error') == 'sku_not_available', 'D80 an unsupported offering cannot be quoted')
    r = rpc('fn_ca_commerce_quote', f"'club','{C1}','{json.dumps([{'sku': 'union_back_office'}])}'::jsonb,NULL,NULL,'purchase'", A)
    check(r.get('error') == 'sku_scope_mismatch', 'D76 a union product cannot be bought for a club')
    r = buy(A, q6['quote_id'], 'short')
    check(r.get('error') == 'request_key_required', 'D76 a request key shorter than eight characters is refused')

    # ---- Union back office, sponsorship (D12, D42, D43, D44, D45, D46) ------
    rpc('fn_ca_commerce_activate_trial', f"'union','{U}'", B)
    rpc('fn_ca_commerce_activate_trial', f"'club','{C2}'", B)
    sql(f"UPDATE public.ca_commerce_trials SET trial_start = trial_start - interval '800 hours', trial_end = trial_end - interval '800 hours' WHERE operator_id='{B}'")
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '800 hours', ends_at = ends_at - interval '800 hours' WHERE trial_id=(SELECT id FROM public.ca_commerce_trials WHERE operator_id='{B}')")
    qb = quote(B, 'union', U, 'union_back_office', qty=2)
    check(qb['success'] and qb['net'] == 2000, 'union back office prices 1,000 per covered club: 2 clubs = 2,000')
    bb = buy(B, qb['quote_id'], 'union-bo-0001')
    check(bb['success'] and bb['charged_this_attempt'] == 2000, 'D46 covered quantity is a purchase, not an affiliation side effect')
    r = quote(B, 'union', U, 'union_back_office', qty=1, purchase_kind='upgrade')
    check(r.get('error') == 'downgrade_applies_at_next_period', 'D11 fewer covered clubs mid-period is a downgrade: it applies at the next period and never forfeits paid value', r)
    sql(f"INSERT INTO public.union_clubs(union_id,club_id) VALUES ('{U}','{C1}'); UPDATE public.clubs SET union_id='{U}' WHERE id='{C1}'")
    check(balance(B) == 5000 - 2000 and count(f"public.ca_commerce_entitlements WHERE scope_id='{C1}' AND kind='capacity' AND state='effective'") == 2,
          'D45 / D46 a club joining a union with back office only is neither debited nor refunded; its standalone capacity stands')
    qi = quote(B, 'union', U, 'union_insurance_module', qty=8)
    check(qi['success'] and qi['net'] == 1000, 'union insurance module is min(200 x covered clubs, 1,000)')
    # Sponsorship: B funds C3 (owned by D) with a 1,000 budget; D cannot spend it from a browser session.
    sp = rpc('fn_ca_commerce_sponsorship_set', f"'{U}',NULL,1000,NULL,NULL,NULL,false", B)
    check(sp['success'] and sp['state'] == 'active', 'D12 the union owner records an explicit sponsorship budget')
    r = rpc('fn_ca_commerce_sponsorship_set', f"'{U}',NULL,1000,NULL,NULL,NULL,false", D)
    check(r.get('error') == 'union_owner_required', 'D42 a club owner cannot create a union sponsorship')
    r = rpc('fn_ca_commerce_quote', f"'club','{C3}','{lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", D)
    check(r.get('error') == 'sponsor_payer_required', 'D42 a delegate cannot quote against the sponsor budget from an end-user session')
    r = rpc('fn_ca_commerce_quote', f"'club','{C4}','{lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", B)
    check(r.get('error') == 'sponsorship_not_effective', 'D12 an unrelated club cannot use the union budget')
    # The union's own shell club carries clubs.union_id but is not a covered
    # (union_clubs) club: the sponsorship does not reach it.
    shell = str(uuid.uuid4())
    sql(f"INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union) VALUES ('{shell}','Commerce Union Shell','{B}','{U}',0,0,true)")
    r = rpc('fn_ca_commerce_quote', f"'club','{shell}','{lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", B)
    check(r.get('error') == 'sponsorship_not_effective', 'D12 membership is the union_clubs link: the union shell club is not covered by its sponsorship', r)
    ust = rpc('fn_ca_commerce_scope_status', f"'union','{U}'", B)
    linked = sorted(sql(f"SELECT string_agg(club_id::text, ',' ORDER BY club_id) FROM public.union_clubs WHERE union_id='{U}'").split(','))
    check(sorted(c['club_id'] for c in ust['covered_clubs']) == linked and shell not in linked and ust['covered_club_count'] == len(linked)
          and all('roster_count' in c and 'trial_active' in c for c in ust['covered_clubs']),
          'D12 the union status lists exactly its covered clubs, with roster and trial state, for the sponsor to act on', ust.get('covered_clubs'))
    qs = rpc('fn_ca_commerce_quote', f"'club','{C3}','{lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", B)
    check(qs['success'] and qs['payer_id'] == B and qs['net'] == 500, 'D12 the sponsor pays for a covered club at the catalog price, no discount')
    # Spoofed payer: the sponsor's quote submitted by the club owner's session.
    r = buy(D, qs['quote_id'], 'spoof-0001')
    check(r.get('error') == 'quote_belongs_to_another_actor', 'D42 a sponsor quote cannot be submitted from another session')
    before_b, before_d = balance(B), balance(D)
    bs = buy(B, qs['quote_id'], 'sponsor-c3-0001')
    check(bs['success'] and balance(B) == before_b - 500 and balance(D) == before_d, 'D12 the sponsor is debited once; the club owner is not debited')
    check(count(f"public.ca_commerce_entitlements WHERE scope_id='{C3}' AND kind='capacity' AND source='sponsor' AND state='effective'") == 1, 'D12 the beneficiary holds the right')
    check(int(sql(f"SELECT committed FROM public.ca_commerce_sponsorships WHERE id='{sp['sponsorship_id']}'")) == 500, 'D43 committed charges are tracked against the budget')
    rs = [r for r in rpc('fn_ca_commerce_receipts', 'NULL,NULL', B) if r['purchase_id'] == bs['purchase_id']]
    check(len(rs) == 1 and rs[0]['sponsorship_id'] == sp['sponsorship_id'] and rs[0]['scope_id'] == C3,
          'D12 the sponsor sees the sponsored club receipt, and it names the sponsorship that paid', rs)
    # D43: two covered clubs race for the remaining 500 with 500 each: exactly one wins.
    qs2 = rpc('fn_ca_commerce_quote', f"'club','{C2}','{lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", B)
    qs3 = rpc('fn_ca_commerce_quote', f"'club','{C3}','{lines('capacity_60')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", B)
    outs = {}

    def race(name, qid, key):
        outs[name] = buy(B, qid, key)
    ths = [threading.Thread(target=race, args=('c2', qs2['quote_id'], 'race-c2-0001')), threading.Thread(target=race, args=('c3', qs3['quote_id'], 'race-c3-0001'))]
    [t.start() for t in ths]; [t.join() for t in ths]
    wins = [k for k, v in outs.items() if v.get('success')]
    loses = [k for k, v in outs.items() if v.get('error') == 'sponsorship_budget_exceeded']
    check(len(wins) == 1 and len(loses) == 1 and int(sql(f"SELECT committed FROM public.ca_commerce_sponsorships WHERE id='{sp['sponsorship_id']}'")) == 1000,
          'D43 two covered clubs racing for the last 500 of budget: one commits, one is refused, committed never exceeds the budget', outs)
    rv = rpc('fn_ca_commerce_sponsorship_set', f"'{U}',NULL,NULL,NULL,NULL,'{sp['sponsorship_id']}',true", B)
    check(rv['success'] and rv['state'] == 'revoked', 'D44 the sponsor revokes future spending')
    qs4 = rpc('fn_ca_commerce_quote', f"'club','{C3}','{lines('club_insurance_module')}'::jsonb,'{sp['sponsorship_id']}',NULL,'purchase'", B)
    check(qs4.get('error') == 'sponsorship_not_effective', 'D44 a revoked sponsorship cannot be quoted against')
    check(count(f"public.ca_commerce_entitlements WHERE scope_id='{C3}' AND source='sponsor' AND state='effective'") >= 1 and balance(D) == before_d,
          'D44 revocation neither removes paid rights nor debits the club owner')
    r = rpc('fn_ca_commerce_set_renewal', f"'{bs['lines'][0]['entitlement_id']}',true,500,NULL,NULL", D)
    check(r.get('error') == 'payer_required', 'D44 a sponsored right cannot be turned into a mandate on the club owner')

    # ---- Renewal outcomes (D10, D49, D50) -------------------------------------
    # D10: price above the accepted ceiling.
    mid = sql(f"SELECT id FROM public.ca_commerce_renewal_mandates WHERE entitlement_id='{ent_capacity}' AND state='authorized'")
    d = rpc('fn_ca_commerce_price_draft', "'capacity_100',800,'flat',NULL,'Test price increase authority'", S)
    rpc('fn_ca_commerce_price_validate', f"'{d['price_version_id']}'", S)
    rpc('fn_ca_commerce_price_publish', f"'{d['price_version_id']}',NULL", S)
    sql(f"UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '1 minute' WHERE id='{mid}'")
    token = str(uuid.uuid4())
    n = int(sql(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{token}',10)", role='service_role'))
    check(n == 1, 'D10 the due mandate is claimed')
    before = balance(A)
    ex = json.loads(sql(f"SELECT public.fn_ca_commerce_execute_renewal('{mid}','{token}')", role='service_role'))
    check(ex['outcome'] == 'needs_attention' and ex['reason'] == 'price_above_accepted_ceiling' and balance(A) == before,
          'D10 a price increase above the accepted ceiling does not auto-charge and leaves a visible attention state')
    check(count(f"public.notifications WHERE type='club_commerce_renewal_attention' AND user_id='{A}'") == 1, 'D27 the attention notice is delivered once')
    msg = sql(f"SELECT message FROM public.notifications WHERE type='club_commerce_renewal_attention' AND user_id='{A}' ORDER BY created_at DESC LIMIT 1")
    check('_' not in msg and 'Up To 100 Approved Members' in msg and 'Price Above Accepted Ceiling' in msg,
          'Title Case copy: the attention notice names the product and the reason in words, never a code', msg)
    # D50: cancellation before the due renewal.
    m2 = rpc('fn_ca_commerce_set_renewal', f"'{ent_capacity}',true,900,NULL,NULL", A)
    check(m2['success'] and m2['state'] == 'authorized' and m2['max_diamonds'] == 900, 'D09 the owner re-authorizes at a higher ceiling')
    m3 = rpc('fn_ca_commerce_set_renewal', f"'{ent_capacity}',false,NULL,NULL,NULL", A)
    check(m3['state'] == 'cancelled', 'D50 cancellation disables the future renewal')
    n = int(sql(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{uuid.uuid4()}',10)", role='service_role'))
    check(n == 0 and count(f"public.ca_commerce_entitlements WHERE id='{ent_capacity}' AND state='effective'") == 1, 'D50 a cancelled mandate is never claimed and the paid current period stands')
    # D49: a mandate resumed long after its due period.
    m4 = rpc('fn_ca_commerce_set_renewal', f"'{ent_capacity}',true,900,NULL,NULL", A)
    sql(f"UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '3 days' WHERE id='{m4['mandate_id']}'")
    token = str(uuid.uuid4())
    sql(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{token}',10)", role='service_role')
    before = balance(A)
    ex = json.loads(sql(f"SELECT public.fn_ca_commerce_execute_renewal('{m4['mandate_id']}','{token}')", role='service_role'))
    check(ex['outcome'] == 'needs_attention' and ex['reason'] == 'lapsed_beyond_lateness_policy' and balance(A) == before,
          'D49 a renewal resumed beyond the accepted lateness window charges nothing and creates no historic debt')
    check(count(f"public.notifications WHERE type='club_commerce_renewal_attention' AND user_id='{A}'") == 2,
          'D27 a re-authorized renewal that fails again notifies again: one notice per failed attempt')
    # The first paid period ends while the manually prepaid next period already covers its end.
    m5 = rpc('fn_ca_commerce_set_renewal', f"'{ent_capacity}',true,900,NULL,NULL", A)
    sql(f"""UPDATE public.ca_commerce_entitlements
          SET starts_at = starts_at - ((SELECT ends_at FROM public.ca_commerce_entitlements WHERE id='{ent_capacity}') - now() + interval '1 minute'),
              ends_at = ends_at - ((SELECT ends_at FROM public.ca_commerce_entitlements WHERE id='{ent_capacity}') - now() + interval '1 minute')
        WHERE scope_id='{C1}' AND kind='capacity'""")
    sql(f"UPDATE public.ca_commerce_renewal_mandates m SET due_at = e.ends_at FROM public.ca_commerce_entitlements e WHERE e.id = m.entitlement_id AND m.id='{m5['mandate_id']}'")
    token = str(uuid.uuid4())
    n = int(sql(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{token}',10)", role='service_role'))
    before, before_p = balance(A), count('public.ca_commerce_purchases')
    ex = json.loads(sql(f"SELECT public.fn_ca_commerce_execute_renewal('{m5['mandate_id']}','{token}')", role='service_role'))
    check(n == 1 and ex.get('outcome') == 'needs_attention' and ex.get('reason') == 'period_already_covered' and balance(A) == before and count('public.ca_commerce_purchases') == before_p,
          'R2 4.2 / 4.6 a renewal buys only the period beginning at its due instant; a prepaid period already covering it is never billed again ahead of time', ex)

    # ---- D22 enforcement, D63 -------------------------------------------------
    st = rpc('fn_ca_commerce_settings_set', "NULL,NULL,now(),false", S)
    check(st['success'] and st['admission_enforced_from'], 'D22 staff records the admission enforcement event')
    adm = rpc('fn_ca_commerce_admission', f"'club','{C3}','open_table'", D)
    check(adm['allowed'] and adm['reason'] == 'entitled', 'D22 an entitled club is admitted')
    adm = rpc('fn_ca_commerce_admission', f"'club','{C3}','approve_member'", D)
    check(adm['allowed'] and adm['reason'] == 'within_capacity', 'D22 approval within capacity is admitted')
    for i in range(60):
        uid = f'99000000-0000-4000-8000-{i:012d}'
        sql(f"INSERT INTO auth.users(id) VALUES ('{uid}'); INSERT INTO public.profiles(id,username) VALUES ('{uid}','roster{i}'); INSERT INTO public.club_members(club_id,user_id,role,status) VALUES ('{C3}','{uid}','player','active')")
    adm = rpc('fn_ca_commerce_admission', f"'club','{C3}','approve_member'", D)
    check((not adm['allowed']) and adm['reason'] == 'capacity_reached' and adm['roster_count'] == 61, 'D22 approval beyond purchased capacity is refused, nothing else is locked')
    adm = rpc('fn_ca_commerce_admission', f"'club','{C3}','open_table'", D)
    check(adm['allowed'], 'D22 opening a table is not blocked by roster capacity')
    r = quote(D, 'club', C3, 'capacity_60')
    check(r.get('error') == 'roster_exceeds_capacity', 'D11 a capacity below the approved roster cannot be bought')
    # Expiry never touches the wallet.
    sql(f"UPDATE public.ca_commerce_entitlements SET starts_at = starts_at - interval '2000 hours', ends_at = ends_at - interval '2000 hours' WHERE scope_id='{C3}'")
    adm = rpc('fn_ca_commerce_admission', f"'club','{C3}','open_table'", D)
    check((not adm['allowed']) and adm['reason'] == 'no_effective_entitlement' and balance(D) == before_d, 'D63 an expired license refuses new discretionary operation and the purchased balance is untouched')
    adm = rpc('fn_ca_commerce_admission', f"'club','{C3}','cash_out'", D)
    check(adm['allowed'] and adm['reason'] == 'unpriced_action', 'D21 / D22 withdrawals, records and settlement are never gated')
    rpc('fn_ca_commerce_settings_set', "NULL,NULL,NULL,true", S)

    # ---- D78 rollback state ------------------------------------------------------
    rpc('fn_ca_commerce_settings_set', "false,NULL,NULL,false", S)
    r = quote(A, 'club', C1, 'club_insurance_module')
    check(r.get('error') == 'checkout_disabled', 'D78 disabling checkout refuses new purchases')
    rec = rpc('fn_ca_commerce_receipts', f"'club','{C1}'", A)
    check(len(rec) >= 3 and count(f"public.ca_commerce_entitlements WHERE scope_id='{C1}' AND state='effective'") >= 2, 'D78 delivered paid rights and receipts remain while checkout is disabled')
    rpc('fn_ca_commerce_settings_set', "true,NULL,NULL,false", S)

    # ---- D70 unrelated owners concurrently ------------------------------------
    qa = quote(A, 'club', C1, 'club_insurance_module')
    qx2 = quote(X, 'club', C4, 'club_insurance_module')
    outs = {}
    ths = [threading.Thread(target=lambda: outs.__setitem__('a', buy(A, qa['quote_id'], 'conc-a-0001'))),
           threading.Thread(target=lambda: outs.__setitem__('x', buy(X, qx2['quote_id'], 'conc-x-0001')))]
    [t.start() for t in ths]; [t.join() for t in ths]
    check(outs['a']['success'] and outs['x']['success'], 'D70 unrelated owners purchase concurrently without a global lock', outs)

    # ---- D74 prospective publication ------------------------------------------
    d1 = rpc('fn_ca_commerce_price_draft', "'capacity_60',550,'flat',NULL,'Test prospective price authority'", S)
    rpc('fn_ca_commerce_price_validate', f"'{d1['price_version_id']}'", S)
    p1 = rpc('fn_ca_commerce_price_publish', f"'{d1['price_version_id']}',now() + interval '1 hour'", S)
    d2 = rpc('fn_ca_commerce_price_draft', "'capacity_60',600,'flat',NULL,'Test earlier prospective price'", S)
    rpc('fn_ca_commerce_price_validate', f"'{d2['price_version_id']}'", S)
    p2 = rpc('fn_ca_commerce_price_publish', f"'{d2['price_version_id']}',now() + interval '30 minutes'", S)
    qf = quote(X, 'club', C4, 'capacity_60')
    rows = json.loads(sql("SELECT jsonb_agg(status ORDER BY version) FROM public.ca_commerce_price_versions WHERE sku='capacity_60'"))
    check(p1.get('success') and p2.get('success') and qf.get('success') and qf['net'] == 500 and rows == ['published', 'retired', 'published'],
          'D74 a prospective price leaves the current price in effect until its date; a later-dated version replaced before it began never takes effect', {'p1': p1, 'p2': p2, 'qf': qf.get('error'), 'rows': rows})

    # ---- D20 conservation ---------------------------------------------------------
    conservation = json.loads(sql("""
      SELECT jsonb_build_object(
        'purchases_net', (SELECT COALESCE(SUM(net),0) FROM public.ca_commerce_purchases),
        'burns', (SELECT COALESCE(SUM(m.amount),0) FROM public.ca_mint_ledger m JOIN public.ca_commerce_purchases p ON p.diamond_tx_id = m.diamond_tx_id WHERE m.action='burn'),
        'refunds_gross', (SELECT COALESCE(SUM(gross),0) FROM public.ca_commerce_refunds),
        'mints', (SELECT COALESCE(SUM(m.amount),0) FROM public.ca_mint_ledger m JOIN public.ca_commerce_refunds r ON r.diamond_tx_id = m.diamond_tx_id WHERE m.action='mint'),
        'journal_spend', (SELECT COALESCE(-SUM(t.amount),0) FROM public.diamond_transactions t JOIN public.ca_commerce_purchases p ON p.diamond_tx_id=t.id),
        'journal_refund', (SELECT COALESCE(SUM(t.amount),0) FROM public.diamond_transactions t JOIN public.ca_commerce_refunds r ON r.diamond_tx_id=t.id),
        'zero_net_without_tx', (SELECT count(*) FROM public.ca_commerce_purchases WHERE (net=0) <> (diamond_tx_id IS NULL)),
        'trial_rows_with_money', (SELECT count(*) FROM public.ca_commerce_entitlements WHERE source='trial' AND (net_paid<>0 OR purchase_id IS NOT NULL))
      )"""))
    c = {k: float(v) for k, v in conservation.items()}
    check(c['purchases_net'] == c['burns'] == c['journal_spend'] and c['refunds_gross'] == c['mints'] == c['journal_refund']
          and c['zero_net_without_tx'] == 0 and c['trial_rows_with_money'] == 0,
          'D20 wallet, journal and register conservation: every paid diamond has one spend and one retirement; every refund one exact issuance; waivers move nothing', conservation)
    check(count("pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN ('tables','table_seats','tournaments','tournament_players','club_members') AND t.tgname LIKE '%commerce%'") == 0,
          'D21 / D28 no commerce trigger sits in the gameplay or seating path')
    r = sql(f"UPDATE public.profiles SET diamonds = diamonds + 1 WHERE id = '{P}'", ok=False, user=P, role='authenticated')
    check(r.returncode != 0 and ('server-managed' in r.stderr or 'permission denied' in r.stderr),
          'R2-A05 a signed-in player still cannot write a wallet directly: the guard admits a door, not a person', r.stderr[-200:])
    check(count("pg_proc WHERE proname LIKE 'fn_ca_commerce%' AND (proname ~* '(repair|backpay|redrive|catchup|backfill|heal|reconcile|sweep)')") == 0,
          'no band-aid: the commerce boundary owns its outcomes; nothing repairs them later')


def main():
    try:
        start_cluster()
        load_fixture()
        apply_migration()
        seed()
        scenarios()
        print(f'PASS {passed} scenarios: club and union diamond commerce qualified in isolation')
        out = os.environ.get('COMMERCE_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'migrations': [m.name for m in MIGRATIONS]}, indent=1))
    except AssertionError as e:
        print('FAIL', e, file=sys.stderr)
        out = os.environ.get('COMMERCE_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'failure': str(e)}, indent=1))
        sys.exit(1)
    finally:
        stop_cluster()


if __name__ == '__main__':
    main()
