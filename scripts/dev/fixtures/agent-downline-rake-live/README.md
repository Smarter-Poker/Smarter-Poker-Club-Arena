# Downline rake live-source qualification

`current.sql` is the complete production `pg_get_functiondef` read on
2026-10-30, MD5 `c950d72d7b9db73b8fdb1a706441291c`. It is data for the isolated
native runner, never a production installation script.

Run `scripts/dev/probe-agent-downline-rake-live-pg17.py --evidence-dir PATH`
with PostgreSQL 17 tools and a task-owned external `TMPDIR` on the owner Mac.
CI invokes the existing `probe-agent-downline-rake-scope-pg17.py` entrypoint in
accounting shard 3. After its complete legacy role matrix passes, that entrypoint
runs the current live-reader regression in process and propagates any failure.
Each runner retains its own command deadlines and cluster cleanup; no outer
subprocess deadline can interrupt the nested cleanup. Its evidence
is retained under the legacy evidence directory as `live-reader/`. Migration,
runner and fixture changes each select that required job through the existing
classifier.

The runner executes the actual whole reader before and after the exact
migration. It compares numerical results across head, tail, unrolled gaps,
completed rollups, search, limits and service context, and checks cent rounding,
date bounds, authorization refusal, function metadata and replay refusal. Its
120,000 unrelated same-club attribution rows demonstrate that all three live
branches exclude foreign players before materialization. The extracted CTE
probe changes only PL/pgSQL variable bindings into equivalent fixture literals.

The reduced schema reuses the existing September scope bootstrap. External
authorization remains a controlled boundary; launch helpers use their actual
captured definitions over synthetic boundary data. This does not qualify live
Auth transport or production financial writes.
Production latency and published UI recovery require separate live proof.

The covered-period successor is `20261030145010`. `covered.sql` is its expected
complete function postimage; `launch.sql` contains the captured real production
cutoff and acceptance helper definitions over a synthetic boundary table. The
original eleven checks remain, followed by exact successor definition/metadata/
replay/auth checks, NULL and nonNULL cutoff cases, and a635-person/314291-row
native cohort using the production club/date INCLUDE cover. Its whole-query
plan must select a bounded period Index Only Scan without forced planner settings.
The in-process entrypoint still executes all37 legacy scope checks first.
