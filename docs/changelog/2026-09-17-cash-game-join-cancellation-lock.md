# A confirmed game admission has a live offer

The public-launch review found that `fn_cash_game_join` did not take the game
row lock assumed by the already installed cancellation function. If a player
cancelled while another tab was joining, join could read the old offer, wait
for cancellation, update its expiry after it became `left`, and return `seat`.
The response then named an offer that was no longer active.

The migration adds `FOR NO KEY UPDATE` to the join function's first game read. Join,
cancellation and the planner now serialize before reading admission state.
An overlapping join ordered after cancellation can create a new valid offer;
an admission ordered before cancellation is retired by that cancellation.
The existing table-capacity lock, caller identity, eligibility checks, grants,
and seated-player behavior are preserved. No wallet or seat data is rewritten.
The selected lock mode permits the roster foreign-key read made by a buy-in
that already holds its table-capacity lock. A stronger game lock would create
a lock-order cycle; the additional two-connection regression preserves this
actual parent/child constraint and table advisory-lock ordering.

Production readback on September 17 matched reviewed join definition MD5
`1b9173dde43a3e6d4e887843deeaa9e7`. Its September 10 source is the comparison
baseline; no successful real join/cancel concurrency proof was found. The
earlier cancellation test manually acquired the supposed join lock and did
not execute the actual join function, so its success did not cover this race.

`scripts/dev/probe-cash-game-admission-lock.py` loads the actual baseline join
and installed cancellation from their migrations into disposable PostgreSQL 17. Two concurrent connections reproduce the invalid offer before the fix
and require one live offer afterward. It also verifies duplicate admission,
subsequent cancellation, authentication, unchanged execute grants, migration
replay, and rejection of an unreviewed definition. The existing accounting
probe invokes it; no new workflow or scheduled process is introduced.

This proves the database admission boundary. It does not establish full
browser transfer, websocket delivery, or financial acceptance of other flows.

## The lobby controls remain reachable during announcements

The same review observed the live 39px announcement strip covering the lobby
title and the centers of Join Game and Close. The overlay started at viewport
top under the higher announcement layer. Its top now uses the ticker's existing
measured `--mtt-ticker-h` clearance, including the safe area. With no ticker,
the original geometry is retained. The phone sheet and desktop panel retain
their existing layout. This small CSS correction requires live visual readback,
not a new test fixture or changes to tournament announcements.

## The lobby owns the keyboard while open

TablePage omitted Must Move from its modal flag, so the shared keyboard hook
could fold, call, raise, or size a bet behind the open lobby. The same shared
Escape callback omitted its close setter. Both now use the existing modal
path. The regression executes the actual TablePage expressions and real
keyboard hook: all betting and Rabbit Hunt shortcuts stay blocked until the
lobby closes, Escape closes it, and an in-flight buy-in remains visible. Both
new cases fail on the prior wiring; all 16 tests in the affected suite pass
afterward. This does not claim a full live seated-player keyboard test.
