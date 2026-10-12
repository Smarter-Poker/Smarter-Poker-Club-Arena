# A Postgres error is an answer, not a lost response (2026-10-04)

## What happened

Critical `financial_alerts` row `f2191cb7` (2026-10-03 20:13:19 UTC,
`Tournament.satellite_qualifiers_outcome_unknown`) said the qualifier
settlement of satellite `ab4a05ce` ("Saturday Night Big Stack Satellite",
24 entrants, 8 qualifiers) had an unknown outcome and that the event's
dealers were fenced.

The Postgres and API logs show the outcome was never unknown:

| UTC          | What                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 20:13:03.2   | `fn_settle_satellite_qualifiers` waits for the exclusive `ca:tournament-finish-lane:v1` (every other finish on the platform holds it shared).                          |
| 20:13:11.3   | Cancelled: `55P03 canceling statement due to lock timeout` (the authenticator role's `lock_timeout = 8s`). PostgREST rolled it back and returned the SQLSTATE.           |
| 20:13:11.4   | The engine treated that body as a lost response and called `fn_resolve_satellite_qualifier_outcome`, which takes the same exclusive lane.                               |
| 20:13:19.6   | The resolver is cancelled with the same `55P03`.                                                                                                                         |
| 20:13:19.7   | The engine reports `satellite_qualifiers_outcome_unknown`, stops the event's manager (`fenceUnknownTerminalOutcome`), and raises the critical alert.                    |
| 20:13:48.3   | The next pass settles it whole.                                                                                                                                          |

## What the players got (read from rows, 2026-10-04)

`tournament_satellite_settlements` receipt v3, settled 20:13:48.323719,
pool 432.00, ticket 50.00:

- six cash awards of 50.00, each credited once to the wallet
  (`7a74d9fe`, `7c0be9c9`, `7c165d15`, `7e464f21`, `e8b32dc2`, `e96f6e72`);
- two target seats of 50.00 in Saturday Night Big Stack `bee370a7`
  (`e8cca6bc`, `f6371734`), both of whom played it (70th and 36th);
- remainder 32.00 to place 9 (`f140e49c`);
- 48.00 fee retired. 400.00 + 32.00 = 432.00; nine `tournament_payouts`
  rows, one per idempotency key.

The satellite is COMPLETED, its three tables are closed, no seat is open,
and no manager holds it. Nobody was short and nobody was paid twice. All
nine are horses and were paid exactly as players are.

## The cause

`requestSatelliteQualifierReceipt` (`server/src/tournament/satelliteQualifierRpc.ts`)
kept only `error.message` from the settlement call and sent every error down
the lost-response path. A five-character SQLSTATE in a PostgREST error body
is the database saying the transaction rolled back. Only a missing response
(postgrest-js reports a transport failure with `code: ''`) leaves the outcome
open. Then the resolver, a read, was asked exactly once, and its own lane
contention was reported as unknown. That second step also explains the
2026-10-02 alert `79cdb720`, where the settlement had committed before the
response was lost.

## The fix

- `isRolledBackStatementError` (`settlementRefusal.ts`): a SQLSTATE body
  proves a rollback, except the classes that can describe a connection or a
  server that died around a COMMIT (08, 53, 57, 58, XX). PGRST codes never
  match.
- A settlement error that proves a rollback is now a
  `SatelliteSettlementRefusedError`: the boundary stays held, the sweep
  answers `pending` and retries in 5 seconds. A `F06_SOURCE_EXCLUDED` refusal
  still reaches the balance stage.
- A lost response still asks the serialized resolver, and the resolver's
  lane contention (55P03, 40001, 40P01, 57014) or transport loss is asked
  again, three reads at most (0.5 s, 1 s apart). Unknown is reserved for a
  lost response the resolver could never read.
- Pinned by `server/src/tournament/aPostgresErrorIsAnAnswerNotALostResponse.law.test.ts`.

No sweep, repair job or monitor was added. The alert is closed on its
receipt by `20261004201450_the_satellite_qualifier_alert_of_2026_10_03_closes_on_its_re`.
