# Completed Waiting Work Is Liveness

At 21:06-21:08 UTC the bounded engine log sample contained 121 zombie rebuild
reports and 124 watchdog kills. Health showed one-player tournament tables in
start_wait_for_players with progress ages approaching 180 seconds. The engine
had resumed 597 tables at 21:00, compared with 267 at the previous cutover.
That fleet change and other tournament failures are observations, not attributed
to this patch.

Discovery considers every tournament-owned table eligible for its 180-second
no-progress reaper. The startup waiting loop read seats, maintained presence,
processed idle work and published state, but never marked successful passes as
progress. A perfectly alive one-player table therefore looked dead every three
minutes and paid teardown, restore and admission work repeatedly.

The fix stamps progress after a complete under-minimum waiting sweep and a final
lifecycle ownership check. It does not stamp at the start of an attempted read,
on read rejection, or from a timer independent of work. Hung reads and hung
awaited cleanup therefore remain detectable. It does not start a hand with one
player or change tournament accounting, lease or settlement guards.

The actual start() regression fails before the fix for cash and tournament
one-player tables (181000ms progress age after another completed pass). It passes
afterward. A pending roster read still exceeds the reaper age without a progress
stamp. 44 focused tests across five files pass; server TypeScript passes.

Release and live rebuild-rate verification remain required after the scheduled
engine cutover. Separate ghost-seat, launch-proof, lease-fencing and knockout
candidate conflicts were observed and are not fixed by this liveness change.
