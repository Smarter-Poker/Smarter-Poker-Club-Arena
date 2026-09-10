#!/usr/bin/env python3
"""Pin the completed native checkpoint without implying production activation."""
from pathlib import Path
import hashlib
import json

p = Path(__file__).resolve().parent
s = p.parent
o = s / 'owner-composition'
proof_names = ['local-proof.json', 'overlap-proof.json',
               'legacy-union_to_club-proof.json', 'legacy-club_to_union-proof.json']
proofs = {n: json.loads((p / n).read_text()) for n in proof_names}
counts = {n: len(v['checks']) for n, v in proofs.items()}
assert list(counts.values()) == [49, 9, 2, 2], counts
assert sum(counts.values()) == 62
inputs = set(p.glob('*.sql')) | set(p.glob('*.py')) | {p / 'run-local.sh'}
inputs |= set(s.glob('*.sql')) | set(o.glob('*catalog*.json'))
inputs |= {o / 'build-fixture.py', o / 'exercise.sql'}
inputs |= {s.parent / (n + '.sql') for n in ['01-schema', '02-online-index', '03-cutover']}
def sha(f):
    raw = (json.dumps(json.loads(f.read_text()), sort_keys=True, separators=(',', ':')).encode()
           if f.suffix == '.json' else f.read_bytes())
    return hashlib.sha256(raw).hexdigest()
manifest = {
    'status': 'native_bank_checkpoint_verified_unapplied',
    'checks_passed': sum(counts.values()), 'check_counts': counts,
    'fixture': json.loads((o / 'catalog-summary.json').read_text()),
    'actual_bank_owner_md5': '56fe5715421d7e35bc386a669bb483a2',
    'hash_encoding': 'JSON uses sorted compact semantic JSON UTF-8; other inputs use raw bytes.',
    'input_sha256': {str(f.relative_to(s.parent)): sha(f) for f in sorted(inputs)},
    'proof_sha256': {n: sha(p / n) for n in proof_names},
    'remaining_release_gates': [
        'Reviewed source-compatible Round1 release and legacy exclusion',
        'Numeric released-cash capacity and downstream consumption composition',
        'Actual full Union to club to hierarchy to player cascade proof',
        'Final coactivation ordering, current catalog witnesses and bounded rollout'
    ],
    'scope': 'Actual cash accepted owner, bank, durable dispatcher and cash batch; no production activation or historical admission.'
}
(p / 'proof-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'checks_passed': manifest['checks_passed'], 'status': manifest['status']}))
