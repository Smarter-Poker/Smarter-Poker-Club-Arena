# tests/a-scheduled-break-does-not-page-as-a-frozen-table.law.test.ts

PokerTablesFrozen (infra/monitoring/engine-freeze-rules.yml) must carry the CLAUDE.md section 13 rule 6 `unless max_over_time(poker_maintenance_break_active[6m]) == 1` guard, so the announced hourly break never re-pages as a table-freeze incident.
