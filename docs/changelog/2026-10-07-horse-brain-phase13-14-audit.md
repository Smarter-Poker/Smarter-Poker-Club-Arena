# Horse Brain: audit of Phases 13 and 14 (2026-10-07)

A read-only audit of everything Phases 13 and 14 built: source on main,
producers and consumers by import and call site, every selection, the named
test suites on a fresh worktree, every Phase 14 migration read back from
production (function bodies by md5, ACLs, `search_path`, row level security,
triggers, ledger rows), publication in the serving engine release `6b1af5c5`,
and each natural-evidence claim re-checked today with bounded read-only
queries and engine-host reads.

Results are appended to both closure records as `## Audit Of October 7, 2026`.

- One wiring defect, fixed in #6439: the worker's authority admission counters
  (Phases 8 to 13) were taken before telemetry was armed and never reached
  `horse_brain_telemetry`.
- Stale delivery statements in the P13.1, P13.2, P13.3, loss-diagnosis and
  P14.4 records now carry dated delivery notes naming their merges.
- The Phase 14 limit "the daily audit cannot keep pace" is recorded as fixed
  by #6432 and measured.
- No drift, stub, regression or unpublished change was found otherwise; every
  selection stays `null` and every live decision stays shadow.
