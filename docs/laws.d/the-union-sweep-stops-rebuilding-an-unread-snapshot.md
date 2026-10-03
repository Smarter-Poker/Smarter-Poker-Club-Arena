# tests/the-union-sweep-stops-rebuilding-an-unread-snapshot.law.test.ts

The hourly union integrity sweep runs its money controls and does not rebuild
`union_rake_basis_snapshot`. That rebuild recomputed the whole open week each
hour; from 2026-09-29 it no longer finished inside the job's 300 s, so every
run lasted exactly 300 s, was cancelled in the rebuild and kept the 2026-09-28
snapshot, spending about 250 s of a backend an hour on a table nothing reads.
The law pins that the sweep in force calls the integrity sweep, invoice ageing,
stop-loss, lock expiry and hygiene, and period closes, and never
`fn_union_rake_basis_refresh`; that no application source under `src`,
`server/src` or `supabase/functions` reads the snapshot table; and that the
migration is one md5-pinned transaction that adds no schedule. The older law
`the-union-sweep-commits-its-money-controls-before-the-snapshot` accepts a sweep
with no rebuild, since a rebuild that is not there cannot roll a control back.
