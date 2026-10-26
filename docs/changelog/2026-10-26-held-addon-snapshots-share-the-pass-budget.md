# Held add-on eligibility reads share the purchase pass budget

The whole-field add-on pool could still offer nobody when its four eligibility
reads exhausted the ordinary five-second elimination budget before the pool
started. Reproduced with 186 seated horses and four 1.6-second reads: zero
purchases before the repair, all 186 afterward.

The held-field path now applies one existing 20-second pass deadline across
eligibility reads and purchases. It can enter with a spent ordinary budget,
without opening a mutation batch around database reads. Manager stop, sweep
abort, maintenance freeze and the persisted offer deadline remain authoritative.
Playing fields retain the ordinary work budget. No prices, funding, canonical
purchase RPC, idempotency keys, offer duration or retry cadence change.

The maintained whole-field regression suite covers slow reads, an already spent
budget, stop, abort, freeze, offer expiry, pass expiry and ordinary playing-field
yielding. Publication and real tournament evidence remain separately required.
