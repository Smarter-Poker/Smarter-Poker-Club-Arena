# 2026-10-04 Timeout and reconnect audit: client

Client change: uses engine behaviour that is already live (the action
idempotency key and decision context of 2026-09-05). No engine dependency.

## An action that did not arrive is sent again, as the same action

A tap made while the link was changing ended as "Server unreachable", which
the felt suppresses as a self-healing message. Nothing was healing: there was
no retry and no toast, the action bar came back, and the clock ran on.

`submitAction` now re-sends an action nobody answered (a thrown fetch, a
request past its four-second deadline, a 502/503/504) up to twice, with the
same body, idempotency key and decision context, inside a ten-second budget.
The engine answers a key it has already run with its first answer and refuses
a context whose turn has moved on. A 400 or a 500 is never re-sent. If every
send fails the player reads "Your Action Did Not Reach The Table. Check The
Table And Try Again", which is not suppressed.

`tests/game-server-retry-session.test.ts` pinned "does not retry ambiguous
server failures" with one fetch for a 503. That case is replaced in the same
change: the 503 is re-sent as the same intent and never through the
session-refresh replay, and a 500 is still sent once.

## Calls that answer a clock have a deadline

`/action`, `/timebank` and `/heartbeat` are aborted after four seconds. A
heartbeat that hung was never counted as a miss. A beat that passes its
deadline is reported as a miss but does not feed the circuit breaker, whose
thirty-second pause would otherwise withhold the first beats after a slow link
recovered.

## "No game for this table" is an answer, not an outage

A 404 heartbeat counted toward the circuit breaker that every open table
shares, and a table the page had already declared no longer running went on
being heartbeated every five seconds for as long as it stayed mounted.
Production, two days to 2026-10-04: 3,141 such 404s and 295 "heartbeat missed
3x" reports from two players. The 404 no longer feeds the breaker, and the
beat stops once the page holds the "This Table Is No Longer Running" verdict
(released when the socket connects again).

## A silent link is asked to prove itself

Two consecutive heartbeats with no answer now run the existing bounded wake
probe on the table socket (`EngineStateClient.probeLink`): one RESYNC, five
seconds, then the ordinary reconnect ladder. Detection of a link that died
without closing drops from about fifty seconds to about fifteen.

## Tests

- `tests/an-action-that-did-not-arrive-is-sent-again.test.ts`
- `tests/a-silent-link-is-asked-to-prove-itself.test.ts`
- `tests/game-server-retry-session.test.ts`, `tests/unit/GameServerAPI.test.ts`
  (pins moved with the behaviour)

## Not verified

Not published and not exercised in a browser or on a device. The mounted
TablePage wiring is pinned by source, not by a mounted test.
