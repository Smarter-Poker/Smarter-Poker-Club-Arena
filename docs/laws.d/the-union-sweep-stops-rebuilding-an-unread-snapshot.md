# tests/the-union-sweep-stops-rebuilding-an-unread-snapshot.law.test.ts

The hourly union integrity sweep only rebuilds a bounded open-week snapshot.
The one-read rebuild of `union_rake_basis_snapshot` stopped finishing inside job
123's 300 s on 2026-09-29, so `20261003225101` took it out of
`fn_union_integrity_sweep_all`; the accounting coordinator's `20261003224956`
then made the refresh incremental (`fn_union_rake_basis_windowed`), and
`20261003235228` restores the call, refusing to apply unless the refresh in
force is the windowed one. The law pins that the sweep in force runs the
integrity sweep, invoice ageing, stop-loss, lock expiry and hygiene and period
closes, and calls the refresh, if at all, only after every one of them; that the
windowed refresh exists in the migration chain and the restoration checks for
it; and that neither change adds a schedule.
