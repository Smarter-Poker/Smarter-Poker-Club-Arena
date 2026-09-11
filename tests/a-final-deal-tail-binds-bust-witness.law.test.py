#!/usr/bin/env python3
"""Native law: D12 deal tails bind accepted bust evidence without rewriting paid v2.

Run with --socket, --port and --output against an exclusively owned PG17
full_stage1 copy. The runner refuses the retained shared fixture and rolls back
all scenarios. See the changelog for fixture prerequisites and exact evidence.
"""
import importlib.util
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'scripts/ci/rehearse-final-deal-bust-witness.py'
spec = importlib.util.spec_from_file_location('deal_bust_witness_law', path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

if __name__ == '__main__':
    runner.main()
