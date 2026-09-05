# 2026-09-05: Realtime programme, Phase 2 of 7 - See the client

On 2026-09-03 Dan's tables said "Reconnecting To The Table" for twenty-two
hours. Every close code, every retry and every twenty-second auto-reload
happened inside his browser and reached this platform as **nothing**. The
engine's own view was perfect throughout - it was dealing 5,700 hands per ten
minutes - because the half that was broken was the half nobody could see.

Phase 1 measured what the engine does. This measures what the player gets.

## The beacon

`src/services/clientConnectionBeacon.ts` posts a single word - why the socket
went away - to `POST /client-event`. No user id is sent; the server takes it
from the verified token, so nobody can report events as somebody else.

Four call sites, one per way a client actually loses a socket:
`auth_failed` (4401), `stale` (the watchdog tore down a silent socket),
`handshake_timeout` (never reached OPEN), and `auto_reload` (TablePage's
twenty-second failsafe actually fired).

It obeys four rules, because it runs beside a live table: it can never affect
play, a reconnect storm is not a request storm (one beacon per reason per
minute), it never retries, and it stays quiet when signed out. The outage
this exists for produced a retry every few seconds for a day; that now costs
a handful of requests an hour.

## Cardinality is the design

Dan asked for an alert on "one player reconnecting more than N times an
hour". The obvious shape - a counter labelled by user id - is 1,300+ series
and grows with the player base. So the per-user counting happens in the
engine, in a bounded rolling hour, and only three low-cardinality numbers are
published:

    poker_ws_client_reconnects_total{reason}   how often, and why
    poker_ws_clients_reconnecting_badly        players over the line
    poker_ws_worst_client_reconnects           the worst single player

No user id ever reaches Prometheus. Memory is bounded by eviction at 5,000
tracked users, four times the platform's entire user count.

`auto_reload` is counted but deliberately does NOT inflate the per-user
reconnect number: it is a symptom report, not a reconnect, and letting it
count would double-report the same failure.

## The alerts

- **PlayersReconnectingRepeatedly** (warning): more than six reconnects for
  one player in a rolling hour, sustained ten minutes. This is Dan's question
  asked directly, and it is the rule that would have spoken on 2026-09-03.
- **TablesAreReloadingThemselves** (critical): the twenty-second auto-reload
  failsafe firing three times in thirty minutes. It fired all night during
  the outage without the platform knowing; repeated firing means players are
  being thrown out of tables rather than recovering in them.

Both carry the maintenance-break guard.

## Laws

- `theClientIsHeard` - bounded cardinality and no user id in the exposition,
  the rolling window really ages out, "badly" is strictly over the threshold,
  memory is bounded, `auto_reload` does not inflate the per-user number, and
  the route takes the user from the token and never the body.
- `the-client-beacon-cannot-storm` - one beacon per reason per minute however
  often it is called, it returns undefined so nothing can await it, a failing
  request is swallowed with no retry, and signed out it sends nothing.
