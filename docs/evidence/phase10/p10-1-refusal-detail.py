"""P10.1 natural evidence, follow-up detail (read-only, engine host, nice 19 / ionice idle).

Not a declared check. Characterises three things the declared scan counted but did not
itemise: (1) the sub-condition behind each canonical_state_unavailable refusal, (2) the
ante behind each depth_or_ante_outside_pack refusal whose depth is inside the pack, and
(3) the record whose accepted action differs from the PLO4 baseline. Same window,
release and population definition as p10-1-journal-observe.py. Segment and record
integrity were already verified by that scan; this pass only re-reads the same files.

argv: <window-start-iso> <window-end-iso> <serving-release-sha> <out.json>
"""
import os, sys, gzip, json, time, calendar
from collections import Counter

DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
ws_iso, we_iso, release, out_path = sys.argv[1:5]
ep = lambda s: calendar.timegm(time.strptime(s.replace('Z', ''), '%Y-%m-%dT%H:%M:%S'))
WS, WE = ep(ws_iso), ep(we_iso)
cand = []
for d in DIRS:
    with os.scandir(d) as it:
        for e in it:
            if not e.name.endswith('.ndjson.gz'): continue
            try: m = e.stat().st_mtime
            except FileNotFoundError: continue
            if WS - 120 <= m <= WE + 1800: cand.append((m, e.path))
cand.sort()

def canonical_reason(gs, hero, baseline):
    """The first failing condition of Plo4LivePolicy's canonical-state checks (order at 46bb9cf6)."""
    players = gs.get('players') or []
    ids = gs.get('dealtSeatIds')
    ids = [p.get('seat') for p in players] if ids is None else ids
    hs = hero.get('seat')
    if not isinstance(ids, list) or len(ids) < 2: return 'dealt_census_fewer_than_2_or_not_list'
    if len(ids) > 10: return 'dealt_census_more_than_10'
    if any(not isinstance(i, int) or i < 1 or i > 10 for i in ids): return 'dealt_seat_id_out_of_range'
    if any(not any(p.get('seat') == i for p in players) for i in ids): return 'dealt_seat_not_in_player_list'
    if len(set(ids)) != len(ids): return 'dealt_seat_duplicate'
    if hs not in ids: return 'hero_not_in_dealt_census'
    if any(((not p.get('is_folded') and not p.get('is_sitting_out')) or p.get('is_all_in')) and p.get('seat') not in ids for p in players):
        return 'live_player_missing_from_dealt_census'
    seats = [p for p in players if p.get('seat') in ids]
    if gs.get('stateSchemaVersion') != 1: return 'state_schema_version'
    if gs.get('bettingStructure') != 'pot_limit': return 'betting_structure'
    if len(seats) < 2: return 'fewer_than_2_dealt_players'
    if gs.get('gameMode') not in ('cash', 'tournament'): return 'game_mode'
    if not any(p.get('user_id') == hero.get('user_id') and p.get('seat') == hs and p.get('stack') == hero.get('stack')
               and p.get('bet') == hero.get('bet') and p.get('totalInvested') == hero.get('totalInvested') for p in seats):
        return 'hero_snapshot_mismatch'
    if not any(p.get('seat') == gs.get('dealerSeat') for p in seats): return 'dealer_seat_not_dealt'
    if len({p.get('seat') for p in seats}) != len(seats): return 'duplicate_seat'
    if len({p.get('user_id') for p in seats}) != len(seats): return 'duplicate_user'
    if baseline not in (gs.get('legalActions') or []): return 'baseline_action_not_legal'
    return 'no_canonical_condition_reproduced'

canon = Counter(); canon_ids = []; canon_detail = Counter()
ante = []; c7 = []; later_changed = {}
execs = {}
n = 0
for m, path in cand:
    try:
        with open(path, 'rb') as f: lines = gzip.decompress(f.read()).decode('utf-8').rstrip('\n').split('\n')
    except Exception: continue
    for line in lines:
        if '\\"plo4\\"' not in line and '"plo4"' not in line: continue
        r = json.loads(line)
        if r.get('kind') == 'execution':
            w = json.loads(r['body'])
            if (w.get('identity') or {}).get('variant') == 'plo4':
                aa = w.get('acceptedActions') or []
                execs[(r['producerId'], r['turnKey'])] = {'eventId': r['eventId'], 'executionStatus': w.get('executionStatus'),
                    'accepted': {k: v for k, v in aa[0].get('record', {}).items() if k != 'userId'} if len(aa) == 1 else None, 'selected': w.get('selected')}
            continue
        if r.get('kind') != 'decision' or r.get('sourceRelease') != release: continue
        b = json.loads(r['body']); s = b['snapshot']; gs = s['gameState']
        if not (WS * 1000 <= s['decisionTimeMs'] < WE * 1000) or gs.get('gameVariant') != 'plo4': continue
        if gs.get('boardCount', 1) not in (1, None) or gs.get('communityCards2') or gs.get('communityCards3'): continue
        tr = b['decision'].get('policyGraph', {}).get('transitions', [])
        vp = [t for t in tr if t.get('node') == 'variant_policy']
        if not vp: continue
        n += 1
        p = b['decision'].get('plo4Policy') or {}
        ident = {'eventId': r['eventId'], 'producerId': r['producerId'], 'sequence': r['sequence'], 'handKey': r['handKey'], 'turnKey': r['turnKey'],
                 'decisionTime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(s['decisionTimeMs'] / 1000)), 'gameMode': gs.get('gameMode'), 'street': gs.get('stage')}
        if p.get('reason') == 'canonical_state_unavailable':
            why = canonical_reason(gs, s.get('player') or {}, (vp[0].get('before') or {}).get('action'))
            canon[why] += 1
            canon_detail[(why, gs.get('gameMode'), gs.get('stage'), len(gs.get('dealtSeatIds') or []), len(gs.get('players') or []))] += 1
            if len(canon_ids) < 10:
                x = dict(ident); x['why'] = why
                x['dealtSeatIds'] = gs.get('dealtSeatIds'); x['seats'] = [[pl.get('seat'), bool(pl.get('is_folded')), bool(pl.get('is_sitting_out')), bool(pl.get('is_all_in'))] for pl in gs.get('players') or []]
                x['heroSeat'] = (s.get('player') or {}).get('seat'); x['dealerSeat'] = gs.get('dealerSeat'); x['legalActions'] = gs.get('legalActions'); x['baseline'] = vp[0].get('before')
                canon_ids.append(x)
        if p.get('reason') == 'depth_or_ante_outside_pack' and p.get('depthBB') is not None and p['depthBB'] <= 250:
            x = dict(ident); x.update({'depthBB': p['depthBB'], 'ante': gs.get('ante'), 'bigBlind': gs.get('bigBlind'),
                                       'anteBB': (gs.get('ante') or 0) / gs['bigBlind'] if gs.get('bigBlind') else None})
            ante.append(x)
        changed = [t['node'] for t in tr if t.get('changed') and t.get('node') != 'variant_policy']
        if changed:
            later_changed[(r['producerId'], r['turnKey'])] = (ident, changed, {'baseline': [p.get('baselineAction'), p.get('baselineAmount')],
                'proposal': [p.get('proposalAction'), p.get('proposalAmount')], 'final': [p.get('finalAction'), p.get('finalAmount')],
                'applied': p.get('applied'), 'mode': p.get('mode'), 'reason': p.get('reason'), 'transitions': tr})
for k, (ident, changed, rec) in later_changed.items():
    e = execs.get(k)
    if e and e['accepted'] and e['accepted'].get('action') != rec['baseline'][0]:
        x = dict(ident); x.update({'changedBy': changed, 'execution': e}); x.update(rec); c7.append(x)
out = {'window': [ws_iso, we_iso], 'release': release, 'populationRecordsSeen': n,
       'canonicalStateUnavailableBySubCondition': dict(canon),
       'canonicalStateUnavailableDetail': {'|'.join(map(str, k)): v for k, v in canon_detail.most_common(40)},
       'canonicalStateUnavailableSample': canon_ids,
       'depthOrAnteRefusedInsideDepth': ante,
       'recordsWhereALaterNodeChangedTheAction': len(later_changed),
       'acceptedDiffersFromBaseline': c7}
json.dump(out, open(out_path + '.tmp', 'w'), indent=1, default=str)
os.rename(out_path + '.tmp', out_path)
