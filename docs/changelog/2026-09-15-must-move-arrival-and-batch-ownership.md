# Must Move arrival provenance and partial transfer batches

This is a source candidate, not an applied migration or a verified release.

A planned move used to deposit presence under only a player and destination.
If the plan was cancelled, a later voluntary visit could adopt that old
sit-out state or time bank. Deposits now identify the immutable move and
source occupancy. The destination reads the retained transfer receipt for
its exact active occupancy before adopting presence. The read cannot execute
a move, change a seat, or move chips. Separate deposit keys also prevent a
delayed old reply from overwriting a different transfer's staged state.

Every due mover stages its current presence at the hand boundary before the
executor is called. This covers idle, unannounced moves and a destination
that sees the committed chair before the source receives its reply. The
startup and dealing paths both await arrival proof before registering the
player. An unreadable result retains the deposit and defers registration;
engine retirement or a changed occupancy cannot consume a late result.

The same roster-adoption step now clears prior cash-stay mirrors at both
waiting and dealing tables. It handles direct replacements and an observed
empty interval between visits, preserves same-stay state, and retains both
departure and arrival wake detection. Tournament roster handling stays on
its existing authority path.

A later unreadable executor result previously discarded earlier confirmed
results in that batch. A typed error now carries those earlier outcomes so
the engine can reflect the completed moves, holds and refusals before
propagating the original failure. The unknown move is not classified as a
refusal, and later candidates are not executed. Withdrawal of engine
authority also stops later dispatches and retries; already issued requests
remain awaited.

## Source and validation boundaries

The new engine-only read is `fn_cash_seat_move_arrivals(uuid, uuid[])`, in
migration `20260915134400_cash_move_presence_reads_confirmed_arrivals.sql`.
It joins the immutable receipt to the current player, destination and
occupancy, with bounded inputs and an index for the occupancy lookup. The
schema manifest includes the new function. The isolated native fixture is
wired to apply the complete migration twice and test exact arrivals,
replacement stays, cancellation, both swap sides, authorization and input
bounds. Its real execution is still required. Source intake must first
confirm the migration version/name against the current canonical source;
the old GitHub reservation command was not used under the current policy.

Additional tests exercise two-engine delayed replies, stale deposits,
unknown proofs, engine retirement, partial-batch reflection and actual
startup-loop reentry. Existing continuity and departure tests remain in the
required catalog, with their fixtures updated for the stronger contract.
These additions have not run. Independent source review identified the
delayed-arrival and waiting-roster gaps during this change; both are included
in the repair and regression candidates.

Release requires fresh protected execution of the complete applicable
catalog, server and client type checks, native PostgreSQL checks, nested
loader/runtime composition and builds on the final integrated revision.
Migration admission/application, deployment identity, clean shutdown,
post-restart continuity and live client behavior remain separate obligations.
Prior commits' test results do not validate this candidate. The owner has
paused push/publication until further notice.
