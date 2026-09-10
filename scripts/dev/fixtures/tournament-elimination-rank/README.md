# Tournament elimination rank persistence

This fixture reuses the registration and tournament purchase PG17 setup, including its actual roster, seat and sequence triggers. Its four captured functions are verified against the source manifest before execution. Users, tournament, seats and accepted-hand/settlement records are explicitly synthetic; the actual hand-commit producer is not invoked.

The public atomic elimination wrapper, its legacy core, the exact knockout resolver and sequence writer execute. Cases cover distinct supplied ranks from one hand, exact replay, overlapping retries, rank replay conflicts, missing/contradictory evidence and seat-release rollback. No spendable money moves during elimination.

The baseline passed five groups and reproduced a NULL position being accepted as an elimination. The forward migration changes only that missing-rank guard. Only the changed boundary was rerun after the correction; it passed without repeating the five unaffected groups.

After root integrates the shared runner's `--eliminations-only` selector, run the changed boundary with:

```bash
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --eliminations-only --elimination-null-rank-only
```

The selector calls `tournament_elimination_rank_cases.verify(q, fresh, overlap, register, check)`. The focused case verifies idempotent candidate migration application and its exact body hash. Add `--elimination-baseline` to skip the migration and reproduce the expected original NULL-rank assertion failure. Omitting the focused flag also runs the other five case groups; they are retained for later relevant changes, not rerun for this one-condition correction.

The manager supplies finishing positions; this fixture does not execute manager ordering or select a same-hand equal-stack/cross-table tie policy. Shared-hand epochs, reversed cross-table delivery, real hand settlement and final-table transitions remain open. The runner accepts no production database connection.

See `docs/audits/2026-09-10-phase3-elimination-rank-evidence.json`.
