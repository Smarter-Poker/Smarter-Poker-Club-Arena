# The time bank debit has one door, not two overloads (2026-09-28)

## What players saw

From about 15:00Z SNG heads-up and Spin winners stopped being paid. The event
reached one player, the table went quiet, and the tournament stayed RUNNING.
At 15:36Z 50 such events were waiting (15 minutes or more since their last
bust, one player `playing`, no terminal receipt), growing with every lease
loss.

## The chain, read from the engine log and the catalog

1. **14:49:15Z** - the first
   `[TimeBank] consume unconfirmed: Could not choose the best candidate function between: public.fn_consume_time_bank(p_user_id => uuid, p_seconds => integer), public.fn_consume_time_bank(p_user_id => uuid, p_seconds => integer, p_request_id => uuid)`.
   Migration `20260928144831_time_bank_consume_is_idempotent_by_request_id`
   (PR #5527, unmerged) had been applied to production minutes earlier. It
   added `p_request_id uuid DEFAULT NULL` with `CREATE OR REPLACE`, which in
   Postgres creates a second function when the argument list changes. The
   engine calls the door by name with `{ p_user_id, p_seconds }`; both
   overloads accept that, so PostgREST refused all of them (PGRST203). 400 in
   the next 50 minutes.
2. Each refusal set `timeBankAccountingUnconfirmed` on its table engine
   (`ServerTableEngineBase.onTimeBankAccounting` / `consumeTimeBankSeconds`).
   Nothing ever clears it, so `hasUnretiredStoppedTimeBankCustody()` is true
   for that table for the life of the process.
3. When the tournament lease of such an event lapsed (the recurring proof
   storm, e.g. 15:31:59Z), `TournamentManagerBase.stop()` failed
   `Tournament table <id> retained time-bank custody` (1,808 in 90 minutes,
   the only stop-failure cause in the window), the F06 custody transfer was
   refused `physical_identity_unreadable`, and the manager was quarantined
   (167 on `/health` at 15:40Z).
4. A quarantined manager is fenced and never sweeps again, but it still holds
   the `tournamentEngines` slot, so both decided-event sweeps
   (`GameServer` "is decided ... recovering the winner" and
   `finishSeatFirstGamesThatAreOver`) only re-woke it. `FINALIZING` never
   ran. Of 20 stuck events traced, 17 had exactly this shape (time bank used
   after 14:49 on their table, lease lost, quarantined, zero `FINALIZING`).
5. The same taint holds the restart certificate shut
   (`accounting_unconfirmed: 55`; the 14:55Z break ended with 56 unparked and
   no certificate), so no engine release can cut over while it lasts.

## The database door is not the problem

A rolled-back probe (one MCP call, one `DO` block ending in `RAISE
EXCEPTION`) of `fn_complete_tournament_terminal('1fa6d32a-...', <survivor>,
'places')` returned `ok: true, status: COMPLETED, winner_amount: 47.50`, closed
the table and released the seat. The door accepts; nothing was asking it.

## The fix in this change

`20260928154352_the_time_bank_debit_has_one_door_not_two_overloads.sql` drops
`fn_consume_time_bank(uuid, integer)`, guarded on the exact pre-image of both
overloads (body md5, owner, grants, config, and the three-argument door's
`p_request_id uuid DEFAULT NULL::uuid`). With `p_request_id` NULL the
three-argument body is the two-argument body (both receipt branches are
`IF p_request_id IS NOT NULL`), so the running engine's call resolves again to
exactly its old behaviour, and PR #5527's engine keeps its door. On a replay
where the three-argument door does not exist the migration changes nothing.

`tests/a-door-the-engine-calls-by-name-has-one-overload.law.test.ts` pins it,
and from this migration forward refuses any migration that changes a
function's argument list without dropping the signature it replaced.

## What this does not fix

- Tables already tainted stay tainted in the running process; their managers
  stay quarantined and their decided events stay unpaid until the engine is
  replaced. Resolving an unknown debit by its own id is PR #5527 / #5530's
  engine change. Replacing the process needs a restart the certificate will
  not grant while the taint exists; that is an operator decision.
- The stuck events cannot be settled by one migration: the finish lane
  refuses a second tournament in one transaction
  (`fn_ca_lock_settlement_lane_for_finish`: "a transaction never holds two
  tournaments' lanes"), and a migration is one transaction.
- PR #5530's migration `20260928152513` guards on
  `'public.fn_consume_time_bank(uuid,integer)'::regprocedure`; after this
  drop it must read the three-argument door instead.
