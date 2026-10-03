"""PLO4 tournament decisions by format / seatsPerTable / tournament, and dead-button counts. argv ws we out"""
import os, sys, gzip, json, time, calendar
from collections import Counter, defaultdict
DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments', '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
ep = lambda s: calendar.timegm(time.strptime(s.replace('Z', '').split('.')[0], '%Y-%m-%dT%H:%M:%S'))
ws, we, outp = sys.argv[1:4]; WS, WE = ep(ws), ep(we)
cand = []
for d in DIRS:
    with os.scandir(d) as it:
        for e in it:
            if e.name.endswith('.ndjson.gz'):
                try: m = e.stat().st_mtime
                except FileNotFoundError: continue
                if WS - 120 <= m <= WE + 900: cand.append(e.path)
by = Counter(); tours = defaultdict(lambda: {'decisions': 0, 'dead_button': 0, 'maxDealt': 0, 'tables': set(), 'format': None, 'seatsPerTable': None, 'status': Counter(), 'playersLeft': []})
for p in cand:
    try: raw = gzip.decompress(open(p, 'rb').read()).decode()
    except Exception: continue
    for line in raw.rstrip('\n').split('\n'):
        if '"kind":"decision"' not in line: continue
        r = json.loads(line); b = json.loads(r['body']); s = b['snapshot']; gs = s['gameState']
        if gs.get('gameMode') != 'tournament' or gs.get('gameVariant') != 'plo4' or not (WS * 1000 <= s['decisionTimeMs'] < WE * 1000): continue
        t = gs.get('tournament') or {}
        dealt = gs.get('dealtSeatIds') or [x['seat'] for x in gs['players']]
        dead = gs.get('dealerSeat') not in dealt
        key = (gs.get('format'), t.get('seatsPerTable'))
        by[str(key)] += 1
        if dead: by['dead_button ' + str(key)] += 1
        T = tours[str(t.get('tournamentId'))]
        T['decisions'] += 1; T['dead_button'] += dead; T['maxDealt'] = max(T['maxDealt'], len(dealt)); T['tables'].add((s.get('fence') or '').split(':')[0])
        T['format'] = gs.get('format'); T['seatsPerTable'] = t.get('seatsPerTable'); T['status'][str(t.get('tournamentStatus'))] += 1
        T['playersLeft'].append(t.get('playersLeft'))
out = {'window': [ws, we], 'byFormatSeats': dict(by), 'tournamentsWithMaxDealtAtLeast4': {k: {'decisions': v['decisions'], 'dead_button': v['dead_button'], 'maxDealt': v['maxDealt'], 'tables': len(v['tables']), 'format': v['format'], 'seatsPerTable': v['seatsPerTable'], 'status': dict(v['status']), 'playersLeftRange': [min(x for x in v['playersLeft'] if x is not None) if any(x is not None for x in v['playersLeft']) else None, max((x for x in v['playersLeft'] if x is not None), default=None)]} for k, v in tours.items() if v['maxDealt'] >= 4},
       'tournaments': len(tours), 'tournamentsByMaxDealt': dict(Counter(v['maxDealt'] for v in tours.values()))}
json.dump(out, open(outp, 'w'), indent=1)
