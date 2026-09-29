# The escrow TTL sweep reads the real status domain

`public.fn_ca_escrow_ttl_sweep()` scanned `chip_escrow_holds WHERE status =
'active'` from the day it was installed (20260831160515). `active` is not in
`chip_escrow_holds_status_check` and never has been, so the loop body never ran
once across 2,054 cron firings, and 166 expired holds carrying 3,778,600 chips
sat unreported for forty days.

This fixture proves the repair against production's exact catalogue, on the
PG17 cluster in `agent-work/sep28-rehearsal` (its `rebuild.sh` builds the base;
these four files overlay onto it). Run in order:

| file             | what it does                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlay.sql`    | production's exact `chip_escrow_holds` and `ca_ledger_accounts` shape, the `cron.job` row that drives the sweep, the two Sept 28 discovery cursors, and the sweep's **installed preimage** (`status = 'active'`)                                    |
| `seed.sql`       | production's measured population: 166 held / 539 released, 165 of the held expired, one of those on an out-of-scope club and the oldest of all, plus unexpired / captured / expired decoys                                                          |
| `red.sql`        | RED: the installed sweep returns 0 and files 0 incidents over 165 expired holds                                                                                                                                                                     |
| `regression.sql` | GREEN, after the candidate migration: the bound, the oldest-first batch, the reported backlog, the refused decoys, the refused out-of-scope hold, the idempotent replay, and that nothing was released, credited or journalled. Ends in `ROLLBACK`. |

```
cd <this repo>
B=$(cat ../agent-work/sep28-rehearsal/BASEDIR); S=$(sed -n 1p $B/CONN); P=$(sed -n 2p $B/CONN)
PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
for f in overlay seed red; do $PSQL -X -q -v ON_ERROR_STOP=1 -U postgres -h $S -p $P -d postgres \
  -f tests/fixtures/escrow-ttl-status-domain/$f.sql; done
$PSQL -X -q -v ON_ERROR_STOP=1 -U postgres -h $S -p $P -d postgres \
  -f supabase/migrations/20260925130241_the_escrow_ttl_sweep_reads_the_real_status_domain.sql
$PSQL -X -q -v ON_ERROR_STOP=1 -U postgres -h $S -p $P -d postgres \
  -f tests/fixtures/escrow-ttl-status-domain/regression.sql
```

Measured 2026-09-25: RED `returned 0 and filed 0 incidents`; the candidate's own
verify block `sees 165 expired hold(s)`; GREEN `2 sweeps x bound 25 ... -> 24
incidents, oldest-first, backlog reported, replay folded (min occurrences 2),
zero holds moved, zero chips credited, zero journal rows`.

THE SWEEP DOES NOT RELEASE ANYTHING, AND MUST NOT START. It calls exactly one
thing, `fn_ca_raise_drift_incident`, and returns a count. CLAUDE.md 10.12
forbids a scheduled job settling what a live path owes, and no debit backs
these holds: no `wallet_transactions` or `chip_ledger` row anywhere on
production references any of the 705 `chip_escrow_holds` ids. Crediting them
would be the double-payment, not the repair.
