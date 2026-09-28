# An Unknown Time Bank Debit Is Asked Again, By Its Own Id (2026-09-28)

## What happened

- 12:17:06Z: one engine `fn_consume_time_bank` call returned `supabase_timeout`. The engine set `timeBankAccountingUnconfirmed = true` on that table, and nothing ever set it back.
- 12:19:51Z: tournament `87a68e55` ("$100 Freeroll 6:00 AM", 335 players, 43 tables) lost its lease. Its manager's stop refused on table `9333d016` ("retained time-bank custody"). The manager was quarantined and retried 80+ times, and the event dealt nothing.
- 14:49Z-16:18Z: migration 20260928144831 (PR #5527) was applied from an unmerged branch and created a second overload of `fn_consume_time_bank`. Every engine debit then failed with PGRST203, and each failure set the same permanent flag. `/health` showed `accounting_unconfirmed` 55, then 37. The restart gate stayed shut, and about 60 decided heads-up events could not finish. #5533 dropped the stale overload at 16:18Z.

## Root cause

The engine treated any lost or failed debit answer as unknowable forever, because the debit had no key and asking again risked a double charge.

## Fix

- **Database:** `20260928144831_time_bank_consume_is_idempotent_by_request_id.sql` (from PR #5527, already applied in production and carried here byte for byte; its function md5 `6adbdcd86c910c09e56b4f10193d2e55` equals production) gives `fn_consume_time_bank` a `p_request_id`.
  - A repeated id is answered from `public.time_bank_consume_receipts`, checked again under the per-user lock.
  - #5533 already removed the old two-argument overload.
- **Engine:**
  - Every debit sends a fresh request id.
  - A debit whose answer was lost keeps its id in `unresolvedTimeBankDebits`.
  - `resolveUnconfirmedTimeBankDebits()` asks again with that same id, one resolution at a time, from the restart gate census (`maintenanceDurabilityReason`) and from the manager stop (`persistStoppedTimeBankCustody`, before it decides whether the custody can be written).
  - Any well-formed reply is an answer:
    - `success: true` means applied, or a replayed receipt.
    - `success: false` means refused (unknown user, non-positive amount); nothing was charged and nothing ever will be.
  - The flag clears only when every kept debit is answered. A flag with no kept debit is never cleared.
  - No timers, sweeps or crons.
- **Compared with #5527's engine change:** #5527 retries once, immediately, and then falls back to the permanent flag. During a sustained database slowdown both attempts time out, which is the case that froze 87a68e55. Here the id is kept and asked about again at every census and stop until the database answers.

## Proof

Applying the migration file to a local PostgreSQL copy of production's original `fn_consume_time_bank` (prosrc md5 `7832bfb7...`) produces the production function md5 `6adbdcd8...`. The same run reproduces the two-overload state that #5533 fixed.

## Deploy

Merge, then the engine release. The migration is already recorded in production. The running process (763e4cec) cannot clear flags it already holds; only its replacement can.

## Tests

- `server/src/engine/anUnknownTimeBankDebitIsAskedAgain.law.test.ts`
- The existing time bank tests now expect `p_request_id`, and `ParkedTimeBank.test.ts` pins that any re-ask names the same id.
