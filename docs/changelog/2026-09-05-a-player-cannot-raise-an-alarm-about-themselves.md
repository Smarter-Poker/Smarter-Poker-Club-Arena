# 2026-09-05: a player cannot raise an alarm about themselves

Phase 2 audit. The beacon throttles itself to one report per reason per
minute — and the server trusted that. The client is the thing being
measured, so trusting its restraint was the wrong shape.

## The defect

`POST /client-event` is authenticated but had no rate rule of its own. Any
signed-in player could post it in a loop and drive
`poker_ws_clients_reconnecting_badly` over the line, raising
**PlayersReconnectingRepeatedly about themselves** — an alert triggerable on
demand by the person it is about.

A monitor a player can fire at will is worse than no monitor: the first false
page is the one that teaches everyone to ignore the real one. That is the
same lesson as the 500 ms threshold that sat below the median, one layer up.

## The fix

The server enforces the same rule independently, keyed on user + reason and
checked **before** anything is counted, so a flood inflates neither the reason
counter nor the per-user number the alert reads. Dropped events are counted in
`poker_ws_client_events_throttled_total`, so the flood itself is visible rather
than silent. The throttle map is bounded like the others — stalest half evicted
rather than grown. The caller still gets its 204: there is nothing a client
should do differently either way.

The throttle is **per reason**, so a genuinely broken client still reports
each distinct failure it hits, and a real player over the threshold is still
caught — pinned explicitly, because a throttle that hides the thing it
protects would be the worse bug.

## Two existing pins changed, deliberately

LAW 2 and LAW 4 fired their events milliseconds apart and now, correctly,
count once. They are spaced past `SERVER_THROTTLE_MS`, in this same commit,
because the behaviour change is intended (CLAUDE.md 5.8). LAW 4's point is
unchanged and now sharper: `auto_reload` never becomes a reconnect, whatever
its count.
