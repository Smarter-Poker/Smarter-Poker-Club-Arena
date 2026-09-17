# A confirmed game admission has a live offer

The public-launch review found that `fn_cash_game_join` did not take the game
row lock assumed by the already installed cancellation function. If a player
cancelled while another tab was joining, join could read the old offer, wait
for cancellation, update its expiry after it became `left`, and return `seat`.
The response then named an offer that was no longer active.

The migration adds `FOR UPDATE` to the join function's first game read. Join,
cancellation and the planner now serialize before reading admission state.
An overlapping join ordered after cancellation can create a new valid offer;
an admission ordered before cancellation is retired by that cancellation.
The existing table-capacity lock, caller identity, eligibility checks, grants,
and seated-player behavior are preserved. No wallet or seat data is rewritten.

Production readback on September 17 matched reviewed join definition MD5
`1b9173dde43a3e6d4e887843deeaa9e7`. Its September 10 source is the comparison
baseline; no successful real join/cancel concurrency proof was found. The
earlier cancellation test manually acquired the supposed join lock and did
not execute the actual join function, so its success did not cover this race.

`scripts/dev/probe-cash-game-admission-lock.py` loads the actual baseline join
and installed cancellation from their migrations into disposable PostgreSQL
17. Two concurrent connections reproduce the invalid offer before the fix
and require one live offer afterward. It also verifies duplicate admission,
subsequent cancellation, authentication, unchanged execute grants, migration
replay, and rejection of an unreviewed definition. The existing accounting
probe invokes it; no new workflow or scheduled process is introduced.

This proves the database admission boundary. It does not establish full
browser transfer, websocket delivery, or financial acceptance of other flows.
