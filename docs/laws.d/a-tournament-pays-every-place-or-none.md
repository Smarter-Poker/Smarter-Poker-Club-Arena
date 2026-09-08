# tests/a-tournament-pays-every-place-or-none.law.test.ts

A normal structure-prize tournament may move from `COMPLETING` to `COMPLETED`
only through one exact, fully paid place batch. Preparation first commits one
immutable header and the complete `tournament_obligations` set, fingerprinted
from ordered place, player and integer-cent entitlement; preparation moves no
chips and that committed set is the restart record. Once the batch exists, a
database trigger freezes every place-obligation insert, update and delete;
only the atomic settler may open its transaction-local gate to advance payment
fields. Settlement revalidates the header and result rows, pays every obligation
inside one database subtransaction, re-reads `amount_paid` after every child
call, and changes the tournament status in that same subtransaction. Any
refusal, partial payment, error, deadlock or lost claim rolls back every new
place credit and the terminal write. A replay uses the same plan and is
idempotent; it may report success only with explicit completion proof.

Preparation refuses recognized legacy payout evidence credited to the wrong
player or to a place outside the frozen structure. It nets reversals within the
same place and player group, but a non-zero remainder is a conflict, not
permission to pay the pool again. The reverse direction is enforced too: a
positive `tournament_players.prize` row that has no exact place and player in
the plan blocks preparation, settlement and the terminal completion trigger.

The database trigger is the final gate, so a browser, legacy writer or future
engine path cannot bypass the batch. Browser roles can neither call the two
settlement functions nor read or mutate the batch table, and the legacy client
finalizer fails closed. A place plan is accepted only after the prize pool is
finalized and is not below its advertised guarantee. Live finish and recovery
both run the canonical guarantee transaction, re-read the authoritative row,
prove finalization and the guarantee floor, and only then price or settle the
field. The live path reprices every eliminated paid-place standing from that
funded pool, including rows whose earlier prize was zero. Add-on closure cannot
pre-stamp `prize_pool_finalized`; the guarantee transaction owns that flag and
repricing follows only after it succeeds. Satellites and final-table deals
retain their distinct settlement contracts and are explicitly excluded. Bubble
Protection funding and pricing policy are not decided by this law. When an exact,
already-funded Bubble obligation exists, its unpaid cents participate in the same
atomic batch; insufficient escrow leaves the normal plan `COMPLETING`.

No repair worker is part of the guarantee. Normal finish and stuck-completion
recovery both call the same atomic helper, never settle individual places and
never invoke the reconciler. The applying in-process payout sweep is absent,
the legacy function raises on `p_apply=true` before every table read or write,
neither legacy function is executable by application roles, their direct
settlement source aliases are removed, every applying cron command is refused,
and the migration retires `ca-payout-sweep-hourly` from both pg_cron and the
expected-job roster instead of replacing it with another retry, sweep,
reconciler or backfill.
