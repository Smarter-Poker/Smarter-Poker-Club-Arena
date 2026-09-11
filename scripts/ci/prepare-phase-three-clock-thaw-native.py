#!/usr/bin/env python3
"""Compose CA09 SQL only. No database, network, credential, or process calls.

Current source/pins and fixture availability have NOT been verified. This file
does not execute the generated probe and cannot declare native acceptance.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    here = Path(__file__).resolve().parent
    probe_path = here / 'probes/phase-three-clock-thaw-native.sql'
    if not probe_path.exists():
        probe_path = here / 'phase-three-clock-thaw-native.sql'
    reconnect_path = root / 'supabase/tests/reconnect_allowance_maintenance.sql'
    audit_path = root / 'docs/audits/2026-09-10-phase3-clock-deadline-evidence.json'
    reconnect_source_path = root / 'supabase/migrations/20260908032311_reconnect_allowance_survives_maintenance.sql'
    audit = json.loads(audit_path.read_text())
    old = audit['thaw_catalog_review']
    assert old['production_read_only'] is True
    sql = probe_path.read_text()
    for pin in old['functions']:
        assert pin['body_md5'] in sql, ('historical pin changed', pin['signature'])
    reconnect = reconnect_path.read_text()
    assert 'fn_thaw_reconnect_states' in reconnect
    assert reconnect.count('DO $test$') == 1 and reconnect.rstrip().endswith('$test$;')
    assert not any(word in reconnect.upper() for word in ['CREATE FUNCTION', 'ALTER FUNCTION', 'DROP FUNCTION'])
    reconnect_source = reconnect_source_path.read_text()
    match = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_thaw_reconnect_states\(.*?AS \$\$(.*?)\$\$;', reconnect_source, re.S)
    assert match is not None
    reconnect_md5 = hashlib.md5(match.group(1).encode()).hexdigest()
    assert sql.count('__CA09_RECONNECT_SOURCE_MD5__') == 1
    sql = sql.replace('__CA09_RECONNECT_SOURCE_MD5__', reconnect_md5)
    sql, count = re.subn(r'-- CA09_COMPOSITION_GUARD_BEGIN\n.*?-- CA09_COMPOSITION_GUARD_END\n', '', sql, flags=re.S)
    assert count == 1
    assert sql.count('-- CA09_RECONNECT_ASSERTIONS') == 1
    sql = sql.replace('-- CA09_RECONNECT_ASSERTIONS', reconnect)
    assert sql.rstrip().endswith('ROLLBACK;')
    assert 'CREATE OR REPLACE FUNCTION public.' not in sql
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(sql)
    inputs = [probe_path, reconnect_path, reconnect_source_path, audit_path, Path(__file__).resolve()]
    result = {
        'status': 'prepared_unexecuted',
        'native_database_used': False,
        'production_database_used': False,
        'fresh_live_metadata_verified': False,
        'fresh_native_metadata_verified': False,
        'current_full_authority_source_available': False,
        'historical_pin_observed_at': old['observed_at'],
        'historical_function_pins': old['functions'],
        'reconnect_helper_tracked_source_md5': reconnect_md5,
        'sql_sha256': hashlib.sha256(sql.encode()).hexdigest(),
        'source_sha256': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},
        'output': str(args.output.resolve()),
        'execution_ready': False,
        'remaining': [
            'Authorized native pin/schema inspection and fixture rehearsal; unknown exact wrapper admission may refuse.',
            'Coordinator must independently compare full business and catalog snapshots before and after outer rollback.',
            'Candidate covers 42 active level clocks, on-break/non-running/null exclusions, add-on/rebuy/bomb/sit-out, and pure reconnect semantics.',
            'No nonempty fixture yet for waitlist/cashier/bounty/stay/rejoin/cluster/persisted reconnect deadline families.',
            'No proof of separately committed installments, crash between installments, or concurrent owner/replay calls.',
            'Ownership-aware five-argument current wrapper is pin-checked but this candidate invokes the three-argument audited caller.',
            'No financial hand commit, engine deployment, private log verification, browser proof, or phase completion.',
        ],
    }
    args.output.with_suffix('.metadata.json').write_text(json.dumps(result, indent=2) + chr(10))
    print(json.dumps({k: result[k] for k in ['status', 'execution_ready', 'native_database_used', 'sql_sha256', 'output']}))


if __name__ == '__main__':
    main()
