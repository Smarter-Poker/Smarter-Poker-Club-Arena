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
authorization and launch authorities are controlled boundaries, explicitly not
qualification of current Auth transport or those helper implementations.
Production latency and published UI recovery require separate live proof.
