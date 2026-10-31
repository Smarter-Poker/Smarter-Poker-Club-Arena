# Eleven-table elimination cursor regression

The October 23 Coffee Break Freeroll (PLO4), tournament
`a99d2838-aee6-4af5-bd79-318565f5ed93`, stopped recording eliminations from
18:28:20 to 18:53:12 UTC. Eleven source tables could not complete breaks:
their zero-chip registrations still read `playing`, so the F06 whole-roster
and elimination-evidence guards correctly refused admission.

PR #7826 repaired the independent successor-drain ownership bug. It did not
repair why the original manager stopped reaching its elimination stage.

The incident's serving revision `74c1ff919e0b1027874b4bcbdc2f4ad99f98a6f6`
also contains a deterministic cursor deadlock. A new bust rewinds a later
stage to elimination and remembers the interrupted stage. If that pass then
stops at balance, waiting for another bust on a source table to be recorded,
it cannot reach the remembered stage. The guard consequently refuses every
new bust rewind. Neither side can make the progress the other requires.

PR #8134 (`62d50bcfa46b4978c9c3c10c878d86e04f6be965`) already repairs this
mechanism: a stage that receives a full fresh admission without advancing
releases the rewind guard. It preserves the turn owed to later work without
requiring later work to finish first. This follow-up retains that source
fix and adds connected regression protection rather than duplicating it.

The extended existing law test runs the real manager, cursor and hand-complete
callback for eleven independent tables. Each table introduces a new bust while
balance repeatedly consumes the work budget and cannot reach interrupted
stages 6, 7 or 8. All eleven receive distinct non-winner finishing positions
within bounded admissions. The balancer continues receiving turns. No break
expiry, maintenance window, successor request or manager restart supplies
progress. Transport and the financial write are isolated; this is not a new
production payment or a substitute for PostgreSQL transaction qualification.

The three connected cases fail with the historical cursor: the first table is
recorded but the second remains blocked after four admissions. They pass with
the existing repair. The same shared path serves all tournament dealers;
there is no club, table, player-type or variant exception.

The retained October 23 log does not include the manager's cursor state or
awaited step at the moment it stopped recording. This proves a root blockage
present in that serving source and matching the observed dependency cycle,
not a recovered stack trace establishing the unique historical trigger.
