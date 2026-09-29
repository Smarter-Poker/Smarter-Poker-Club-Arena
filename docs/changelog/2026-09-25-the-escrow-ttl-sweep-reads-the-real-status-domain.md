# The escrow TTL sweep reads the real status domain (2026-09-25)

`public.fn_ca_escrow_ttl_sweep()` scanned `chip_escrow_holds WHERE status =
'active'`. That value is not in `chip_escrow_holds_status_check` and never has
been: the domain is `('held','released','captured','expired')`, the column
defaults to `'held'`, and every other reader of the table agrees
(`fn_release_tournament_holds`, `fn_remove_settled_club_member`,
`fn_retire_settled_club` all read `'held'`). The loop body had therefore never
executed once. Cron job `ca-escrow-ttl-sweep-10m` has fired 2,054 times since
2026-09-11 06:40 UTC, every one recorded `succeeded`, every one over zero rows.

## What it was not seeing (production, 2026-09-25 12:52-13:02 UTC)

| measurement                                      | value                                      |
| ------------------------------------------------ | ------------------------------------------ |
| `chip_escrow_holds` rows, status `held`          | 166                                        |
| of those, `expires_at` more than 10 minutes past | 166                                        |
| chips they carry                                 | 3,778,600                                  |
| `expires_at` range                               | 2026-08-16 20:55:53 .. 2026-08-17 00:26:30 |
| distinct owners (`auth.users`)                   | 51                                         |
| distinct things they secured (`public.tables`)   | 37                                         |
| status of all 37 of those tables                 | `closed`                                   |
| rows the old predicate matched, at any time      | 0                                          |

Club JAQK holds 128 of them (3,456,000 chips) and SHARK CLUB 38 (322,600); both
are inside the Midway union, so every finding clears `fn_ca_is_midway_scope`.

`ca_ledger_accounts` carried the same phantom: the `escrow` liability's backing
read `chip_escrow_holds.amount (active)`.

## Why the 166 are not released

No `wallet_transactions` row and no `chip_ledger` row anywhere on this database
references any `chip_escrow_holds` id - not one of the 705, held or released.
`public.chip_escrow` is empty. `chip_ledger` has zero rows in the window in
which all 705 were written. The 539 siblings that are released carry
`released_reason 'table_unlock'` with `released_at` seconds after their own
`created_at`, and they moved no chips either. No function sums
`chip_escrow_holds` into a balance, a supply snapshot or a conservation
identity. So nobody is short by these rows, and there is no debit to reverse:
crediting them would be the double-payment, not the repair.

What the stranded rows do block is real and is an owner decision, not a defect
to clear quietly: `fn_remove_settled_club_member` refuses each of those 51
members with "Release This Member's Escrow First", and `fn_retire_settled_club`
refuses both clubs. The correct terminal status for a hold whose table closed
without unlocking it is `'expired'`, and writing it is a state transition with
no author on record. The repaired detector is what puts that decision on the
incident board with the exact rows attached.

## The repair

`20260925130241_the_escrow_ttl_sweep_reads_the_real_status_domain`:

- the sweep reads `status = 'held'`, in both its backlog count and its loop;
- the migration asserts the enforced domain and the column default **before** it
  writes the literal, so a later tidy-up cannot install a second wrong value;
- the per-run bound of 25 is unchanged and asserted, now `ORDER BY expires_at,
id` so the bounded batch is the oldest 25 and the same 25 on replay (the old
  `LIMIT` had no order at all);
- every finding carries `expired_holds_total` and `expired_amount_total`, so the
  holds the bound leaves behind are visible from any one incident rather than
  filed as 166 rows. `fn_ca_raise_drift_incident` folds a repeated dedupe key
  onto the open incident and caps this source at 25 open rows;
- `fn_ca_escrow_ttl_sweep` is registered in `ca_detector_registry` under
  "chip standard", so its first real finding does not auto-register it as
  `unassigned`;
- the `escrow` liability's backing becomes `chip_escrow_holds.amount (held)`;
- it remains an OBSERVER. It calls `fn_ca_raise_drift_incident` and returns a
  count. The migration refuses on apply if the body acquires an `UPDATE` of
  wallets or holds, an `INSERT` into a money journal, a `DELETE` of a hold, or a
  `cron.schedule` of its own (CLAUDE.md 10.12). No cron, watcher, reconciler or
  repair loop was added; `cron.job` is proved unchanged inside the transaction.

## Evidence

RED and GREEN on the PG17 cluster carrying production's exact catalogue, seeded
to production's measured 166/539 population -
`tests/fixtures/escrow-ttl-status-domain/` (overlay, seed, red, regression):

- RED: `165 expired held holds on the table, installed sweep returned 0 and
filed 0 incidents`
- candidate's own verify block: `reads status=held and now sees 165 expired
hold(s) carrying 13530777.0000 chips (bound 25/run, oldest first); 166 held /
539 released rows untouched`
- GREEN: `2 sweeps x bound 25 ... -> 24 incidents, oldest-first, backlog
reported, replay folded (min occurrences 2), zero holds moved, zero chips
credited, zero journal rows, cursors 2026-09-21T07:00Z`

The 24-of-25 is the scope gate proving itself: the oldest hold in the batch
belongs to an out-of-scope club, is scanned, and files nothing.

## The Sept 28 weekly book is not on this path

`chip_escrow_holds` has six function readers on the whole database and none is
on the settlement path; `ca_ledger_accounts` has no function or view reader at
all. Both discovery cursors are asserted at `2026-09-21T07:00:00Z` inside the
migration's transaction, and `cron.job` is asserted unchanged.

Source contract: `tests/the-escrow-ttl-sweep-reads-the-real-status-domain.law.test.ts`,
`docs/laws.d/the-escrow-ttl-sweep-reads-the-real-status-domain.md`.
