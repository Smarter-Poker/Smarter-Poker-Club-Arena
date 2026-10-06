# server/src/tournament/anUnprovedHandIsHandedToASuccessorGeneration.law.test.ts

An Unproved Hand Is Handed To A Successor Generation: on 2026-10-06 from 06:10
UTC a database stall exhausted the settlement replay on 78 tables of two events.
Every hand was retained, but the stopped engines kept their `attempted` permits,
the manager refused to replace them, and the only door that settles a retained
hand refuses the generation that retained it, so recovery rescheduled itself
until the process was replaced. This pins that a stopped original holding an
`attempted` permit of the manager's own lease generation makes the manager ask
its owner for a successor generation (exact manager stopped and lease released
through `stopTournamentManagerIfOwned`), that every other table first finishes
the hand in front of its players and deals no other, and that `unknown`,
`reserved` and `terminated` permits keep the ordinary causal retry.
