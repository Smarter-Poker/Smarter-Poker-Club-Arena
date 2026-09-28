# An Unknown Time Bank Debit Is Asked Again, By Its Own Id (2026-09-28)

## What happened

- 12:17:06Z: one `fn_consume_time_bank` call from the engine returned `supabase_timeout` during a database slowdown.
- The engine could not tell whether the debit had committed, and could not ask again, because the debit had no key and a second call could charge the player twice. It set `timeBankAccountingUnconfirmed = true` on the table, and nothing in the engine ever set it back.
- 12:19:51Z: tournament `87a68e55` ("$100 Freeroll 6:00 AM", 335 players on 43 tables) lost its lease. Its manager's stop refused on table `9333d016` with "retained time-bank custody", because a stopped engine never writes its time bank custody while a debit is unconfirmed. The manager was quarantined and retried every minute (80+ times). The event dealt nothing from 12:19Z.
- `/health` `maintenance.unparkedReasons` read `stopped_bank_custody_unreadable: 1`, then `accounting_unconfirmed: 55`. The restart gate was shut for three consecutive breaks, so no engine release, including one carrying a fix, could land.

## Root cause

`ServerTableEngineBase.onTimeBankAccounting` and `consumeTimeBankSeconds` sent an unkeyed, non-idempotent debit. On any failed or lost answer they set a flag whose only clearing path was a new process.

## Fix

- **Database** (`20260928152513_a_time_bank_debit_carries_its_own_id_and_a_receipt.sql`):
  - New `fn_consume_time_bank_once(user, seconds, debit_id)`. It takes the same per-user advisory lock as the debit, then returns the stored receipt if that id has already committed.
  - Otherwise it runs the unchanged `fn_consume_time_bank` and records the receipt in `smarter_private.time_bank_debit_receipts`, in the same transaction.
  - It is engine-only, and the receipts are append-only. `fn_consume_time_bank` is guarded on its production pre-image and is not redefined.
- **Engine**:
  - Every debit gets a fresh id.
  - A lost answer keeps its id in `unresolvedTimeBankDebits`.
  - `resolveUnconfirmedTimeBankDebits()` asks again with the same id, one resolution at a time. The flag clears only once every kept debit has a definite answer.
  - It is asked from the two places the answer matters: the restart gate census (`maintenanceDurabilityReason`) and the manager's stop (`persistStoppedTimeBankCustody`, before it decides whether the custody can be written).
  - No timer, sweep or cron. This is the live debit completing from its own record.

## Proof

The migration was applied to a local PostgreSQL 16 copy of production's `fn_consume_time_bank` (prosrc md5 `7832bfb717daaeb625372bdd3ccc7d60`, same owner/ACL/config). Results:

| Case | Result |
|---|---|
| First call | Applied, `replayed:false` |
| Same id again | `replayed:true`, usage unchanged (20) |
| Original rolled back | No receipt left; the re-ask applied once (usage 40) |
| Re-ask while the original was still in flight | Waited 2.0 s for the lock, then returned the original's receipt; charged once (40 to 60) |
| Id reused with a different amount | Refused |
| Non-engine caller | Refused |
| Receipt DELETE | Refused |
| Unknown user | Answered as a receipted refusal |
| Migration re-applied | Refused by the pre-image guard |

## Rollout order

Apply the migration first (`apply-merged-migration.yml`), then release the engine, because the engine calls the new function.

The process running at the time (763e4cec) cannot clear its stuck flag without being replaced, and its restart gate is shut by that same flag.

## Tests

- `server/src/engine/anUnknownTimeBankDebitIsAskedAgain.law.test.ts`
- `tests/a-time-bank-debit-carries-its-own-id.law.test.ts`
- Existing time bank tests now expect `fn_consume_time_bank_once` with a debit id.
