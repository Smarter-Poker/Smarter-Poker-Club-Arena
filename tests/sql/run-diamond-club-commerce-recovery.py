#!/usr/bin/env python3
"""Club and union diamond commerce: ownership, deletion and restore-shaped recovery.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), scenarios D75 and D79.
Qualifies the installed commerce boundary (base, fixes, refunds/notices/catalog
lifecycle) in a private, socket-only PostgreSQL cluster. It reuses the cluster,
fixture and identity plumbing of tests/sql/run-diamond-club-commerce.py
(imported, not modified): identity is presented exactly as PostgREST presents
it (request.jwt.claims plus SET ROLE), and the production-captured Diamond
Games fixture supplies the real wallet, journal, lot and register writers.

D75  A club changes owner and another is retired while paid rights and an
     owed refund exist; the paying profile's deletion is attempted. Receipts,
     purchases, rights and the owed refund survive; the refund returns to the
     original payer, never the new owner; the new owner reads status but can
     neither request nor receive the former owner's refund; the former owner
     still reads their receipts.
D79  Restore-shaped recovery brings back older request and job state: a
     purchase key re-delivered after commit (and its quote reopened), a
     renewal whose lease was lost and re-claimed, a mandate reset to an
     earlier snapshot, an executed refund request reset to approved or owed,
     and a delivered notice re-inserted under its dedupe key. No second
     debit, refund, right or notice.

Migrations applied in order: the capability registry, then the base harness's
MIGRATIONS (base, fixes, 20260924102040). Nothing here connects to production.

Run:  PG_BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1) python3 tests/sql/run-diamond-club-commerce-recovery.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
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
# there and a port of its own (the base uses 55611, admission 55613, refunds
# 55623), so every runner can run side by side.
shutil.rmtree(h.work, ignore_errors=True)
h.work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce-recovery.'))
h.sock = h.work / 'socket'
h.sock.mkdir()
h.data = h.work / 'data'
h.PG_BIN = PG_BIN
h.PORT = '55643'
h.PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(h.sock), '-p', h.PORT, '-U', 'postgres']
MIGRATIONS = list(h.MIGRATIONS)

sql, rpc, check, count, balance = h.sql, h.rpc, h.check, h.count, h.balance


def apply_migrations():
    for m in MIGRATIONS:
        r = h.run(h.PSQL + ['-d', h.DB, '-f', str(m)])
        if r.returncode:
            raise SystemExit(f'migration {m.name} failed:\n' + r.stderr)


def svc(q):
    return sql(q, role='service_role')


def js(q):
    return json.loads(sql(q))


def claim(tok=None, limit=10):
    tok = tok or str(uuid.uuid4())
    return tok, int(svc(f"SELECT count(*) FROM public.fn_ca_commerce_claim_due_renewals('{tok}',{limit})"))


def execute(mid, tok):
    return json.loads(svc(f"SELECT public.fn_ca_commerce_execute_renewal('{mid}','{tok}')"))


def run_refunds():
    return json.loads(svc(f"SELECT public.fn_ca_commerce_execute_approved_refunds('{uuid.uuid4()}',10)"))


def deliver():
    return int(svc("SELECT public.fn_ca_commerce_deliver_due_notices(200)"))


def refund_request(user, purchase, line, reason, key, details=None):
    d = 'NULL' if details is None else "'" + details.replace("'", "''") + "'"
    return rpc('fn_ca_commerce_refund_request', f"'{purchase}',{line},'{reason}','{key}',{d}", user)


def decide(user, request_id, approve, amount=None, note=None):
    a = 'NULL' if amount is None else str(amount)
    n = 'NULL' if note is None else "'" + note.replace("'", "''") + "'"
    return rpc('fn_ca_commerce_refund_decide', f"'{request_id}',{'true' if approve else 'false'},{a},{n}", user)


def to_ceiling(u):
    cur = balance(u)
    svc(f"SELECT public.add_diamonds_to_balance('{u}',{2147483600 - cur},'purchase','Fixture: approach the wallet ceiling','ceiling-{uuid.uuid4()}')")


def leave_ceiling(u):
    svc(f"SELECT public.deduct_diamonds('{u}',2147483600-2000,'Fixture: leave the ceiling','fixture_spend','fixture_spend','{{}}'::jsonb,'ceiling-out-{uuid.uuid4()}',0)")


def ledger(u):
    """Every figure a second debit, refund or grant would move."""
    return js(f"""SELECT jsonb_build_object(
      'balance', (SELECT diamonds FROM public.profiles WHERE id='{u}'),
      'journal', (SELECT count(*) FROM public.diamond_transactions WHERE user_id='{u}'),
      'mint_ledger', (SELECT count(*) FROM public.ca_mint_ledger),
      'purchases', (SELECT count(*) FROM public.ca_commerce_purchases),
      'refunds', (SELECT count(*) FROM public.ca_commerce_refunds),
      'entitlements', (SELECT count(*) FROM public.ca_commerce_entitlements),
      'lots_consumed', (SELECT COALESCE(sum(consumed),0) FROM public.diamond_purchase_lots WHERE user_id='{u}'))""")


def evidence(u, scopes):
    """The payer's commerce evidence, row for row: what must survive."""
    ids = ','.join(f"'{s}'" for s in scopes)
    return js(f"""SELECT jsonb_build_object(
      'purchases', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]') FROM public.ca_commerce_purchases p WHERE p.payer_id='{u}'),
      'rights', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM public.ca_commerce_entitlements e WHERE e.scope_id IN ({ids})),
      'requests', (SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.id), '[]') FROM public.ca_commerce_refund_requests q WHERE q.payer_id='{u}'),
      'refunds', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM public.ca_commerce_refunds r WHERE r.payer_id='{u}'),
      'mandates', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM public.ca_commerce_renewal_mandates m WHERE m.payer_id='{u}'),
      'journal', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM public.diamond_transactions t WHERE t.user_id='{u}'))""")


def restore_row(table, row_id, snap, cols):
    """Put captured column values back on a row, as a restore would."""
    sets = ', '.join(f"{c} = (jsonb_populate_record(NULL::public.{table}, '{json.dumps(snap).replace(chr(39), chr(39) * 2)}'::jsonb)).{c}" for c in cols)
    sql(f"UPDATE public.{table} SET {sets} WHERE id='{row_id}'")


# Synthetic identities (a cluster of their own; no production account).
OA = 'd7500000-0000-4000-8000-0000000000a1'   # original owner and payer (D75)
NW = 'd7500000-0000-4000-8000-0000000000a2'   # the club's next owner (D75)
RR = 'd7900000-0000-4000-8000-0000000000b1'   # owner whose state is restored (D79)
ST1 = 'd7f00000-0000-4000-8000-0000000000f1'  # platform staff
KA = '57500000-0000-4000-8000-00000000000a'   # transferred club
KB = '57500000-0000-4000-8000-00000000000b'   # retired club
KR = '57900000-0000-4000-8000-00000000000c'   # restore club


def seed():
    sql(f"""
    INSERT INTO auth.users(id) VALUES ('{OA}'),('{NW}'),('{RR}'),('{ST1}');
    INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role,is_horse) VALUES
      ('{OA}','recovery_original_owner',3000,3000,'user',false),('{NW}','recovery_next_owner',40,40,'user',false),
      ('{RR}','recovery_restored_owner',5000,5000,'user',false),('{ST1}','recovery_staff',0,0,'admin',false);
    INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union,lifecycle_status,is_platform,asset) VALUES
      ('{KA}','Recovery Transferred Club','{OA}',NULL,0,0,false,'active',false,'chips'),
      ('{KB}','Recovery Retired Club','{OA}',NULL,0,0,false,'active',false,'chips'),
      ('{KR}','Recovery Restored Club','{RR}',NULL,0,0,false,'active',false,'chips');
    INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES
      ('{KA}','{OA}','owner','active',0),('{KB}','{OA}','owner','active',0),('{KR}','{RR}','owner','active',0);
    """)


def install_facts():
    check(sql('SHOW listen_addresses') == '' and sql('SHOW unix_socket_directories') == str(h.sock),
          'the cluster is private and socket-only (listen_addresses= empty, its own temporary socket directory)')
    fks = js("""SELECT COALESCE(jsonb_agg(c.conrelid::regclass::text || ' -> ' || c.confrelid::regclass::text), '[]')
                  FROM pg_constraint c
                 WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE '%ca_commerce_%'
                   AND c.confrelid::regclass::text IN ('profiles','public.profiles','clubs','public.clubs','unions','public.unions','auth.users')""")
    check(fks == [], 'D75 no commerce table carries a foreign key to profiles, clubs, unions or auth.users: no cascade can reach receipts or obligations', fks)
    trig = js("""SELECT jsonb_agg(c.relname ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE t.tgname IN ('ca_commerce_purchases_append_only','ca_commerce_refunds_append_only')""")
    check(trig == ['ca_commerce_purchases', 'ca_commerce_refunds'], 'D75 purchases and refunds are append-only evidence', trig)


# ---------------------------------------------------------------------------
# D75: ownership transfer, retirement and deletion with paid rights and an
# owed refund.
# ---------------------------------------------------------------------------
def ownership_transfer_and_deletion():
    global OA_REQUEST, OA_OWED_SNAPSHOT
    q = h.quote(OA, 'club', KA, 'capacity_100', renewal_max=900)
    cap = h.buy(OA, q['quote_id'], 'd75-capacity-0001')
    q = h.quote(OA, 'club', KA, 'club_insurance_module')
    ins = h.buy(OA, q['quote_id'], 'd75-insurance-0001')
    q = h.quote(OA, 'club', KB, 'capacity_60')
    kb = h.buy(OA, q['quote_id'], 'd75-retired-capacity-0001')
    check(cap.get('success') and ins.get('success') and kb.get('success') and balance(OA) == 3000 - 700 - 200 - 500
          and count(f"public.ca_commerce_renewal_mandates WHERE payer_id='{OA}' AND state='authorized'") == 1,
          'fixture: the owner buys capacity (with renewal authorized) and an insurance module on one club, capacity on a second', [cap, ins, kb])
    rq = refund_request(OA, ins['purchase_id'], 0, 'purchase_in_error', 'd75-refund-0001', 'Bought for the wrong club')
    OA_REQUEST = rq['request']['request_id']
    ap = decide(ST1, OA_REQUEST, True)
    to_ceiling(OA)
    ex = run_refunds()
    row = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{OA_REQUEST}'")
    OA_OWED_SNAPSHOT = row
    check(rq.get('success') and ap.get('success') and ex['owed'] == 1 and row['state'] == 'owed' and row['approved_amount'] == 200
          and count(f"public.ca_commerce_refunds WHERE purchase_id='{ins['purchase_id']}'") == 0,
          'fixture: the insurance refund is approved at 200 and owed (the wallet cannot receive it yet)', row)

    before = evidence(OA, [KA, KB])
    # The platform's transfer: the club's owner changes, the old owner stays a player.
    sql(f"""UPDATE public.clubs SET owner_id='{NW}' WHERE id='{KA}';
            UPDATE public.club_members SET role='player' WHERE club_id='{KA}' AND user_id='{OA}';
            INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{KA}','{NW}','owner','active',0)""")
    after = evidence(OA, [KA, KB])
    check(before == after and len(after['purchases']) == 3 and len(after['requests']) == 1 and after['requests'][0]['state'] == 'owed'
          and all(e['state'] == 'effective' for e in after['rights']),
          'D75 an ownership transfer changes no receipt, purchase, right, mandate, journal row or owed refund', {k: len(v) for k, v in after.items()})

    for pid, key in ((ins['purchase_id'], 'd75-new-owner-0001'), (cap['purchase_id'], 'd75-new-owner-0002')):
        r = refund_request(NW, pid, 0, 'scope_closed', key)
        check(r.get('error') == 'payer_required' and count(f"public.ca_commerce_refund_requests WHERE requested_by='{NW}'") == 0,
              "D75 the new owner cannot request a refund of the former owner's purchase", r)
    st = rpc('fn_ca_commerce_scope_status', f"'club','{KA}'", NW)
    ent_ids = {e['purchase_id'] for e in st.get('entitlements', []) if e['active']}
    check(st.get('success') and st['role'] == 'owner' and st['owner_id'] == NW and {cap['purchase_id'], ins['purchase_id']} <= ent_ids
          and st['refund_requests'] == [] and st['balance_breakdown']['available'] == balance(NW)
          and st['balance_breakdown']['pending_refunds'] == 0 and st['balance_breakdown']['owed_refunds'] == 0,
          "D75 the new owner reads the scope status: the paid rights still in force, none of the former owner's refund or wallet figures",
          {'role': st.get('role'), 'bb': st.get('balance_breakdown'), 'rights': len(ent_ids)})
    check(rpc('fn_ca_commerce_receipts', f"'club','{KA}'", NW) == [] and rpc('fn_ca_commerce_receipts', 'NULL,NULL', NW) == [],
          "D75 the new owner reads no receipt of the former owner's purchases")
    rec = {x['purchase_id']: x for x in rpc('fn_ca_commerce_receipts', 'NULL,NULL', OA)}
    old_st = rpc('fn_ca_commerce_scope_status', f"'club','{KA}'", OA)
    check(set(rec) == {cap['purchase_id'], ins['purchase_id'], kb['purchase_id']} and rec[ins['purchase_id']]['refund_requests'][0]['state'] == 'owed'
          and rec[ins['purchase_id']]['original_total_diamonds'] == 200 and rec[ins['purchase_id']]['charged_this_attempt'] == 0
          and old_st.get('error') == 'access_denied',
          'D75 the former owner still reads every receipt they paid for, with the owed refund, after losing the club; its status is no longer theirs', old_st)

    # The owed refund is paid when the wallet can receive it: to the payer.
    leave_ceiling(OA)
    b_oa, b_nw, nw_tx = balance(OA), balance(NW), count(f"public.diamond_transactions WHERE user_id='{NW}'")
    ex = run_refunds()
    refund = js(f"SELECT to_jsonb(r) FROM public.ca_commerce_refunds r WHERE purchase_id='{ins['purchase_id']}'")
    tx = js(f"SELECT to_jsonb(t) FROM public.diamond_transactions t WHERE id='{refund['diamond_tx_id']}'")
    check(ex['refunded'] == 1 and balance(OA) == b_oa + 200 and balance(NW) == b_nw and refund['payer_id'] == OA and tx['user_id'] == OA
          and tx['amount'] == 200 and tx['issuance_class'] == 'refund' and count(f"public.diamond_transactions WHERE user_id='{NW}'") == nw_tx
          and count(f"public.notifications WHERE user_id='{NW}' AND type LIKE 'club_commerce_refund%'") == 0,
          'D75 the owed refund, executed by the service consumer after the transfer, returns 200 to the original payer and nothing to the new owner', ex)
    check(sql(f"SELECT state FROM public.ca_commerce_refund_requests WHERE id='{OA_REQUEST}'") == 'refunded'
          and count(f"public.ca_commerce_entitlements WHERE purchase_id='{ins['purchase_id']}' AND state='revoked'") == 1,
          'D75 the request is refunded and the fully refunded right revoked, on the scope the new owner holds')

    # The former owner's standing renewal on the transferred club never
    # charges anyone once the club has another owner.
    m = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m WHERE payer_id='{OA}' AND scope_id='{KA}' AND state='authorized'")
    sql(f"""UPDATE public.ca_commerce_entitlements SET starts_at = now() - interval '720 hours' - interval '1 minute', ends_at = now() - interval '1 minute' WHERE id='{m['entitlement_id']}';
            UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '1 minute' WHERE id='{m['id']}'""")
    b_oa, b_nw, n_p = balance(OA), balance(NW), count('public.ca_commerce_purchases')
    tok, n = claim()
    rx = execute(m['id'], tok)
    check(n == 1 and rx.get('outcome') == 'needs_attention' and rx.get('reason') == 'payer_no_longer_owner_or_right_changed'
          and balance(OA) == b_oa and balance(NW) == b_nw and count('public.ca_commerce_purchases') == n_p,
          "D75 the former owner's renewal mandate stops at an attention state after the transfer: neither the former nor the new owner is charged", rx)

    # A club is retired: its paid right and receipt remain.
    kb_before = evidence(OA, [KB])
    sql(f"UPDATE public.clubs SET lifecycle_status='retired', retired_at=now(), retired_by='{ST1}' WHERE id='{KB}'")
    kb_after = evidence(OA, [KB])
    rec = {x['purchase_id'] for x in rpc('fn_ca_commerce_receipts', f"'club','{KB}'", OA)}
    check(kb_before == kb_after and rec == {kb['purchase_id']}
          and count(f"public.ca_commerce_entitlements WHERE scope_id='{KB}' AND state='effective' AND purchase_id='{kb['purchase_id']}'") == 1,
          'D75 retiring a club keeps its receipt, its paid right and every journal row; the payer still reads the receipt')

    # Hard deletion of the retired club, inside a transaction rolled back
    # either way: no commerce row may go with it.
    r = sql(f"""BEGIN; DELETE FROM public.clubs WHERE id='{KB}';
               SELECT jsonb_build_object('club', (SELECT count(*) FROM public.clubs WHERE id='{KB}'),
                 'purchases', (SELECT count(*) FROM public.ca_commerce_purchases WHERE scope_id='{KB}'),
                 'rights', (SELECT count(*) FROM public.ca_commerce_entitlements WHERE scope_id='{KB}')); ROLLBACK;""", ok=False)
    hard = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else None
    # Measured: the schema admits a hard delete of a club (nothing references
    # it from commerce), and because no commerce table carries a foreign key
    # the receipt and right stay, keyed by the scope id.
    check(r.returncode == 0 and hard == {'club': 0, 'purchases': 1, 'rights': 1} and count(f"public.clubs WHERE id='{KB}'") == 1,
          'D75 a hard club deletion cascades into no receipt or right: the evidence stays keyed by the scope id', {'rc': r.returncode, 'hard': hard, 'err': r.stderr[-300:]})

    # Deletion of the paying account, the path an auth admin delete takes.
    oa_before = evidence(OA, [KA, KB])
    r = sql(f"DELETE FROM auth.users WHERE id='{OA}'", ok=False)
    oa_after = evidence(OA, [KA, KB])
    check(r.returncode != 0 and 'financial journals are append-only' in r.stderr and count(f"public.profiles WHERE id='{OA}'") == 1 and count(f"auth.users WHERE id='{OA}'") == 1 and oa_before == oa_after,
          "D75 deleting the paying account is refused by the schema (the cascade reaches the append-only journal), and every receipt, right, refund and journal row survives",
          r.stderr[-300:])
    r2 = sql(f"DELETE FROM public.profiles WHERE id='{OA}'", ok=False)
    # The retired club still names the payer as its owner, so the profile's
    # own delete stops at clubs_owner_id_fkey before it reaches the journal.
    check(r2.returncode != 0 and 'clubs_owner_id_fkey' in r2.stderr and oa_before == evidence(OA, [KA, KB]),
          'D75 deleting the payer profile directly is refused (the retired club still names its owner) and removes nothing', r2.stderr[-300:])
    rec = rpc('fn_ca_commerce_receipts', 'NULL,NULL', OA)
    check(len(rec) == 3 and any(x['refunds'] for x in rec), 'D75 after the refused deletion the payer still reads all three receipts and the executed refund')


# ---------------------------------------------------------------------------
# D79: restore-shaped recovery of older job and request state.
# ---------------------------------------------------------------------------
def purchase_redelivery():
    global RR_CAP
    q = h.quote(RR, 'club', KR, 'capacity_100', renewal_max=900)
    b = h.buy(RR, q['quote_id'], 'd79-purchase-0001')
    RR_CAP = b
    check(b.get('success') and not b['is_replay'] and b['charged_this_attempt'] == 700, 'fixture: the owner buys a capacity period once', b)
    snap = ledger(RR)
    rb = h.buy(RR, q['quote_id'], 'd79-purchase-0001')
    check(rb.get('success') and rb['is_replay'] and rb['purchase_id'] == b['purchase_id'] and rb['charged_this_attempt'] == 0 and ledger(RR) == snap,
          'D79 the same purchase request key re-delivered after commit replays the receipt and moves nothing', rb)
    # A restore brings the quote back as it was before the commit: open.
    qsnap = js(f"SELECT to_jsonb(x) FROM public.ca_commerce_quotes x WHERE id='{q['quote_id']}'")
    sql(f"UPDATE public.ca_commerce_quotes SET status='open', purchase_id=NULL WHERE id='{q['quote_id']}'")
    r1 = h.buy(RR, q['quote_id'], 'd79-purchase-0001')
    r2 = h.buy(RR, q['quote_id'], 'd79-purchase-0002')
    check(r1.get('success') and r1['is_replay'] and r1['purchase_id'] == b['purchase_id'] and not r2.get('success')
          and r2.get('error') in ('context_changed', 'period_already_covered') and ledger(RR) == snap
          and count(f"public.ca_commerce_purchases WHERE quote_id='{q['quote_id']}'") == 1,
          'D79 with the quote restored to open, the old key replays and a new key is refused: one purchase, no second debit', {'r1': r1.get('is_replay'), 'r2': r2})
    restore_row('ca_commerce_quotes', q['quote_id'], qsnap, ['status', 'purchase_id'])
    # The original delivery and its re-delivery racing on two connections.
    qi = h.quote(RR, 'club', KR, 'club_insurance_module')
    before = ledger(RR)
    outs = {}

    def deliver_once(name):
        try:
            outs[name] = h.buy(RR, qi['quote_id'], 'd79-race-0001')
        except AssertionError as e:
            outs[name] = {'error': 'raised', 'detail': str(e)[-300:]}
    ths = [threading.Thread(target=deliver_once, args=(n,)) for n in ('a', 'b')]
    [t.start() for t in ths]; [t.join() for t in ths]
    after = ledger(RR)
    check(all(v.get('success') for v in outs.values()) and sorted(v['is_replay'] for v in outs.values()) == [False, True]
          and after['balance'] == before['balance'] - 200 and after['journal'] == before['journal'] + 1
          and after['mint_ledger'] == before['mint_ledger'] + 1 and after['purchases'] == before['purchases'] + 1,
          'D79 a purchase and its re-delivery on two connections debit once; the second returns the receipt', outs)
    global RR_INS
    RR_INS = [v for v in outs.values() if not v['is_replay']][0]


def renewal_lease_and_snapshot_restore():
    ent = RR_CAP['lines'][0]['entitlement_id']
    m = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m WHERE entitlement_id='{ent}'")
    sql(f"""UPDATE public.ca_commerce_entitlements SET starts_at = now() - interval '720 hours' - interval '1 minute', ends_at = now() - interval '1 minute' WHERE id='{ent}';
            UPDATE public.ca_commerce_renewal_mandates SET due_at = now() - interval '1 minute' WHERE id='{m['id']}'""")
    ends_at = sql(f"SELECT ends_at FROM public.ca_commerce_entitlements WHERE id='{ent}'")
    pre_claim = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m WHERE id='{m['id']}'")
    tok1, n1 = claim()
    in_lease = js(f"SELECT to_jsonb(m) FROM public.ca_commerce_renewal_mandates m WHERE id='{m['id']}'")
    # Worker one's lease is lost (it stalled past its lease); worker two re-claims.
    sql(f"UPDATE public.ca_commerce_renewal_mandates SET lease_until = clock_timestamp() - interval '1 second' WHERE id='{m['id']}'")
    tok2, n2 = claim()
    before = ledger(RR)
    stale = execute(m['id'], tok1)
    ok = execute(m['id'], tok2)
    again_old, again_new = execute(m['id'], tok1), execute(m['id'], tok2)
    after = ledger(RR)
    check(n1 == 1 and n2 == 1 and stale.get('error') == 'lease_lost' and ok.get('outcome') == 'renewed' and int(ok['charged']) == 700
          and again_old.get('error') == 'lease_lost' and again_new.get('error') == 'lease_lost'
          and after['balance'] == before['balance'] - 700 and after['journal'] == before['journal'] + 1
          and after['mint_ledger'] == before['mint_ledger'] + 1 and after['purchases'] == before['purchases'] + 1,
          'D79 a renewal whose lease was lost and re-claimed charges once; the stale worker and every replay are refused', [stale, ok, again_old, again_new])
    period = f"public.ca_commerce_entitlements WHERE scope_id='{KR}' AND kind='capacity' AND state='effective' AND starts_at='{ends_at}'"
    check(count(period) == 1, 'D79 exactly one right covers the renewed period')
    settled = ledger(RR)

    # A restore brings the mandate back mid-flight: authorized, due, and
    # holding worker one's lease (captured values, lease still unexpired).
    restore_row('ca_commerce_renewal_mandates', m['id'], in_lease,
                ['state', 'due_at', 'lease_token', 'lease_until', 'attempts', 'last_result', 'renewal_purchase_id', 'updated_at'])
    r1 = execute(m['id'], tok1)
    check(r1.get('outcome') == 'needs_attention' and r1.get('reason') == 'period_already_covered' and ledger(RR) == settled and count(period) == 1,
          'D79 a mandate restored mid-lease and executed by its old worker finds the period already covered: no second debit, no second right', r1)
    # A restore brings it back from before the claim; the consumer claims and executes again.
    restore_row('ca_commerce_renewal_mandates', m['id'], pre_claim,
                ['state', 'due_at', 'lease_token', 'lease_until', 'attempts', 'last_result', 'renewal_purchase_id', 'updated_at'])
    tok3, n3 = claim()
    r3 = execute(m['id'], tok3)
    check(n3 == 1 and r3.get('outcome') == 'needs_attention' and r3.get('reason') == 'period_already_covered'
          and ledger(RR) == settled and count(period) == 1
          and count(f"public.ca_commerce_purchases WHERE request_key LIKE 'renewal:{m['id']}:%'") == 1,
          'D79 a mandate reset to its pre-claim snapshot is claimed and executed again: still one renewal purchase, one right, one debit', r3)


def refund_restore():
    rq = refund_request(RR, RR_INS['purchase_id'], 0, 'purchase_in_error', 'd79-refund-0001')
    rid = rq['request']['request_id']
    decide(ST1, rid, True)
    approved = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rid}'")
    before = ledger(RR)
    ex = run_refunds()
    done = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rid}'")
    check(ex['refunded'] == 1 and ledger(RR)['balance'] == before['balance'] + 200 and done['state'] == 'refunded',
          'fixture: an approved refund request is executed once (200 to the payer)', ex)
    settled = ledger(RR)
    ex2 = run_refunds()
    check(ex2['claimed'] == 0 and ledger(RR) == settled, 'D79 re-running the refund consumer after execution claims nothing and credits nothing', ex2)
    cols = ['state', 'refund_id', 'executed_at', 'lease_token', 'lease_until', 'attempts', 'owed_reason', 'last_error', 'updated_at']
    restore_row('ca_commerce_refund_requests', rid, approved, cols)
    ex3 = run_refunds()
    row = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{rid}'")
    check(ex3['claimed'] == 1 and ex3['refunded'] == 1 and ex3['results'][0]['refund_id'] == done['refund_id'] and ledger(RR) == settled
          and row['state'] == 'refunded' and row['refund_id'] == done['refund_id']
          and count(f"public.ca_commerce_refunds WHERE purchase_id='{RR_INS['purchase_id']}'") == 1
          and count(f"public.notifications WHERE user_id='{RR}' AND type='club_commerce_refund'") == 1,
          'D79 an executed request restored to approved is re-executed as the core replay: same refund, no second credit, no second notice', ex3)
    # The D75 request restored to its owed snapshot.
    oa = ledger(OA)
    restore_row('ca_commerce_refund_requests', OA_REQUEST, OA_OWED_SNAPSHOT, cols)
    ex4 = run_refunds()
    oa_row = js(f"SELECT to_jsonb(q) FROM public.ca_commerce_refund_requests q WHERE id='{OA_REQUEST}'")
    check(ex4['claimed'] == 1 and ex4['refunded'] == 1 and ledger(OA) == oa and oa_row['state'] == 'refunded'
          and count(f"public.ca_commerce_refunds r JOIN public.ca_commerce_refund_requests q ON q.purchase_id = r.purchase_id WHERE q.id='{OA_REQUEST}'") == 1,
          'D79 an executed request restored to owed is settled as a replay: no second refund to the payer', ex4)


def notice_restore():
    key = f"receipt:{RR_CAP['purchase_id']}"
    n = js(f"SELECT to_jsonb(n) FROM public.ca_commerce_notices n WHERE dedupe_key='{key}'")
    notes = count(f"public.notifications WHERE user_id='{RR}'")
    check(n['delivered_at'] is not None and n['notification_id'] is not None, 'fixture: the receipt notice was delivered once', n)
    r = sql(f"""INSERT INTO public.ca_commerce_notices (dedupe_key,user_id,kind,title,message,action_url,payload,due_at)
               SELECT dedupe_key,user_id,kind,title,message,action_url,payload,due_at FROM public.ca_commerce_notices WHERE dedupe_key='{key}'""", ok=False)
    check(r.returncode != 0 and 'ca_commerce_notices_dedupe_key_key' in r.stderr and count(f"public.ca_commerce_notices WHERE dedupe_key='{key}'") == 1,
          'D79 a restored copy of a delivered notice under the same dedupe key is refused by the unique key', r.stderr[-200:])
    again = sql(f"SELECT public.fn_ca_commerce_notice('{RR}','{key}','{n['kind']}','Receipt Again','Receipt Again',NULL,'{{}}'::jsonb)")
    delivered = deliver()
    check(again == n['id'] and count(f"public.notifications WHERE user_id='{RR}'") == notes
          and count(f"public.notifications WHERE id='{n['notification_id']}'") == 1
          and count(f"public.ca_commerce_notices WHERE dedupe_key='{key}'") == 1,
          'D79 the notice writer re-run under the same dedupe key returns the original notice and sends nothing twice', {'again': again, 'delivered': delivered})


def conservation():
    c = js("""SELECT jsonb_build_object(
        'purchases_net', (SELECT COALESCE(SUM(net),0) FROM public.ca_commerce_purchases),
        'burns', (SELECT COALESCE(SUM(m.amount),0) FROM public.ca_mint_ledger m JOIN public.ca_commerce_purchases p ON p.diamond_tx_id = m.diamond_tx_id WHERE m.action='burn'),
        'journal_spend', (SELECT COALESCE(-SUM(t.amount),0) FROM public.diamond_transactions t JOIN public.ca_commerce_purchases p ON p.diamond_tx_id=t.id),
        'refunds_gross', (SELECT COALESCE(SUM(gross),0) FROM public.ca_commerce_refunds),
        'mints', (SELECT COALESCE(SUM(m.amount),0) FROM public.ca_mint_ledger m JOIN public.ca_commerce_refunds r ON r.diamond_tx_id = m.diamond_tx_id WHERE m.action='mint'),
        'journal_refund', (SELECT COALESCE(SUM(t.amount),0) FROM public.diamond_transactions t JOIN public.ca_commerce_refunds r ON r.diamond_tx_id=t.id),
        'executed', (SELECT COALESCE(SUM(approved_amount),0) FROM public.ca_commerce_refund_requests WHERE state='refunded'),
        'refunds_per_request', (SELECT COALESCE(max(n),0) FROM (SELECT count(*) n FROM public.ca_commerce_refunds GROUP BY request_key) x),
        'refund_tx_to_non_payer', (SELECT count(*) FROM public.ca_commerce_refunds r JOIN public.diamond_transactions t ON t.id=r.diamond_tx_id
                                    JOIN public.ca_commerce_purchases p ON p.id=r.purchase_id WHERE t.user_id <> p.payer_id))""")
    c = {k: float(v) for k, v in c.items()}
    check(c['purchases_net'] == c['burns'] == c['journal_spend'] == 700 + 200 + 500 + 700 + 700 + 200
          and c['refunds_gross'] == c['mints'] == c['journal_refund'] == c['executed'] == 400
          and c['refunds_per_request'] == 1 and c['refund_tx_to_non_payer'] == 0,
          'conservation: after every restore replay, each paid diamond has one spend and one retirement, each refund one issuance to its payer', c)
    check(count("(SELECT dedupe_key FROM public.ca_commerce_notices GROUP BY dedupe_key HAVING count(*) > 1) d") == 0, 'no dedupe key holds two notices')


def main():
    t0 = time.time()
    try:
        h.start_cluster()
        h.load_fixture()
        h.install_registry()
        apply_migrations()
        seed()
        install_facts()
        ownership_transfer_and_deletion()
        purchase_redelivery()
        renewal_lease_and_snapshot_restore()
        refund_restore()
        notice_restore()
        conservation()
        print(f'PASS {h.passed} scenarios: diamond commerce ownership, deletion and restore-shaped recovery qualified in isolation ({time.time() - t0:.1f}s)')
    except AssertionError as e:
        print('FAIL', e, file=sys.stderr)
        sys.exit(1)
    finally:
        h.stop_cluster()


if __name__ == '__main__':
    main()
