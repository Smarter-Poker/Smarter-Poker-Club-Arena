# The dealt-since question is asked in a form the database can answer (2026-09-25)

Run 36081290135 (the 01:24 UTC recovery window, on #5218) refused before it
wrote anything:

```
reason=bank_residue_unproven  failedCheck=proveBanksHeldNothing.dealtSinceRead
observedDetail=error=22P02,rows=null,ceiling=1
```

`22P02` is `invalid_text_representation`. The read behind it is the one #5213
added: is there a `hand_history` row at the destination table, after the move
executed, with the mover in its `players`? It was written as
`.contains('players', [{ userId }])`, and the Supabase client serialises a
JavaScript ARRAY as a Postgres array literal (`players=cs.{[object Object]}`)
rather than JSON, so Postgres refused the cast to `jsonb` before the question
was ever put. Every earlier window passed this proof only because its one
arrival was older than the hour and never reached the read (the receipt's
`arrivalsInWindowChecked=1` counts arrivals, not the ones inside the hour);
01:24 was the first attempt to meet a move inside the hour since the question
was written.

## The fix

The hands dealt at the destination after the move are read back - `id` and
`players`, oldest first, at most 200 - and the mover is looked for in them in
the guard, where the shape is known (`players[].userId`, read from the rows).
One hand with the mover in it admits the move exactly as before; no hand, a
page that fills, an error or an unreadable row keeps the refusal exactly as it
was. No operator whose serialisation depends on the client's guess of the
column type is left on this path.

## Pinned

`tests/legacyEngineCheckpointGuard.test.ts` (252): the fixture now models the
read the guard makes (`select('id,players')`, ordered, limit 200); a mover
dealt in the second hand after the move admits it (case-insensitive on the
id); hands since that never dealt the mover, an unreadable answer (the 22P02
this run met), an unreadable row and a page that fills all still refuse.
