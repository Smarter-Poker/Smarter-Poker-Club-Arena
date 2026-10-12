#!/usr/bin/env python3
"""Realised kurtosis of the P10.2 strength run, from the committed shard results.

strength.json carries no power sums. Every committed shard result under
strength-2026-10-03/runs/ carries the exact integer sums n, S1..S4 per
(dealer-relative offset, divergence street). This script

  1. checks every result file against its committedSha256 in strength.json and
     that the files are exactly the 111 counted shards;
  2. rebuilds each verdict cell's per-profile groups exactly as
     summarizePlo4Strength does (Plo4StrengthContract.ts), and cross-checks the
     mean, standard error and estimator skewness against strength.json;
  3. reports, per group, the realised kurtosis K = m4 / m2^2 (not excess; the
     quantity in the contract's sqrt((K - 1) / n)) and the variance estimate's
     relative standard error sqrt((K - 1) / n) at the actual n and at the
     10,000-pair floor;
  4. reports, per cell, the contract's first Edgeworth term (skewness) and the
     second-order terms it omits: the estimator's excess kurtosis term
     |k4| (z^3 - 3z) phi(z) / 24 and the skewness-squared term
     g^2 |z^5 - 10z^3 + 15z| phi(z) / 72.

Read only. Run from the repository root:
  python3 docs/evidence/phase10/phase10-2-kurtosis.py
"""
import hashlib, json, math, os, sys
from fractions import Fraction

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'strength-2026-10-03')
Z = 2.5758293035489004
PHI = math.exp(-Z * Z / 2) / math.sqrt(2 * math.pi)

strength = json.load(open(os.path.join(ROOT, 'strength.json')))
files = strength['files']
counted = {s['shard'] for s in strength['shards']}

results, problems = [], []
for rel, h in sorted(files.items()):
    parts = rel.split('/')
    if len(parts) != 3 or parts[2] in ('manifest.json',) or not parts[2].endswith('.json'):
        continue
    if parts[2] in ('runner.json', 'attempt.json'):
        continue
    path = os.path.join(ROOT, 'runs', rel)
    data = open(path, 'rb').read()
    if hashlib.sha256(data).hexdigest() != h['committedSha256']:
        problems.append('hash_mismatch:' + rel)
    results.append(json.loads(data))
keys = {f"{r['profileId']}-{r['seed']}-s{r['shard']}" for r in results}
if keys != counted or len(results) != 111:
    problems.append(f'shard_set_mismatch: {len(results)} results, {len(keys ^ counted)} differ')
if problems:
    sys.exit('refused: ' + ', '.join(problems))

contract = strength['contract']
profiles = contract['matrix']['profiles']
seeds = contract['matrix']['seeds']

def position_for_offset(offset, seats):  # Plo4PolicyPack.positionForOffset
    if offset == 0: return 'button'
    if seats == 2 or offset == 2: return 'big_blind'
    if offset == 1: return 'small_blind'
    if offset == seats - 1: return 'cutoff'
    return 'early' if offset == 3 else 'middle'

sums = {}  # (profile, seed, offset, street) -> [n, s1, s2, s3, s4]
for r in results:
    for k, v in r['strata'].items():
        offset, street = k.split('|')
        key = (r['profileId'], r['seed'], int(offset), street)
        acc = sums.setdefault(key, [0, 0, 0, 0, 0])
        acc[0] += v['n']
        for i, f in enumerate(('s1', 's2', 's3', 's4'), 1):
            acc[i] += int(v[f])

def group(pid, in_sample, selected):
    g = [0, 0, 0, 0, 0]
    for (p, seed, offset, street), acc in sums.items():
        if p != pid or not in_sample(seed, offset, street): continue
        g[0] += acc[0]
        if not selected(seed, offset, street): continue
        for i in range(1, 5): g[i] += acc[i]
    return g

def moments(g):
    n, s1, s2, s3, s4 = g
    m2n2 = n * s2 - s1 * s1                                   # n^2 m2
    m3n3 = n * n * s3 - 3 * n * s1 * s2 + 2 * s1 ** 3          # n^3 m3
    m4n4 = n ** 3 * s4 - 4 * n * n * s1 * s3 + 6 * n * s1 * s1 * s2 - 3 * s1 ** 4
    K = float(Fraction(m4n4, m2n2 * m2n2)) if m2n2 else float('nan')
    return n, s1, m2n2, m3n3, m4n4, K

def cell(name, members, in_sample, selected=None):
    selected = selected or in_sample
    w = 1 / len(members)
    mean = var = third = fourth_ex = 0.0
    rows = []
    for p in members:
        g = group(p['id'], lambda s, o, st: in_sample(p, s, o, st), lambda s, o, st: selected(p, s, o, st))
        n, s1, m2n2, m3n3, m4n4, K = moments(g)
        s2u = m2n2 / (n * (n - 1))              # unbiased, as plo4CellStatistic
        mu2 = m2n2 / n ** 2
        mu3 = m3n3 / n ** 3
        mu4 = m4n4 / n ** 4
        mean += w * s1 / n
        var += w * w * s2u / n
        third += w ** 3 * mu3 / n ** 2
        fourth_ex += w ** 4 * (mu4 - 3 * mu2 * mu2) / n ** 3
        rows.append((p['id'], n, K, math.sqrt((K - 1) / n), math.sqrt((K - 1) / 10000)))
    skew = third / var ** 1.5
    kurt_ex = fourth_ex / var ** 2
    return {
        'cell': name,
        'meanBbPer100': mean / 200 * 100,  # cents per hand -> bb/100 (BB = 200 cents)
        'seBbPer100': math.sqrt(var) / 200 * 100,
        'skew': skew,
        'edgeworth1': abs(skew) * (2 * Z * Z + 1) * PHI / 6,
        'kurtTerm': abs(kurt_ex) * (Z ** 3 - 3 * Z) * PHI / 24,
        'skew2Term': skew * skew * abs(Z ** 5 - 10 * Z ** 3 + 15 * Z) * PHI / 72,
        'groups': rows,
    }

every = lambda p, s, o, st: True
cells = [cell('primary', profiles, every)]
cells += [cell(f'seed:{sd}', profiles, lambda p, s, o, st, sd=sd: s == sd) for sd in seeds]
cells += [cell(f"profile:{p['id']}", [p], every) for p in profiles]
for pos in ['button', 'small_blind', 'big_blind', 'cutoff', 'middle', 'early']:
    members = [p for p in profiles if pos in {position_for_offset(o, p['seats']) for o in range(p['seats'])}]
    cells.append(cell(f'position:{pos}', members,
                      lambda p, s, o, st, pos=pos: position_for_offset(o, p['seats']) == pos))
for band in ['short', 'standard', 'deep']:
    cells.append(cell(f'depth:{band}', [p for p in profiles if p['depthBand'] == band], every))
for street in ['preflop', 'flop', 'turn', 'river']:
    cells.append(cell(f'street:{street}', profiles, every, lambda p, s, o, st, street=street: st == street))

# Cross-check against the committed verdict.
v = strength['verdict']['cash']
committed = [v['primary'], *v['seeds']]
for fam in ('profiles', 'positions', 'depthBands', 'streetFamilies'):
    committed += v.get(fam, [])
committed = {c['cell']: c for c in committed}
worst = 0.0
for c in cells:
    ref = committed.get(c['cell'])
    if ref is None:
        sys.exit('refused: no committed cell ' + c['cell'])
    for mine, theirs in ((c['meanBbPer100'], ref['meanBbPer100']), (c['seBbPer100'], ref['standardErrorBbPer100']),
                         (c['skew'], ref['estimatorSkewness'])):
        worst = max(worst, abs(mine - theirs) / max(abs(theirs), 1e-12))

print(f'inputs: {len(results)} committed shard results, hashes equal strength.json; cross-check worst relative difference {worst:.1e}')
print('\nPer profile, all pairs (the primary cell groups):')
for pid, n, K, rse, rse10k in cells[0]['groups']:
    print(f'  {pid:24s} n={n:>9,d}  K={K:8.2f}  relSE(var) at n {rse:6.2%}  at 10,000 {rse10k:6.2%}')
print('\nPer cell: max K over its groups, max relSE at actual n, Edgeworth terms (limit 0.001 on the first):')
for c in cells:
    kmax = max(g[2] for g in c['groups'])
    rmax = max(g[3] for g in c['groups'])
    nmin = min(g[1] for g in c['groups'])
    print(f"  {c['cell']:28s} minN={nmin:>9,d}  maxK={kmax:10.2f}  maxRelSE={rmax:6.2%}  "
          f"skewTerm={c['edgeworth1']:.2e}  kurtTerm={c['kurtTerm']:.2e}  skew2Term={c['skew2Term']:.2e}")
