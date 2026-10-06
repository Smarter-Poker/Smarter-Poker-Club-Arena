# The union sweep refreshes the windowed snapshot again (2026-10-03)

Migration: `20261003235228_the_union_sweep_refreshes_the_windowed_snapshot_again`.
Law: `tests/the-union-sweep-stops-rebuilding-an-unread-snapshot.law.test.ts`
(`docs/laws.d/the-union-sweep-stops-rebuilding-an-unread-snapshot.md`).

## Why

Two fixes to the same hourly cost landed thirty minutes apart:

- `20261003225101` (phase 7, applied 23:05 UTC) removed the open-week rake basis
  rebuild from `fn_union_integrity_sweep_all`, because the one-read rebuild had
  been cancelled at job 123's 300 s every hour since 2026-09-29.
- `20261003224956` (accounting coordinator, merged 23:36) made the rebuild
  incremental: two-hour windows, closed windows reused while their input stamp
  is unchanged, nothing started past 120 s (closed) or 180 s (tail). After
  warming, a run proves one new window and the open tail.

With the call removed, the coordinator's refresh never runs and the snapshot it
was built for stays at 2026-09-28. The cost that justified the removal is gone
once the refresh is windowed, so the call goes back.

## Change

The sweep returns to its exact text of before `20261003225101` (md5
`729a5617...`): money controls first, then the refresh in its own subtransaction
that traps a statement timeout and stops for the hour. The migration refuses
unless the live sweep is the `6000297c...` text and the live
`fn_union_rake_basis_refresh` is the windowed one, so the one-read rebuild can
never come back through this file.

## Proof

Local PG17: on the `6000297c...` sweep with a one-read refresh the migration
refuses with `THE_REFRESH_IS_NOT_WINDOWED_YET`; with a windowed refresh it
applies and the sweep reads back as `729a5617...`.

## Applying

No row-lock or write keyword in the file, so it can be applied through the
Supabase MCP once `20261003224956` is live, outside the :50-:03 break window.
