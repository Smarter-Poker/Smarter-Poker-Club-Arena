"""Read-only population check: tournament hand sequences, dead buttons and dead small blinds, per window.
argv: <ws-iso> <we-iso> <out.json>. Window on record atMs (accepted_hand) / decisionTimeMs (decision)."""
import os, sys, gzip, json, time, calendar
from collections import Counter, defaultdict
DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments', '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
def ep(s):
    b = s.replace('Z', '').split('.')[0]
    return calendar.timegm(time.strptime(b, '%Y-%m-%dT%H:%M:%S'))
ws, we, outp = sys.argv[1:4]
WS, WE = ep(ws), ep(we)
cand = []
for d in DIRS:
    with os.scandir(d) as it:
        for e in it:
            if not e.name.endswith('.ndjson.gz'): continue
            try: m = e.stat().st_mtime
            except FileNotFoundError: continue
            if WS - 120 <= m <= WE + 900: cand.append((m, e.path))
cand.sort()
hands = {}                 # handKey(str from body) -> info
lifecycle = Counter(); lc_fail = Counter(); lc_fail_ids = []
dec = Counter(); dec_dead_ids = []; dec_tables = set(); dec_p4_ids = []
rel = Counter()
for n, (m, p) in enumerate(cand):
    try: raw = gzip.decompress(open(p, 'rb').read()).decode()
    except Exception: continue
    for line in raw.rstrip('\n').split('\n'):
        try: r = json.loads(line)
        except Exception: continue
        k = r.get('kind')
        if k == 'accepted_hand':
            if not (WS * 1000 <= r['atMs'] < WE * 1000): continue
            b = json.loads(r['body'])
            pn = next((a['publicNode'] for a in b.get('actions', []) if isinstance(a, dict) and a.get('publicNode')), None)
            if not pn: continue
            hk = b.get('handKey') or ''
            table, _, gen = hk.rpartition(':')
            forced = [(a.get('action'), a.get('seat')) for a in b['actions'] if a.get('origin') == 'forced']
            sb = [s for a, s in forced if a == 'sb']; bb = [s for a, s in forced if a == 'bb']
            hands[hk] = {'table': table, 'gen': int(gen) if gen.isdigit() else -1, 'mode': pn.get('mode'), 'variant': pn.get('variant'),
                         'dealer': pn.get('dealerSeat'), 'dealt': sorted(x[0] for x in pn.get('seats') or []),
                         'sb': sb[0] if sb else None, 'bb': bb[0] if bb else None, 'bomb': pn.get('bombPot'),
                         'rel': r['sourceRelease'], 'atMs': r['atMs'], 'eventId': r['eventId'], 'committedHandId': b.get('committedHandId')}
            rel[r['sourceRelease']] += 1
        elif k == 'request_lifecycle':
            if not (WS * 1000 <= r['atMs'] < WE * 1000): continue
            b = json.loads(r['body'])
            if b.get('phase') == 'terminal':
                oc = {x: b.get(x) for x in b if x not in ('request', 'origin', 'phase', 'version')}
                key = json.dumps(oc, sort_keys=True)[:200]
                lifecycle[key if not key.startswith('{"outcome": "success"') else 'success'] += 1
        elif k == 'decision':
            b = json.loads(r['body']); s = b['snapshot']; gs = s['gameState']; dt = s['decisionTimeMs']
            if not (WS * 1000 <= dt < WE * 1000) or gs.get('gameMode') != 'tournament': continue
            dealt = gs.get('dealtSeatIds') if isinstance(gs.get('dealtSeatIds'), list) else [p_['seat'] for p_ in gs['players']]
            v = gs.get('gameVariant')
            dec['tournament_decisions'] += 1; dec['tournament_decisions_' + str(v)] += 1
            dec_tables.add((s.get('fence') or '').split(':')[0])
            if len(dealt) >= 3: dec['tournament_3plus'] += 1; dec['tournament_3plus_' + str(v)] += 1
            if gs.get('dealerSeat') not in dealt:
                dec['dead_button_decisions'] += 1; dec['dead_button_decisions_' + str(v)] += 1
                if len(dec_dead_ids) < 30: dec_dead_ids.append({'eventId': r['eventId'], 'variant': v, 'dealer': gs.get('dealerSeat'), 'dealt': dealt, 'blindSeats': gs.get('blindSeats', 'absent'), 'release': r['sourceRelease']})
            bs = gs.get('blindSeats')
            if isinstance(bs, dict) and bs.get('smallBlind', 0) is None: dec['dead_sb_decisions'] += 1; dec['dead_sb_decisions_' + str(v)] += 1
            if v == 'plo4' and len(dealt) >= 3 and (gs.get('dealerSeat') not in dealt or (isinstance(bs, dict) and bs.get('smallBlind', 0) is None)):
                p4 = (b.get('decision') or {}).get('plo4Policy')
                oc = 'no_receipt' if not isinstance(p4, dict) else ('eligible' if p4.get('eligible') is True and isinstance(p4.get('inputs'), dict) else 'refused:' + str(p4.get('reason')))
                kind = ('dead_button' if gs.get('dealerSeat') not in dealt else 'occupied_button') + '+' + ('dead_sb' if isinstance(bs, dict) and bs.get('smallBlind', 0) is None else 'live_sb')
                dec['plo4_' + kind + ':' + oc] += 1
                if oc == 'eligible':
                    inp = p4['inputs']; c_ = inp['census']; pos = inp['positions']
                    if len(dec_p4_ids) < 12: dec_p4_ids.append({'eventId': r['eventId'], 'kind': kind, 'dealer': gs.get('dealerSeat'), 'dealt': dealt, 'blindSeats': bs, 'censusBlindSeats': c_.get('blindSeats'), 'hero': [c_.get('heroSeat'), pos.get('hero'), pos.get('heroOffset')], 'aggressor': [pos.get('aggressorSeat'), pos.get('aggressor')], 'binding': inp.get('version')})
    if n % 20000 == 0: print(time.strftime('%H:%M:%S'), n, len(cand), len(hands), file=sys.stderr, flush=True)
# sequences
by_table = defaultdict(list)
for hk, h in hands.items():
    if h['mode'] == 'tournament': by_table[h['table']].append(h)
c = Counter(); trans = []; examples = defaultdict(list)
vc = defaultdict(Counter); vtables = defaultdict(set); vtables3 = defaultdict(set)
for t, hs in by_table.items():
    hs.sort(key=lambda h: (h['gen'], h['atMs']))
    for h in hs:
        c['tournament_hands'] += 1; c['dealt_%d' % len(h['dealt'])] += 1
        V = str(h['variant']); vc[V]['hands'] += 1; vc[V]['dealt_%d' % len(h['dealt'])] += 1; vtables[V].add(t)
        if len(h['dealt']) >= 3:
            c['hands_3plus'] += 1; vc[V]['hands_3plus'] += 1; vtables3[V].add(t)
            if h['dealer'] not in h['dealt']: c['dead_button_hands'] += 1; vc[V]['dead_button_hands'] += 1
            if h['bb'] is not None and h['sb'] is None and not h['bomb']: c['dead_sb_hands'] += 1; vc[V]['dead_sb_hands'] += 1
    for a, b in zip(hs, hs[1:]):
        gone = set(a['dealt']) - set(b['dealt'])
        if not gone: continue
        c['transitions_with_departure'] += 1; vc[str(b['variant'])]['transitions_with_departure'] += 1
        if len(b['dealt']) < 3: c['departure_next_hand_headsup'] += 1; continue
        for role in ('sb', 'bb', 'dealer'):
            if a[role] in gone:
                key = role + '_departed'
                c[key] += 1
                nxt_dead_btn = b['dealer'] not in b['dealt']
                nxt_dead_sb = b['bb'] is not None and b['sb'] is None
                outcome = ('dead_button' if nxt_dead_btn else 'button_on_dealt_seat') + '/' + ('dead_sb' if nxt_dead_sb else 'live_sb')
                c[key + ':' + outcome] += 1; vc[str(b['variant'])][key + ':' + outcome] += 1
                c[key + ':button_moved_to_prev_sb' if b['dealer'] == a['sb'] else key + ':button_not_prev_sb'] += 1
                if len(examples[key + ':' + outcome]) < 6:
                    examples[key + ':' + outcome].append({'table': t, 'prev': {x: a[x] for x in ('gen', 'dealer', 'dealt', 'sb', 'bb', 'eventId', 'committedHandId', 'rel')},
                                                          'next': {x: b[x] for x in ('gen', 'dealer', 'dealt', 'sb', 'bb', 'eventId', 'committedHandId', 'rel')}})
out = {'window': [ws, we], 'segmentsRead': len(cand), 'acceptedHandsByRelease': dict(rel), 'tournamentTables': len(by_table),
       'decisionTournamentTables': len(dec_tables), 'counts': dict(sorted(c.items())), 'decisions': dict(dec), 'deadButtonDecisionIds': dec_dead_ids, 'plo4DeadButtonOrDeadSbEligibleSamples': dec_p4_ids,
       'examples': examples, 'byVariant': {k: dict(sorted(v.items())) for k, v in vc.items()},
       'tablesByVariant': {k: len(v) for k, v in vtables.items()}, 'tables3plusByVariant': {k: len(v) for k, v in vtables3.items()}, 'lifecycleTerminal': dict(lifecycle.most_common(40))}
json.dump(out, open(outp, 'w'), indent=1)
