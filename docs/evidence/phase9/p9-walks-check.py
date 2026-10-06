"""Phase 9 uncalled-money check (declaration-walks.txt). Read-only analysis of
the population W export (p9-export-walks.sql). No hand is scored: it replays
contributions (same rules as p9-natural-compare.mts), applies the engine's
stated returnUncalledBet rule (5c7d15db) and the deduction rules, and prints
aggregates. Usage: python3 p9-walks-check.py <label> <files...>"""
import sys, json, hashlib, collections, math
label, files = sys.argv[1], sys.argv[2:]
C = lambda x: int(math.floor(float(x) * 100 + 0.5))  # half up, like Math.round
R = lambda x: int(math.floor(x + 0.5 + 1e-9))
hid = lambda i: hashlib.sha256(i.encode()).hexdigest()[:12]
class Ex(Exception): pass
agg = collections.defaultdict(collections.Counter)
examples = collections.defaultdict(list)
totals = collections.Counter()
def mode_of(h):
    if h.get('tour'): return 'tournament'
    a = (h.get('pn') or {}).get('asset')
    return 'cash_diamonds' if a == 'diamonds' else 'cash_chips' if a == 'chips' else 'cash_asset_not_captured'
def replay(h):
    seat = {p['u']: p['s'] for p in h['players'] or []}
    contrib = collections.Counter(); street = collections.Counter(); returned = collections.Counter()
    shared = collections.Counter(); folded = set(); stage = None
    acts = [a for a in (h['actions'] or []) if a.get('u') and a['u'] != 'system']
    at = (h.get('pn') or {}).get('anteType')
    dead_antes = [a for a in acts if a['a'] == 'ante' and a.get('d') is True]
    if dead_antes and at not in ('per_player', 'big_blind'): raise Ex('ante_type_unknown')
    shared_ante = at == 'big_blind'
    deferred = []
    for i, a in enumerate(acts):
        u = a['u']
        if u not in seat: raise Ex('actor_not_in_players')
        if a.get('st') != stage: stage = a.get('st'); street.clear()
        m = C(a.get('m') or 0); k = a['a']
        def add(c, live):
            contrib[u] += c
            if live: street[u] += c
        if k in ('ante', 'bomb_ante'):
            add(m, a.get('d') is False)
            if k == 'ante' and a.get('d') is True and shared_ante: shared[u] += m
        elif k == 'post':
            add(m, a.get('d') is not True)
            if a.get('d') is True: shared[u] += m
        elif k in ('sb', 'bb', 'straddle', 'call', 'bet', 'kill_blind'):
            add(m, True)
        elif k in ('raise', 'all_in'):
            nxt = next((x['pn_total'] for x in acts[i+1:] if x.get('pn_total')), None)
            s = str(seat[u]); before = contrib[u]
            if nxt and s in nxt and C(nxt[s]) == before + m: add(m, True)
            elif nxt and s in nxt and C(nxt[s]) == before + m - street[u]: add(m - street[u], True)
            elif street[u] == 0: add(m, True)
            else: deferred.append((u, street[u])); add(m, True)
        elif k == 'return':
            returned[u] += m
        elif k == 'fold':
            folded.add(u)
        elif k in ('check', 'discard'):
            pass  # no chips move (discard: pineapple card discard)
        else:
            raise Ex('unhandled_action:' + k)
        nxt = acts[i+1].get('pn_total') if i + 1 < len(acts) else None
        if nxt:
            for uu, ss in seat.items():
                if str(ss) in nxt and C(nxt[str(ss)]) != contrib[uu] - returned[uu]:
                    raise Ex('replay_disagrees_with_capture')
    pot = C(h['pot']) if h.get('pot') is not None else None
    if deferred:
        tot = sum(contrib.values()) - sum(returned.values())
        if len(deferred) == 1 and pot is not None and tot - pot == deferred[0][1]:
            contrib[deferred[0][0]] -= deferred[0][1]
        else:
            raise Ex('unresolved_raise_amount')
    return seat, contrib, returned, shared, folded
for f in files:
    for line in open(f):
        if not line.strip(): continue
        h = json.loads(line)
        md, v = mode_of(h), h['variant']
        cell = agg[(md, v)]
        cell['hands'] += 1
        if h['walk']: cell['walks'] += 1
        onep_pots = [p for p in (h.get('pots') or []) if isinstance(p.get('eligible'), list) and len(p['eligible']) == 1]
        if onep_pots: cell['handsWithOnePlayerPot'] += 1; cell['onePlayerPots'] += len(onep_pots)
        try:
            if h.get('pots') is None: raise Ex('pots_not_recorded')
            seat, contrib, returned, shared, folded = replay(h)
        except Ex as e:
            cell['excluded:' + str(e)] += 1
            continue
        matched = {u: contrib[u] - shared[u] for u in contrib if contrib[u] - shared[u] > 0}
        order = sorted(matched.items(), key=lambda kv: -kv[1])
        expected, top = 0, None
        if len(order) >= 2 and order[0][1] > order[1][1] and order[0][0] not in folded:
            top = order[0][0]; expected = order[0][1] - order[1][1]
        single_contributor = len(order) == 1
        rec_ret = sum(returned.values())
        if expected > 0:
            if returned.get(top, 0) == expected and rec_ret == expected: refund = 'refund_ok'
            elif rec_ret == 0: refund = 'not_refunded'
            else: refund = 'refund_amount_wrong'
        else:
            refund = 'refund_where_none_due' if rec_ret else ('single_contributor_nothing_due' if single_contributor else 'nothing_due')
        # uncontested money left after the recorded refund
        post = {u: contrib[u] - returned[u] - shared[u] for u in contrib}
        post = {u: x for u, x in post.items() if x > 0}
        po = sorted(post.items(), key=lambda kv: -kv[1])
        leftover = po[0][1] - po[1][1] if len(po) >= 2 and po[0][1] > po[1][1] and po[0][0] not in folded else 0
        cell['refund:' + refund] += 1
        if onep_pots:
            kind = 'uncontested_money' if leftover > 0 else ('single_contributor' if single_contributor else 'genuine')
            cell['onePlayerPotHands:' + kind] += 1
            if kind == 'uncontested_money' and len(examples[(md, v)]) < 10:
                examples[(md, v)].append({'hand': hid(h['id']), 'createdAt': h['created_at'][:19] + 'Z', 'walk': h['walk'], 'potSize': h['pot'],
                    'recordedPots': [[p['amount'], len(p['eligible'])] for p in h['pots']], 'expectedRefundCents': expected, 'recordedRefundCents': rec_ret,
                    'leftoverUncontestedCents': leftover, 'rake': h.get('rake'), 'bbj': h.get('bbj')})
        if h['walk']:
            if refund == 'refund_ok': w = 'walk_refunded'
            elif refund == 'not_refunded' and onep_pots and leftover > 0: w = 'walk_excess_in_one_player_pot'
            elif refund in ('nothing_due', 'single_contributor_nothing_due'): w = 'walk_' + refund
            else: w = 'walk_other_' + refund
            cell[w] += 1
        # deductions on these hands
        rake, bbj = C(h.get('rake') or 0), C(h.get('bbj') or 0)
        if md == 'tournament':
            cell['deduction:' + ('ok' if rake == 0 and bbj == 0 else 'tournament_nonzero')] += 1
        else:
            d = (h.get('pn') or {}).get('deductions')
            cc = h.get('cc') or []
            flop = len(cc) >= 3 or bool(h.get('rit')) or bool(h.get('cc2'))
            if not d or d.get('status') != 'captured' or not d.get('rake'):
                cell['deduction:unknown_not_captured'] += 1
            else:
                dealt = len(h['players'] or [])
                caps = sorted(d['rake'].get('playerCountCaps') or [], key=lambda t: -t[0])
                tier = next((t for t in caps if dealt >= t[0]), None)
                cap = C(tier[1] if tier else d['rake']['cap'])
                pct = min(d['rake']['percent'], 5) if dealt <= 2 else d['rake']['percent']
                potc = C(h['pot'])
                exp_rake = 0 if (d['rake'].get('noFlopNoDrop') and not flop) else min(R(potc * pct / 100), cap)
                b = d.get('bbj')
                exp_bbj = C(float(h['bb']) * b['feeBB']) if (b and b.get('enabled') and flop and dealt >= b['minPlayersDealt']) else 0
                ok = exp_rake == rake and exp_bbj == bbj
                cell['deduction:' + ('ok' if ok else 'mismatch')] += 1
                if not ok and len(examples[('deduction', md, v)]) < 10:
                    examples[('deduction', md, v)].append({'hand': hid(h['id']), 'expectedRakeCents': exp_rake, 'recordedRakeCents': rake, 'expectedBbjCents': exp_bbj, 'recordedBbjCents': bbj, 'flop': flop, 'dealt': dealt})
                if leftover > 0:
                    # rake the engine's rule would take after the correct refund
                    pc = potc - leftover
                    cell['overRakeCents'] += rake - (0 if (d['rake'].get('noFlopNoDrop') and not flop) else min(R(pc * pct / 100), cap))
out = {'label': label, 'files': len(files), 'cells': {f'{m}|{v}': dict(c) for (m, v), c in sorted(agg.items())},
       'examples': {('|'.join(k)): ex for k, ex in examples.items()}}
tot = collections.Counter()
for c in agg.values(): tot.update(c)
out['totals'] = dict(tot)
print(json.dumps(out, indent=1))
