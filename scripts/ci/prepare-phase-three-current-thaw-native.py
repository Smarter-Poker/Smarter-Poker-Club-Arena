#!/usr/bin/env python3
"""Compose exact current CA09 authority/fixture SQL; never connect to a database."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--frozen-seconds', type=int, choices=[300, 1200], default=300)
    args = parser.parse_args()
    root = args.root.resolve()
    paths = [
        root/'scripts/ci/probes/phase-three-current-clock-thaw-native.sql',
        root/'scripts/ci/fixtures/phase-three-current-thaw-authority.sql',
        root/'scripts/ci/fixtures/phase-three-current-thaw-authority.json',
        root/'supabase/tests/reconnect_allowance_maintenance.sql',
        Path(__file__).resolve(),
    ]
    probe, authority, manifest_text, reconnect = [p.read_text() for p in paths[:4]]
    manifest = json.loads(manifest_text)
    assert hashlib.sha256(authority.encode()).hexdigest() == manifest['composed_sql_sha256']
    pattern = re.compile(r'CREATE(?: OR REPLACE)? FUNCTION\s+((?:public\.)?fn_[a-zA-Z0-9_]+)\s*\((.*?)\)\s*RETURNS\b(.*?)\bAS\s*(\$[a-zA-Z0-9_]*\$)(.*?)\4\s*;', re.S|re.I)
    actual = {hashlib.md5(m.group(5).encode()).hexdigest() for m in pattern.finditer(authority)}
    expected = {f['body_md5'] for f in manifest['source_functions']}
    assert actual == expected and len(actual)==9
    assert probe.count('-- CA09_CURRENT_AUTHORITY_SETUP') == 1
    probe = probe.replace('-- CA09_CURRENT_AUTHORITY_SETUP', authority)
    probe = probe.replace('__CA09_FROZEN_SECONDS__', str(args.frozen_seconds))
    probe, count = re.subn(r'-- CA09_COMPOSITION_GUARD_BEGIN\n.*?-- CA09_COMPOSITION_GUARD_END\n', '', probe, flags=re.S)
    assert count == 1
    assert probe.count('-- CA09_RECONNECT_ASSERTIONS') == 1
    probe = probe.replace('-- CA09_RECONNECT_ASSERTIONS', reconnect)
    assert probe.rstrip().endswith('ROLLBACK;')
    assert 'CA09_CURRENT_AUTHORITY_SETUP' not in probe
    assert "r:=public.fn_thaw_platform(p.freeze_start-interval '120 seconds'" in probe
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(probe)
    metadata = {
        'status':'current_source_composed_unexecuted',
        'authority_source_commit':manifest['source_commit'],
        'source_bodies':manifest['source_functions'],
        'source_sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
        'sql_sha256':hashlib.sha256(probe.encode()).hexdigest(),
        'fixture_frozen_seconds':args.frozen_seconds,
        'native_executed':False,
        'current_native_equivalence_verified':False,
        'deployed_runtime_five_argument_adoption_verified':False,
        'full_fourteen_nonempty_deadline_families_verified':False,
        'cross_transaction_installments_verified':False,
        'outer_business_catalog_rollback_verified':False,
        'output':str(args.output.resolve()),
    }
    args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2)+chr(10))
    print(json.dumps({k:metadata[k] for k in ['status','sql_sha256','fixture_frozen_seconds','native_executed','output']}))


if __name__=='__main__':
    main()
