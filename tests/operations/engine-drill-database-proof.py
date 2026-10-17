#!/usr/bin/env python3
"""The crash drill's database witness refuses every gap and passes only a whole recovery."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'drill_proof', ROOT / 'server/scripts/engine-drill-database-proof.py'
)
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)

SHA = 'a' * 40
INSTANCE = '1-bbbbbbbb'
NOW = datetime(2026, 10, 17, 13, 3, 0, tzinfo=timezone.utc)
BREAK = datetime(2026, 10, 17, 12, 55, 0, tzinfo=timezone.utc)
THAWED = datetime(2026, 10, 17, 13, 0, 15, tzinfo=timezone.utc)


def iso(value: datetime) -> str:
    return value.isoformat().replace('+00:00', 'Z')


def rows(**overrides):
    data = {
        'engine_leader': [{'instance_id': INSTANCE, 'engine_version': SHA[:8], 'heartbeat_at': iso(NOW - timedelta(seconds=4))}],
        'engine_maintenance_break_log': [{'break_started_at': iso(BREAK), 'thaw_ok': True, 'engine_version': SHA[:8]}],
        'engine_maintenance_thaws': [{'freeze_started_at': iso(BREAK), 'thawed_at': iso(THAWED)}],
        'hand_history': [{'table_id': f't{i % 8}', 'created_at': iso(THAWED + timedelta(seconds=i))} for i in range(30)],
    }
    data.update(overrides)
    seen = []

    def fetch(table, query):
        seen.append((table, query))
        return data[table]

    return fetch, seen


def evaluate(fetch):
    return proof.evaluate(
        fetch, sha=SHA, instance_id=INSTANCE, break_started_at=BREAK,
        max_heartbeat_age_seconds=15, min_hands=20, min_tables=5, now=NOW,
    )


class DrillDatabaseProof(unittest.TestCase):
    def test_a_whole_recovery_passes_and_reads_only_after_the_thaw(self):
        fetch, seen = rows()
        verdict = evaluate(fetch)
        self.assertEqual(verdict['handsAfterThaw']['tables'], 8)
        hand_query = dict(seen)['hand_history']
        self.assertEqual(hand_query['created_at'], f'gt.{iso(THAWED)}')
        self.assertTrue(all(method_table in {'engine_leader', 'engine_maintenance_break_log', 'engine_maintenance_thaws', 'hand_history'} for method_table, _ in seen))

    def test_every_gap_refuses(self):
        stale = [{'instance_id': INSTANCE, 'engine_version': SHA[:8], 'heartbeat_at': iso(NOW - timedelta(seconds=40))}]
        cases = {
            'another leader': dict(engine_leader=[{'instance_id': '1-aaaaaaaa', 'engine_version': SHA[:8], 'heartbeat_at': iso(NOW)}]),
            'stale leader': dict(engine_leader=stale),
            'no leader': dict(engine_leader=[]),
            'break not recorded': dict(engine_maintenance_break_log=[]),
            'thaw failed': dict(engine_maintenance_break_log=[{'thaw_ok': False, 'engine_version': SHA[:8]}]),
            'thaw unknown': dict(engine_maintenance_break_log=[{'thaw_ok': None, 'engine_version': SHA[:8]}]),
            'recorded by another release': dict(engine_maintenance_break_log=[{'thaw_ok': True, 'engine_version': 'bbbbbbbb'}]),
            'two break rows': dict(engine_maintenance_break_log=[{'thaw_ok': True, 'engine_version': SHA[:8]}] * 2),
            'never thawed': dict(engine_maintenance_thaws=[{'freeze_started_at': iso(BREAK), 'thawed_at': None}]),
            'too few hands': dict(hand_history=[{'table_id': 't1'}] * 10),
            'too few tables': dict(hand_history=[{'table_id': f't{i % 2}'} for i in range(40)]),
            'unreadable hands': dict(hand_history={'message': 'error'}),
        }
        for name, override in cases.items():
            with self.subTest(name):
                fetch, _ = rows(**override)
                with self.assertRaises(ValueError):
                    evaluate(fetch)


if __name__ == '__main__':
    unittest.main()
