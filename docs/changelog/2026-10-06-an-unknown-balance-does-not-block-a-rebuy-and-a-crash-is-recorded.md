# An unknown balance does not block a tournament rebuy, and a crash is recorded (2026-10-06)

Two defects from the launch audit of 2026-10-05, both in what the table does
when something has already gone wrong.

## An unknown balance does not block a tournament rebuy

The tournament rebuy prompt was handed `accountBalance || 0`. That balance is
read once at table load and refreshed only by balance bus events, and a read
that failed is `null`. So a prompt opening an hour into an event was judged on
an hour-old figure, and a failed read became zero: red balance, Rebuy
disabled, and the player was eliminated when the window closed while holding
the chips to stay in. The cash bust prompt has always re-read and offered a
retry; this one did neither.

- `RebuyModal`: the balance is `number | null`. Unknown allows the attempt
  (the server, which debits, decides) and prints `--`, never an invented 0.
  A balance that was read and is short is still refused before the server is
  asked.
- `TablePage`: the balance is re-read when the prompt opens.

## A crash at the table is recorded

The error boundaries (`TableErrorBoundary` around the live table,
`PageErrorBoundary`, `PanelBoundary`) wrote `client_crash_log` straight from
the browser. Read on production: that table grants INSERT to `service_role`
and `postgres` only, so every such insert was refused, inside the try/catch
that exists so reporting can never throw. The table held 2,765 rows from the
World Hub's boundaries and not one from Club Arena. `TableErrorBoundary` did
not even try: it logged to the console and emitted a bus event whose one
subscriber is an admin page.

All three now post to the World Hub's existing same-origin sink,
`POST /api/client-crash` (service role behind a rate limit), through
`src/utils/reportClientCrash.ts`, as boundary `page` with a section that names
the surface (`club-arena-table:...`, `club-arena-page:...`,
`club-arena-panel:...`).

## Proof

`tests/unit/anUnknownBalanceDoesNotBlockATournamentRebuy.test.tsx`,
`tests/unit/reportClientCrash.test.ts`. The production read-back of one
labelled row through the published client's sink is recorded in the pull
request.
