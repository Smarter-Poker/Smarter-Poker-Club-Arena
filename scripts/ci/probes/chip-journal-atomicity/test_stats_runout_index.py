"""Actual migration, candidate equivalence, and covering plan on isolated PostgreSQL."""
from pathlib import Path

def verify_stats_runout_index(run):
 root=Path(__file__).resolve().parents[4]
 migration=(root/'supabase/migrations/20260908212406_stats_runout_covering_index.sql').read_text().replace('public.','stats_index_probe.')
 probe=(root/'scripts/ci/probes/stats-runout-index/probe.sql').read_text()
 run(probe.replace('-- APPLY_MIGRATION',migration))
 print('Stats runout index: actual migration, candidate equivalence and index-only plan passed',flush=True)
