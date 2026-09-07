# Union Reports Use Issued Statement Records

The old overview divided ledger holds by the current rate to invent historical rake, fell back to current weekly rake for past periods, truncated reads at 2,000 rows, ignored query errors, and treated transfer direction as paid or overdue. The store also passed a period UUID as a timestamp.

The report now reads the existing authorized statement board. Historical values come from invoice snapshots. Period IDs resolve through a union-scoped lookup. The overview labels the exact latest issued period and coverage; missing statements are unavailable, cancelled statements do not contribute to active totals, and agent/player totals remain unknown rather than zero. Payment status depends on recorded payment amounts and due dates. Errors clear stale figures and leave the statement and production-data navigation available.

Migration 20260907212347 adds snapshot_complete to board rows. The client refuses an incomplete issued accounting snapshot rather than accepting the board's legacy zero defaults. No invoice values or balances were changed.

Actual TypeScript mapper/service modules passed local execution with external Supabase mocked: snapshot amounts, both wire directions, final unpaid cent, due dates, missing/cancelled records, 2,501 rows, exact-cent aggregation, malformed inputs, union-scoped period lookup, date mismatch and error propagation. Permanent Vitest tests cover those behaviors. The installed SQL passed a self-aborting pg_temp probe including snapshot completeness and prior issuer/period regressions. Permission helpers were stubbed; production triggers and concurrent sessions were not exercised.

Full client typecheck/tests and browser rendering remain to be verified by the repository workflow and deployed application. This is an issued-statement view, not a certification of invoice calculation correctness, cash receipt, unbilled production, or whole-system conservation. Those remain separate audit requirements.
