"""Read-only: which decision times the closed archive segments still hold. Samples every 100th segment
name and histograms decision records by UTC hour of decisionTimeMs (and FLH DECIDE_FAST separately)."""
import os, gzip, json, time
from collections import Counter
DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
h = Counter(); f = Counter(); n = 0; missing = 0
for d in DIRS:
    for i, e in enumerate(os.scandir(d)):
        if i % 100: continue
        try: raw = gzip.decompress(open(e.path, 'rb').read())
        except FileNotFoundError: missing += 1; continue
        n += 1
        for line in raw.decode('utf-8').splitlines():
            r = json.loads(line)
            if r.get('kind') != 'decision': continue
            body = json.loads(r['body']); s = body.get('snapshot') or {}; gs = s.get('gameState') or {}
            dt = s.get('decisionTimeMs')
            if not isinstance(dt, int): h['no_time'] += 1; continue
            k = time.strftime('%Y-%m-%dT%H', time.gmtime(dt / 1000))
            h[k] += 1
            if gs.get('gameVariant') == 'flh' and s.get('type') == 'DECIDE_FAST': f[k + '|' + str(r.get('sourceRelease'))[:8]] += 1
print(json.dumps({'segmentsSampled': n, 'retiredDuringScan': missing, 'decisionsByHour': dict(sorted(h.items())), 'flhFastByHourRelease': dict(sorted(f.items()))}, indent=1))
