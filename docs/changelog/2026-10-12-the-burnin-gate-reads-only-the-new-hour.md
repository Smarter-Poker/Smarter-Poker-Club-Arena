# The Burn-In Gate Reads Only The New Hour

Date: 2026-10-12
Migration: `20261012113438_the_burnin_gate_reads_only_the_new_hour` (applied to production 11:34 UTC)
Law: `tests/the-burnin-gate-reads-only-the-new-hour.law.test.ts`

## What Was Wrong

The hourly Midway burn-in gate (`ca-burnin-gate-hourly`, `fn_ca_burnin_gate_tick` calling `fn_ca_midway_burnin_gate(24)`) has a 120 second statement timeout. On 2026-10-11 it failed 8 of 24 runs (incident 30e42f14). Migration `20261011200626` replaced its 24 hour settlement scan with two counts that were meant to be index-only: every row updated in the window, minus the final rows in the window.

Those counts were index-only in name only:

- `ca_settlements` prunes about 1.2 million final rows a day, and new rows land on the freed pages, so the pages of the last day are rarely all-visible (61 percent of the table is). An index-only scan of a page that is not all-visible reads the heap anyway.
- Every hand settlement passes through seven states in one transaction. The last change is never a HOT update (state is the predicate of the partial final index), so `idx_ca_settlements_updated_at` carries a dead entry for each step.

Measured on 2026-10-12: one hour of rows (41,571) cost 278,829 heap fetches and 3.9 seconds; four hours of final rows cost 31.8 seconds cold. The run took 2 seconds right after the change, then crept back to 47, 74, 60, 55 and 62 seconds between 06:58 and 10:58 UTC.

## The Fix

`final` is terminal (the settlement transition guard refuses any change out of it), and every other transition stamps `updated_at := now()`. So once a range of `updated_at` has been read with no transaction still open that could write a row dated inside it, the set of non-final rows in that range can only shrink.

- Each run stores that set as a proof (`from`, `before`, `open` ids, normally none) inside its `ca_gate_runs` row, beside the failed and stuck counts.
- The next run re-reads only the open ids by primary key and the rows dated since the previous proof: about one hour of rows instead of 24.
- The proof ends at a horizon: 10 minutes ago, or the start of the oldest open client transaction if that is earlier (a row carries its writer's transaction start time).
- `fn_ca_burnin_gate_tick` reads `pg_stat_activity` before the statement that takes the gate's snapshot. Postgres holds that reading for the rest of the transaction (measured: two reads 3 seconds apart in one transaction were identical), so no transaction can commit between the horizon and the snapshot.
- With no usable proof (the first run, a failed run, an ad hoc window wider than the proof), the run reads the whole window once, as before.

Failed and stuck keep their exact definitions. No index was built. Every other check and the output are unchanged, apart from the new `proof` key.

## Proof

Rolled-back trial on production before applying:

- Over a 2 hour window with no proof, the new gate read 0 failed and 0 stuck, matching the exact query.
- With a carried proof covering the window up to 70 minutes ago, plus one carried id that had since become final (it dropped out as it should), the whole tick ran in 2.17 seconds and produced a new proof with no open ids.

Every other statement in the gate was timed read-only: ledger chain verification about 1.25 seconds, money RPC drift about 1.0 second, suspense flow 0.5 seconds, and the rest are small.
