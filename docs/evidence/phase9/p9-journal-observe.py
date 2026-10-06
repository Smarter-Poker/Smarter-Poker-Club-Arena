"""Phase 9 S3 join, read-only, on the engine host: find the Horse private journal
accepted_hand record for each declared hand (committedHandId = hand_history.id) and
compare its run-it-N board rows with hand_history. The serving
identity is read by the operator immediately before and after (docker inspect). Reads segment files only (never
opens the journal for writing); run under nice 19 / ionice idle, detached.
argv: <targets.csv> <window-start-epoch> <window-end-epoch> <out.json>"""
import os, sys, gzip, json, time
targets_path, ws, we, out_path = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
targets = {}
for line in open(targets_path):
    p = line.rstrip('\n').split(',')
    if len(p) < 5: continue
    hid, variant, runs, rit, cc = p[0], p[1], int(p[2]), p[3], p[4]
    targets[hid] = {'variant': variant, 'runs': runs, 'rit': [b.replace(';', ',') for b in rit.split('|')] if rit else []}
t0 = time.time()
out = {'dirs': {}, 'targets': len(targets)}
found = {}
acc_by_release = {}
for d in ['/var/lib/club-arena/horse-decisions/archive/segments', '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']:
    info = {'segments': 0, 'oldestMtime': None, 'newestMtime': None, 'scanned': 0, 'records': 0, 'unreadable': 0}
    oldest, newest = 1e20, 0
    cand = []
    with os.scandir(d) as it:
        for e in it:
            if not e.name.endswith('.ndjson.gz'): continue
            try: m = e.stat().st_mtime
            except FileNotFoundError: continue
            info['segments'] += 1
            oldest = min(oldest, m); newest = max(newest, m)
            if ws - 120 <= m <= we + 1800: cand.append(e.path)
    info['oldestMtime'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(oldest)); info['newestMtime'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(newest))
    oldest_at = None
    for path in cand:
        try:
            with gzip.open(path, 'rt') as f:
                for line in f:
                    info['records'] += 1
                    try: r = json.loads(line)
                    except Exception: continue
                    if r.get('kind') != 'accepted_hand': continue
                    at = r.get('atMs', 0) / 1000
                    if not (ws <= at < we + 1800): continue
                    rel = r.get('sourceRelease')
                    acc_by_release[rel] = acc_by_release.get(rel, 0) + 1
                    try: b = json.loads(r['body'])
                    except Exception: continue
                    hid = b.get('committedHandId')
                    if hid not in targets: continue
                    boards = [a['action'].split(':', 1)[1] for a in (b.get('actions') or []) if isinstance(a, dict) and a.get('userId') == 'system' and str(a.get('action', '')).startswith('rit_board_')]
                    found.setdefault(hid, []).append({'release': rel, 'runs': 1 + len(boards), 'boards': boards})
            info['scanned'] += 1
        except Exception:
            info['unreadable'] += 1
    out['dirs'][d] = info
res = {'targets': len(targets), 'found': 0, 'notFound': 0, 'duplicateRecords': 0, 'releaseOther': 0, 'runsAgree': 0, 'runsDisagree': 0, 'boardsAgree': 0, 'boardsDisagree': 0, 'byRuns': {}}
for hid, t in targets.items():
    k = str(t['runs'])
    c = res['byRuns'].setdefault(k, {'hands': 0, 'journalFound': 0, 'runsAgree': 0, 'boardsAgree': 0})
    c['hands'] += 1
    recs = found.get(hid)
    if not recs:
        res['notFound'] += 1; continue
    res['found'] += 1; c['journalFound'] += 1
    if len(recs) > 1: res['duplicateRecords'] += 1
    r = recs[0]
    if r['release'] != 'f5322827e41832f2023ca3f9e52b77d1be7e735b': res['releaseOther'] += 1
    if r['runs'] == t['runs']: res['runsAgree'] += 1; c['runsAgree'] += 1
    else: res['runsDisagree'] += 1
    if r['boards'] == t['rit']: res['boardsAgree'] += 1; c['boardsAgree'] += 1
    else: res['boardsDisagree'] += 1
out['join'] = res
out['acceptedHandRecordsInWindowByRelease'] = acc_by_release
out['wallSeconds'] = round(time.time() - t0, 1)
json.dump(out, open(out_path + '.tmp', 'w'), indent=1)
os.rename(out_path + '.tmp', out_path)
