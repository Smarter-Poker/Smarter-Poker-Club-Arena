# 2026-10-19: a late MTT start is visible

`tournaments.started_at` is written equal to `start_time` (166 of 166 MTTs in
the 24 h to 2026-10-19 22:00 UTC), so no rule could see a late launch and
`TournamentNeverStarted` only fires on an MTT still REGISTERING ten minutes
after its start. Measured from the first dealt hand, from 2026-10-12 to 10-18
20-30% of scheduled MTTs dealt their first hand over 60 s late and 9-14% over
120 s (worst 7,648 s). Every :53-:57 start was late (held through the hourly
break); :00 starts had a median of 85 s, 59 of 212 over 120 s.

- Database (PR #7506, installed 2026-10-19 23:30 UTC through
  apply-merged-migration.yml): `fn_tournament_launch_lateness_metrics`, a
  read-only function measuring from `hand_history.started_at`. `started_at`
  keeps its meaning.
- Engine: `TournamentMetrics` reads it once a minute, independently of the
  established tournament reads, and publishes `poker_mtt_late_first_hands`,
  `poker_mtt_late_start_waiting`, `poker_mtt_worst_late_start_seconds` and
  `poker_mtt_launch_lateness_stale_seconds`. Until the database answers, the
  three counts are absent (unknown), never zero.
- Alerts: `MttStartedLate` (warning) fires when a first hand was dealt more
  than 2 minutes late or no hand exists 4 minutes after start;
  `MttLaunchLatenessBlind` fires when the read has not answered for ten
  minutes. Runbook `docs/runbooks/mtt-started-late.md`; promtool cases in
  `tests/monitoring/mtt-started-late.test.yml`.

The alert is not break-guarded: an event held through the break still started
late for its players. Expect it to fire on some break-adjacent starts until
their launch is fixed at the source.
