# A stranger is not told the seat mix

2026-10-05. Launch audit item 18. Engine only.

## What was wrong

Caddy forwards every path on `engine.smarter.poker` to the engine with CORS
`*`, and two telemetry routes answered anyone:

- `GET /metrics` published `poker_humans_seated`, `poker_horses_seated`,
  `poker_tables_with_humans`, `poker_tables_with_horses` and their relatives.
  A seated player who reads `poker_humans_seated 1` knows every opponent is a
  horse.
- `GET /stable-hand` published the fleet's size, its plan and house wallet ids,
  and ran database reads per anonymous request.

Migration 20261005115325 closed the database columns the same day; these were
the engine's own doors.

## What changed

`server/src/http/publicStranger.ts`: a request that carries `X-Forwarded-For`
came through Caddy. If it does not also carry the internal key:

- `/metrics` is answered without the seat-mix families (samples and their
  HELP/TYPE lines). Every other family is unchanged.
- `/stable-hand` is answered `401` before it reads anything.

The on-box Prometheus scrape (`host.docker.internal:8080`, no proxy header)
reads every family as before, so no alert loses its series.

## Not changed here

`/health` still carries `humansSeatedTotal`. The World Hub's staff horse
console reads it from the public URL without a key
(`pages/api/horses/platform-admin.js`), so removing it is a two-repo change:
the console has to read the count another way first.

## Proof

`server/src/http/publicStranger.test.ts`, 21 cases: which families are and are
not seat mix, exact output of the filter, and the router answering both a
proxied and an on-box request. `tsc --noEmit` clean.
