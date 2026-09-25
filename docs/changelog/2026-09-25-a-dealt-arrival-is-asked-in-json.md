# A Dealt Arrival Is Asked In JSON

Date: 2026-09-25. One line in `server/scripts/legacy-engine-checkpoint-guard.mjs`
and the mock that hid it in `tests/legacyEngineCheckpointGuard.test.ts`. No
engine change, no migration.

## What was wrong

Run 36081290135 (the 00:55 UTC break, the first engine release attempt to pass
the mixed-custody stage since 2026-09-22) refused at the very start of the
bank proof:

```
reason=bank_residue_unproven failedCheck=proveBanksHeldNothing.dealtSinceRead
observedDetail=error=22P02,rows=null,ceiling=1
```

`proveBanksHeldNothing` asks, for every cash seat move executed inside the last
hour, whether the destination table has since dealt that player a hand
(#5213). The question was written as
`.contains('players', [{ userId }])`. `hand_history.players` is jsonb, and
postgrest-js encodes an ARRAY argument to `contains` as a Postgres array
literal, so the wire carried `players=cs.{[object Object]}`, which Postgres
refused as invalid JSON (SQLSTATE 22P02) on the first arrival in the window.
The test mock accepted an array and read `value[0].userId`, so nothing local
could see the encoding.

## What changed

The argument is now the JSON text of the containment,
`JSON.stringify([{ userId }])`; a string is sent verbatim, so PostgREST runs
`players @> '[{"userId": "..."}]'` as intended. The mock now demands a string
that parses to exactly `[{ userId }]` and refuses `[object Object]`.

## Verification

`tests/legacyEngineCheckpointGuard.test.ts`: with main's guard, "accepts a move
inside the hour once the destination has dealt that player a hand after it"
fails (`guard_failed` from the mock's refusal); with the fix all 250 pass.
Production read-only check: `hand_history.players` is jsonb, an array of
objects with a `userId` key.
