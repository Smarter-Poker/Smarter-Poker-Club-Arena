# Two windows are a boundary, three are a drift (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003135514_two_windows_are_a_boundary_three_are_a_drift`, live as schema_migrations `20261003140538`.

## What was wrong

`fn_ca_trial_balance_watch` filed two info incidents for 01:05-02:05 on 2026-10-03:

- `player_wallets` -169.50, after -105.00 the hour before;
- `tournament_liability` +182.00, after +107.00.

The next hour reversed both (+131.00 and -130.00). Over the 31 hourly readings from 2026-10-02 07:20 to 2026-10-03 13:20, every difference on both accounts sums to exactly 0.00.

A leg is windowed by its stamp, and a balance by the snapshot that first sees it. A movement whose leg and balance land on either side of a cut therefore reads +x in one window and -x in the next. A run of such movements can lean the same way for two windows before it reverses. No chip was lost.

## What changed

A drift is now filed only after three consecutive readings over the threshold in the same direction. A real leak does not reverse, so it still files, one hour later than before. Of the 24 readings the two-window rule fired on over fourteen days, a third reading confirms 3; the other 21 reversed.

Both incidents were resolved with their root cause.

Pinned by `tests/two-windows-are-a-boundary-three-are-a-drift.law.test.ts`.
