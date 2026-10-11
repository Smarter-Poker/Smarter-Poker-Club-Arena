"""Read-only: count PLO5, PLO6 and PLO8 DECIDE_FAST decisions on one release in [from, to) by receipt mode,
authority state, applied and changed. Closed archive segments only, sha256-name verified."""
import os, sys, gzip, json, hashlib, calendar, time
from collections import Counter
DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
frm, to, release = sys.argv[1:4]
def ms(iso): return calendar.timegm(time.strptime(iso.replace('Z',''), '%Y-%m-%dT%H:%M:%S')) * 1000
FROM, TO = ms(frm), ms(to)
c = Counter()
for d in DIRS:
    for e in os.scandir(d):
        if not e.name.endswith('.ndjson.gz'): continue
        try:
            if e.stat().st_mtime * 1000 < FROM - 120000: continue
            raw = gzip.decompress(open(e.path, 'rb').read())
        except FileNotFoundError:
            continue
        if hashlib.sha256(raw).hexdigest() != e.name[:-len('.ndjson.gz')]:
            c['segment_digest_mismatch'] += 1; continue
        for line in raw.decode('utf-8').splitlines():
            r = json.loads(line)
            if r.get('kind') != 'decision': continue
            body = json.loads(r['body']); s = body.get('snapshot') or {}; gs = s.get('gameState') or {}
            dt = s.get('decisionTimeMs')
            if not isinstance(dt, int) or not (FROM <= dt < TO): continue
            if gs.get('gameVariant') not in ('flh',) or s.get('type') != 'DECIDE_FAST': continue
            if r.get('sourceRelease') != release: c['other_release'] += 1; continue
            p = (body.get('decision') or {}).get('remainingVariantPolicy')
            if not p: c[f"{gs.get('gameVariant')}|{gs.get('gameMode')}|no_receipt"] += 1; continue
            a = (p.get('authority') or {}).get('state')
            c[f"{gs.get('gameVariant')}|{gs.get('gameMode')}|mode={p.get('mode')}|authority={a}|applied={p.get('applied')}|changed={p.get('changed')}"] += 1
print(json.dumps(dict(sorted(c.items())), indent=1))
