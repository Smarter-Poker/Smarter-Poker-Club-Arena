# Rewards reads the selected event

The bounty loader in RewardsTab retained a previous tournament ledger when switching to another bounty event. A failed new read even retained the former pool as successful. The state now carries its tournament ID and only renders for that event. Same-event refresh failures preserve the last verified figures.

The loader also treated null as an empty response, silently returned its 100-page prefix, and used unordered offsets on a changing filtered field. It now requires arrays and strictly advancing ID cursors, stops on retirement, and refuses incomplete reads. This is not a transactionally atomic snapshot across queries. No payout or wallet behavior changes.

Four rendered regressions fail before the fix (scope, null, disappearing earlier row, repeated cursor). Seven focused cases and 95 connected checks pass; TypeScript passes. Source pins now require the ID cursor without weakening the live-player filter. Existing knockout-triggered refresh remains; no new timer or repair job.
