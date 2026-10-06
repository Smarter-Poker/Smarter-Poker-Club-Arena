# A refused top-up is not a dropped connection

2026-10-05. Launch audit, table client. Client only; no engine change.

## What was wrong

`GameServerAPI.addChips` threw on every non-2xx response, and its catch labels
whatever it catches `TRANSPORT`, meaning "the outcome is unknown". The engine
answers each refusal it makes (the maintenance break, the table maximum, a
wallet that cannot cover it) with a 4xx and its own sentence
(`server/src/handlers/addchips.ts`: `sendJSON(res, result.success ? 200 : 400,
result)`). So every refusal reached `TablePage` as `TRANSPORT`, and the player
was told "The Connection Dropped Before The Table Answered. Your Chips May Have
Been Added." about a request the engine had declined in words. The real reason
was never shown.

## What changed

`src/services/GameServerAPI.ts`: a 4xx whose body carries an `error` sentence
is returned as a refusal with that sentence and no `TRANSPORT` code. A 5xx, a
4xx with no sentence, and a request that never got an answer are still
`TRANSPORT`, because nobody can state those outcomes and the 2026-08-27 cashier
audit rule (never tell a possibly-charged player they were not charged) still
holds.

## Proof

`tests/unit/GameServerAPI.test.ts`, seven new cases. Before the change the four
refusal cases fail (they come back `TRANSPORT`); after it all pass, and the
three unknown-outcome cases pass both before and after.
