# Lightning Summary Follows The Final Cash-Out

Leaving during a live hand can queue the cash-out until settlement. The Lightning summary fetched once when it opened, so its first unfinished result could remain after the final hand and credit completed.

The summary now carries the original anchor occupancy and refreshes on its matching existing `SEAT_CASHED_OUT` event. Duplicate events coalesce, unrelated occupancies do not refresh it, and stale responses cannot replace the final result or a different session. Both leave doors capture the original summary context before leaving.

This changes the summary consumer only. The existing cash-out transaction and watcher remain unchanged; no new polling or financial command is added. Two refresh regressions fail against the original hook. A further regression pins that a failed final refresh removes unfinished statistics and shows the existing error state. All 24 focused session-app tests pass with the corrections.
