# Capacity dealer admission keeps its bounded turn

The freeze continuation found five newly opened Coffee Break Freeroll tables
with seated players and no committed hand on production, 2026-10-26 14:30 UTC.
Four had waited over four minutes; their capacity receipts and late-registration
wake were still pending. Earlier Morning Free Buy capacity receipts had waited
14 to 27 minutes, then all admitted at the synchronized break.

PR #8093 moved admission ahead of the ordinary sweep stages, but it still
followed entry reconciliation and the seatless-entry read. Any earlier work,
or the capacity receipt read itself, could spend the five-second sweep budget.
`eliminationMutationAllowed()` then returned without starting a dealer. The
next admission repeated the same reads instead of making progress.

Dealer admission now precedes seatless-entry work, after the existing entry
authority confirms continuation. External terminal adoption still wins. One
page of at most twenty committed capacity receipts gets its own mutation batch,
so an already-spent ordinary budget or a slow read cannot prevent its starts
and acknowledgement. The batch closes in `finally`. Manager stop, scheduler
abort and maintenance freeze still prevent new starts; freeze is rechecked
before acknowledgement. Table creation, seat movement, balancing, financial
entry close and the existing prepare-before-start path are unchanged.

`CapacityAdmissionKeepsItsBoundedTurn.test.ts` exercises the real admission
helper with a read longer than the work budget, stop/abort/freeze during the
read, lost-acknowledgement continuation, and real sweep ordering. The existing
external-terminal and capacity source contracts remain enforced. No watcher,
repair cron, direct production mutation or second dealer path was added.

This is an engine repair. Source qualification and protected publication are
separate from activation and live proof of newly opened tables dealing.
