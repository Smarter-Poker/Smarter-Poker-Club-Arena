# tests/a-parked-v31-pipeline-is-one-finding.law.test.ts

When both V31 solver hosts report 'completed' and have gone silent and the
compactor stopped with them, fn_audit_solver_pipeline_liveness reports one warn,
solver_pipeline_parked, instead of two stale-worker criticals and a compactor
critical every day (2026-10-07 pilot, hosts switched off; Dan 2026-10-16: fix the
alarm, no solve). The law pins the parked condition, its position after the
never-commissioned note and before the host loop, and that every other state's
critical survives. certified_v31_missing stays critical in its own function.
