#!/usr/bin/env python3
"""Deterministic randomized union books for the evidence harness.
  gen.py <seed> <scale> [clean]   -> SQL on stdout
Every branch of the evidence path gets both its passing and refusing shapes:
open seats and pending add-ons at both boundaries, open tournaments with
chip/non-chip/zero/satellite/late/multi-club entries, credits and refund
tranches returning to the same/another club/user/registration/tournament,
ready, blocked, resolved (matching and stale resolution) and re-scoped hands,
every original flow kind, missing scopes, unframed receipts, touched
registrations with and without their entry, roster and rake/ECO facts."""
import json, random, sys, uuid
from datetime import datetime, timedelta, timezone
seed, scale = int(sys.argv[1]), float(sys.argv[2])
clean = len(sys.argv) > 3 and sys.argv[3] == 'clean'
R = random.Random(seed)
def U(): return str(uuid.UUID(int=R.getrandbits(128), version=4))
def n(k): return max(1, int(k * scale))
UTC = timezone.utc
START = datetime(2026, 9, 21, 7, tzinfo=UTC); END = datetime(2026, 9, 28, 7, tzinfo=UTC)
FENCE = datetime(2026, 9, 18, 0, 41, 12, tzinfo=UTC)
def ts(d): return d.isoformat()
def q(v):
    if v is None: return 'NULL'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, (dict, list)): return "'" + json.dumps(v, separators=(',', ':')).replace("'", "''") + "'::jsonb"
    if isinstance(v, datetime): return "'" + ts(v) + "'"
    return "'" + str(v).replace("'", "''") + "'"
rows = {}
def add(t, **kw): rows.setdefault(t, []).append(kw)
tx = [5000]
def frame(at):
    tx[0] += 1
    add('union_pnl_transaction_frames', transaction_id=('xid', tx[0]), observed_at=at, book_start=None)
    return ('xid', tx[0])
def rand_time(a, b): return a + timedelta(seconds=R.uniform(0, (b - a).total_seconds()))
def money(lo=1, hi=500): return round(R.uniform(lo, hi), 2)

UN, VN = U(), U()
CU = [U(), U()]; CV = [U()]; C_ODD = U()
users = [U() for _ in range(n(60) + 10)]
def club_of(union): return R.choice(CU if union == UN else CV)
ev = [0]
def event(source, row_id, at, op, before, after, txid=None):
    ev[0] += 1
    txid = txid or frame(at)
    add('union_pnl_inventory_events', event_id=ev[0], source_name=source, row_id=row_id, observed_at=at,
        transaction_id=txid, operation=op, before_row=before, after_row=after)
    return txid

add('union_pnl_weekly_capture', singleton=True, captured_at=FENCE if R.random() > 0.04 or clean else START + timedelta(hours=1), contract_version=1)
add('union_pnl_inventory_capture', singleton=True, captured_at=FENCE - timedelta(hours=1), contract_version=1, source_counts={})

# roster
opening_union_clubs = []
for c in CU:
    rid = U(); row = {'id': rid, 'club_id': c, 'union_id': UN}
    if R.random() < 0.5 or clean:
        opening_union_clubs.append({'source_event_id': 1, 'row': row}); event('union_clubs', rid, FENCE, 'INSERT', None, row)
    else:
        event('union_clubs', rid, rand_time(START, END), 'INSERT', None, row)
event('union_clubs', U(), rand_time(START, END), 'INSERT', None, {'id': 'x', 'club_id': CV[0], 'union_id': VN})

# tournaments shared by both boundaries and the week
tours = []
for _ in range(n(24)):
    tid = U(); union = UN if R.random() < 0.75 else VN
    first = 'INSERT' if (clean or R.random() < 0.9) else 'UPDATE'
    row = {'id': tid, 'union_id': union, 'status': 'RUNNING'}
    event('tournaments', tid, FENCE + timedelta(minutes=R.randint(1, 900)), first, None if first == 'INSERT' else row, row)
    for _ in range(R.randint(0, 3)):
        event('tournaments', tid, rand_time(FENCE, END), 'UPDATE', row, row)
    tours.append((tid, union))

def tpfr(tid, reg, user, at, **kw):
    rid = U()
    d = dict(id=rid, transaction_id=frame(at), observed_at=at, registration_id=reg, tournament_id=tid, user_id=user,
             operation='register', purchase_key=U(), asset='chips', amount=money(), entitlement_id=U(), ledger_id=U(),
             wallet_transaction_id=U(), funding_club_id=None, registration_snapshot={'club_id': None, 'is_satellite_qualifier': False},
             tournament_snapshot={}, entitlement_snapshot={}, ledger_snapshot={}, wallet_snapshot={}, custody_result={})
    d.update(kw); add('tournament_participant_funding_receipts', **d); return d

credit_ledgers = []
def credit(tid, user, club, at, amount, entries, ledger=None, snapshot_union=None):
    led = ledger or U()
    add('tournament_accounting_credit_receipts', transaction_id=frame(at), id=U(), observed_at=at, idempotency_key=U(), tournament_id=tid,
        user_id=user, asset='chips', amount=amount, ledger_id=led, wallet_transaction_id=U(), payout_id=U(), credited_club_id=club,
        ledger_snapshot={}, wallet_snapshot={}, payout_snapshot={}, registration_snapshot={}, tournament_snapshot={'union_id': snapshot_union},
        entry_receipt_ids=('uuids', entries))
    credit_ledgers.append(led); return led

all_receipts = []
def registration(tid, union, before):
    reg, user = U(), R.choice(users); club = club_of(union)
    shape = 'normal' if clean else R.choice(['normal'] * 6 + ['rebuy', 'two_clubs', 'freeroll', 'satellite', 'ticket', 'late', 'none'])
    got = []
    if shape != 'none':
        at = before - timedelta(hours=R.randint(1, 60)) if shape != 'late' else before + timedelta(minutes=5)
        if shape == 'freeroll':
            got.append(tpfr(tid, reg, user, at, amount=0, ledger_id=None, entitlement_id=None, registration_snapshot={'club_id': club, 'is_satellite_qualifier': False}))
        elif shape == 'satellite':
            got.append(tpfr(tid, reg, user, at, amount=0, ledger_id=None, entitlement_id=None, registration_snapshot={'club_id': club, 'is_satellite_qualifier': True}))
        else:
            got.append(tpfr(tid, reg, user, at, funding_club_id=club))
        if shape == 'rebuy': got.append(tpfr(tid, reg, user, at + timedelta(minutes=3), funding_club_id=club, operation='rebuy'))
        if shape == 'two_clubs': got.append(tpfr(tid, reg, user, at, funding_club_id=C_ODD))
        if shape == 'ticket': got.append(tpfr(tid, reg, user, at, asset='ticket', funding_club_id=club))
    all_receipts.extend(got)
    # returns: credits and refund tranches before/after the boundary
    if got and R.random() < (0.3 if clean else 0.6):
        for _ in range(R.randint(1, 2)):
            kind = 'same' if clean else R.choice(['same', 'same', 'other_club', 'other_user', 'other_reg', 'late', 'empty'])
            entries = [got[0]['id']]
            cl, us, at = club, user, before - timedelta(minutes=R.randint(1, 50))
            if kind == 'other_club': cl = C_ODD
            if kind == 'other_user': us = R.choice(users)
            if kind == 'other_reg' and all_receipts: entries = [R.choice(all_receipts)['id']]
            if kind == 'late': at = before + timedelta(minutes=2)
            if kind == 'empty': entries = []
            credit(tid, us, cl, at, money(1, 50), entries, snapshot_union=union)
    if got and got[0]['entitlement_id'] and R.random() < 0.25:
        led = R.choice(credit_ledgers) if credit_ledgers and not clean and R.random() < 0.3 else U()
        add('tournament_refund_tranches', wallet_transaction_id=U(), idempotency_key=U(), tournament_id=tid, obligation_id=U(), user_id=user,
            source_wallet_club_id=club if clean or R.random() < 0.8 else C_ODD, entitlement_id=got[0]['entitlement_id'], credit_ledger_id=led,
            amount_paid_before=0, amount_paid_now=money(1, 30), refund_prize=0, refund_bounty=0, refund_fee=0, source='x', description='x',
            created_at=before, transaction_id=frame(before - timedelta(minutes=R.randint(1, 30)) if clean or R.random() < 0.85 else before + timedelta(minutes=1)))
    return {'id': reg, 'tournament_id': tid, 'user_id': user}

tables = [(U(), UN if R.random() < 0.7 else VN) for _ in range(n(30))]
cash_receipts = []
def cash_receipt(**kw):
    d = dict(id=U(), recorded_at=FENCE + timedelta(hours=1), operation_kind='buyin', operation_key=U(), user_id=R.choice(users), table_id=None,
             seat_id=U(), occupancy_id=U(), seat_joined_at=None, source_ledger_id=U(), wallet_transaction_id=U(), account_type='player',
             account_entity_id=U(), funding_club_id=None, funding_union_id=None, asset='chips', unit_scale=2, amount=money(),
             balance_before=0, balance_after=0, pending_addon_id=None, transaction_id=None)
    d.update(kw)
    if d['transaction_id'] is None and (clean or R.random() < 0.97): d['transaction_id'] = frame(d['recorded_at'])
    add('cash_participant_funding_receipts', **d); cash_receipts.append(d); return d

for B in (START, END):
    pop_tables = [{'source_event_id': 1, 'row': {'id': t, 'union_id': u, 'tournament_id': None}} for t, u in tables]
    seats = []
    for _ in range(0 if clean else n(14)):
        t, u = R.choice(tables); sid, occ, user = U(), U(), R.choice(users)
        club = club_of(u)
        shape = R.choice(['ok'] * 5 + ['no_buyin', 'two_owners', 'null_club', 'issue', 'bad_stack', 'neg_stack'])
        refs = []
        if shape != 'no_buyin':
            refs.append(cash_receipt(table_id=t, occupancy_id=occ, user_id=user, funding_club_id=None if shape == 'null_club' else club)['id'])
            if R.random() < 0.3: refs.append(cash_receipt(table_id=t, occupancy_id=occ, user_id=user, operation_kind='addon', funding_club_id=club)['id'])
            if shape == 'two_owners': refs.append(cash_receipt(table_id=t, occupancy_id=occ, user_id=user, operation_kind='addon', funding_club_id=C_ODD)['id'])
        add('hx_lineage', seat_id=sid, result={'issues': ['x'] if shape == 'issue' else [], 'funding_receipts': [{'id': r} for r in refs]})
        stack = {'bad_stack': '12.5', 'neg_stack': -3}.get(shape, money(0, 900))
        seats.append({'source_event_id': 1, 'row': {'id': sid, 'table_id': t, 'user_id': user, 'occupancy_id': occ, 'joined_at': ts(B - timedelta(hours=1)), 'stack': stack}})
    for _ in range(0 if clean else n(6)):
        t, u = R.choice(tables); rec_at = B - timedelta(hours=R.randint(1, 40)) if R.random() < 0.8 else B + timedelta(minutes=1)
        r = cash_receipt(table_id=t, operation_kind='addon', pending_addon_id=U(), recorded_at=rec_at, funding_club_id=None if R.random() < 0.1 else club_of(u))
        if R.random() < 0.6:
            app_at = B - timedelta(minutes=R.randint(1, 30)) if R.random() < 0.7 else B + timedelta(minutes=3)
            add('cash_funding_application_receipts', pending_addon_id=r['pending_addon_id'], funding_receipt_id=r['id'], applied_at=app_at,
                original_occupancy_id=U(), applied_occupancy_id=U(), applied=round(r['amount'] * R.choice([0.5, 1, 1.2]), 2), refunded=0,
                transaction_id=frame(app_at) if R.random() < 0.9 else None)
    pop_t, pop_p = [], []
    for tid, u in tours:
        if R.random() < 0.8:
            pop_t.append({'source_event_id': 1, 'row': {'id': tid, 'union_id': u, 'status': 'RUNNING'}})
            for _ in range(R.randint(0, n(8))):
                pop_p.append({'source_event_id': 1, 'row': registration(tid, u, B)})
    R.shuffle(pop_p)
    add('hx_inventory', boundary=B, result={'status': 'observed', 'population': {'tables': pop_tables, 'table_seats': seats, 'tournaments': pop_t,
        'tournament_players': pop_p, 'union_clubs': opening_union_clubs if B == START else []}, 'issues': []})

# the week: hands, flows, touched registrations, credits, receipts
def scope(union, club, tid=None, full=True):
    g = {'game_union_id': union, 'host_club_id': club, 'tournament_id': tid, 'is_private': False, 'asset': 'chips', 'unit_scale': 2}
    if not full: g.pop(R.choice(list(g)))
    return g
cash_rake = {c: 0 for c in CU}
for _ in range(n(400)):
    union = UN if R.random() < 0.85 else VN; club = club_of(union)
    at = rand_time(START, END) if R.random() < 0.9 else rand_time(START - timedelta(days=2), START)
    full = clean or R.random() > 0.02
    g = scope(union, club, full=full)
    parts = []
    for _ in range(R.randint(2, 6)):
        pc, pu, d = club_of(union), R.choice(users), money(-60, 60)
        parts.append({'earning_club_id': pc, 'user_id': pu, 'observed_stack_delta': d})
        if clean and union == UN and START <= at < END:
            buy = money(100, 200); tbl = R.choice([t for t, u2 in tables if u2 == UN] or [U()])
            for kind, amount in (('funding', buy), ('return', round(buy + d, 2))):
                if amount <= 0: continue
                led = U(); txid = frame(at)
                if kind == 'funding':
                    cash_receipt(source_ledger_id=led, funding_club_id=pc, user_id=pu, amount=amount, table_id=tbl, recorded_at=at)
                    snap = {'status': 'posted', 'amount': amount, 'club_id': pc, 'to_type': 'table_stack', 'category': 'buyin', 'table_id': tbl}
                else:
                    occ, ent = U(), U()
                    cash_receipt(table_id=tbl, occupancy_id=occ, funding_club_id=pc, user_id=pu, account_type='player', account_entity_id=ent, recorded_at=at)
                    event('table_seats', U(), at, 'UPDATE', None, {'occupancy_id': occ, 'table_id': tbl}, txid=txid)
                    snap = {'status': 'posted', 'amount': amount, 'club_id': pc, 'from_type': 'table_stack', 'to_type': 'player', 'to_entity_id': ent, 'category': 'cashout', 'table_id': tbl}
                add('union_pnl_original_flows', ledger_id=led, transaction_id=txid, recognized_at=at, game_scope=scope(UN, pc), ledger_snapshot=snap)
    rake = money(0, 5)
    if union == UN and START <= at < END and full: cash_rake[club] += rake
    status = 'ready' if clean or R.random() < 0.8 else 'blocked'
    evid = {'status': status, 'basis_certified': status == 'ready' and (clean or R.random() < 0.95), 'all_players_included': clean or R.random() < 0.97,
            'game_scope': g if clean or R.random() < 0.97 else scope(union, C_ODD), 'participants': parts, 'accepted_rake': rake}
    hid, tbl, hn = U(), U(), R.randint(1, 10**6)
    add('union_pnl_cash_outcomes', table_id=tbl, hand_number=hn, hand_id=hid, transaction_id=frame(at), recognized_at=at, payload_hash=U(), game_scope=g, evidence=evid)
    if status != 'ready' or not evid['basis_certified']:
        if R.random() < 0.6: add('hx_resolve', table_id=tbl, hand_number=hn, hand_id=hid, stale=R.random() < 0.25)

if not clean:
    for _ in range(n(120)):
        union = UN if R.random() < 0.85 else VN; club = club_of(union); at = rand_time(START, END); led = U(); txid = frame(at)
        kind = R.choice(['cash_funding', 'cash_return', 'cash_return_app', 'tournament_funding', 'tournament_return', 'unsupported'])
        amount = money(); tbl = R.choice(tables)[0]; tid = None
        snap = {'status': 'posted' if R.random() < 0.95 else 'pending', 'amount': amount if R.random() < 0.97 else '1.001', 'club_id': club, 'table_id': tbl}
        if kind == 'cash_funding':
            cash_receipt(source_ledger_id=led, funding_club_id=club, amount=amount if R.random() < 0.9 else amount + 1, table_id=tbl, recorded_at=at)
            snap.update(to_type='table_stack', category=R.choice(['buyin', 'rebuy', 'addon', 'bogus']))
        elif kind in ('cash_return', 'cash_return_app'):
            ent, occ = U(), U()
            owners = 1 if R.random() < 0.8 else 2
            for i in range(owners):
                cash_receipt(table_id=tbl, occupancy_id=occ, funding_club_id=club, account_type='player', account_entity_id=ent, recorded_at=at, user_id=R.choice(users))
            if kind == 'cash_return':
                event('table_seats', U(), at, 'UPDATE', None, {'occupancy_id': occ, 'table_id': tbl}, txid=txid)
            else:
                orig = cash_receipt(table_id=tbl, occupancy_id=occ, operation_kind='addon', pending_addon_id=U(), funding_club_id=club, recorded_at=at)
                add('cash_funding_application_receipts', pending_addon_id=orig['pending_addon_id'], funding_receipt_id=orig['id'], applied_at=at,
                    original_occupancy_id=occ, applied_occupancy_id=occ, applied=0, refunded=amount if R.random() < 0.8 else amount + 1, transaction_id=txid)
            snap.update(from_type='table_stack', to_type='player', to_entity_id=ent, category=R.choice(['cashout', 'refund']))
        elif kind == 'tournament_funding':
            tid, tu = R.choice(tours)
            tpfr(tid, U(), R.choice(users), at, ledger_id=led, funding_club_id=club, amount=amount)
            snap.update(to_type='prize_liability', category='tournament_buyin')
        elif kind == 'tournament_return':
            tid, tu = R.choice(tours)
            credit(tid, R.choice(users), club, at, amount, [R.choice(all_receipts)['id']] if all_receipts else [], ledger=led, snapshot_union=tu)
            snap.update(from_type='prize_liability', category='tournament_prize')
        g = scope(union, club, tid, full=R.random() > 0.03)
        if R.random() < 0.02: g['unit_scale'] = 3
        add('union_pnl_original_flows', ledger_id=led, transaction_id=txid, recognized_at=at, game_scope=g, ledger_snapshot=snap)
    # registrations touched this week, with and without their original entry
    for _ in range(n(40)):
        tid, u = R.choice(tours); reg = U(); at = rand_time(START, END)
        event('tournament_players', reg, at, R.choice(['INSERT', 'UPDATE']), None, {'id': reg, 'tournament_id': tid, 'user_id': R.choice(users)})
        c = R.random()
        if c < 0.6: tpfr(tid, reg, R.choice(users), at, funding_club_id=club_of(u))
        elif c < 0.7: tpfr(tid, reg, R.choice(users), at, asset='ticket')
        elif c < 0.8: tpfr(tid, reg, R.choice(users), at, amount=0, ledger_id=None, entitlement_id=None, registration_snapshot={'club_id': None, 'is_satellite_qualifier': True})
    # unframed receipts after the capture fence
    for _ in range(R.randint(0, 2)): cash_receipt(recorded_at=rand_time(FENCE, END), transaction_id=('null', 0))
    for _ in range(R.randint(0, 2)):
        add('cash_hand_provenance_receipts', table_id=U(), hand_number=R.randint(1, 9999), hand_id=U(), accepted_at=rand_time(FENCE, END),
            transaction_id=None if R.random() < 0.5 else frame(START))
else:
    for _ in range(n(10)):
        tid, u = R.choice([t for t in tours if t[1] == UN] or tours); reg = U(); at = rand_time(START, END)
        event('tournament_players', reg, at, 'INSERT', None, {'id': reg, 'tournament_id': tid, 'user_id': R.choice(users)})
        tpfr(tid, reg, R.choice(users), at, funding_club_id=club_of(u))
for c in CU:
    rk = round(cash_rake[c], 2)
    if not clean and R.random() < 0.3: rk = round(rk + 0.5, 2)
    add('accounting_payable_earning_sources', source_type='cash_rake_accrual', club_id=c, union_id=UN, earned_at=rand_time(START, END), rake_credit=rk)
    if R.random() < 0.5: add('accounting_payable_earning_sources', source_type='tournament_fee_accrual', club_id=c, union_id=UN, earned_at=rand_time(START, END), rake_credit=money(1, 20))
    add('hx_rake_basis', union_id=UN, club_id=c, payout=money(0, 30))
terms = {'eco_enabled': True, 'eco_rate': R.choice([0.05, 0.1, 0.125]), 'eco_base_mode': R.choice(['club_cash_profit', 'net_invoice_position', 'winnings_plus_rake', 'winnings_only'])}
segs = [{'terms': terms}] + ([{'terms': dict(terms, eco_rate=0.2)}] if not clean and R.random() < 0.1 else [])
add('hx_eco', union_id=UN, result={'status': 'ready' if clean or R.random() < 0.95 else 'blocked', 'segments': segs})

out = ['BEGIN;']
for t, rs in rows.items():
    if t == 'hx_resolve': continue
    cols = list(rs[0].keys())
    for i in range(0, len(rs), 500):
        vals = []
        for r in rs[i:i + 500]:
            vs = []
            for c in cols:
                v = r[c]
                if isinstance(v, tuple) and v[0] == 'xid': vs.append(f"'{v[1]}'::xid8")
                elif isinstance(v, tuple) and v[0] == 'null': vs.append('NULL')
                elif isinstance(v, tuple) and v[0] == 'uuids': vs.append("ARRAY[" + ','.join(q(x) for x in v[1]) + "]::uuid[]")
                else: vs.append(q(v))
            vals.append('(' + ','.join(vs) + ')')
        out.append(f"INSERT INTO public.{t}({','.join(cols)}) VALUES\n" + ',\n'.join(vals) + ';')
out.append("UPDATE public.union_pnl_transaction_frames SET book_start=public.fn_union_week_start(observed_at);")
for r in rows.get('hx_resolve', []):
    out.append(f"INSERT INTO public.union_pnl_cash_outcome_resolutions SELECT table_id,hand_number,hand_id,payload_hash,"
               f"{'md5(evidence::text)' if not r['stale'] else 'md5(evidence::text||$$x$$)'},'late_seat_credit','{{}}','harness','harness',now() "
               f"FROM public.union_pnl_cash_outcomes WHERE hand_id='{r['hand_id']}';")
out.append('COMMIT;')
out.insert(1, f"INSERT INTO public.hx_meta VALUES('{UN}','{VN}');")
print('\n'.join(out))
