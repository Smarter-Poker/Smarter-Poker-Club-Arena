# A Database That Asks To Be Retried Is Retried

**2026-09-12** · `isTransientDbError`, `postHandTasks`

## 412 Hands In Two Hours With No Record

`postHandTasks` writes the record of a hand that has already been played. In the
two hours to 11:00 on 2026-09-12 it failed 412 times, every one of them
identical:

```
atomic hand commit refused (atomic_hand_rolled_back): F06_RETRY_CANONICAL_LANE
attempts: 1      retry_budget: 0
```

| Hour            | `hand_history_failed` |
| --------------- | --------------------- |
| 05:00           | 3                     |
| 08:00           | 1                     |
| 10:00           | **240**               |
| 11:00 (partial) | **172**               |

820 unresolved critical financial alerts carry that sentinel. The hands were
dealt and settled. Only their records were lost.

## The Database Was Asking For Exactly One Thing

That error has a single origin, and it spells out the remedy in the raise:

```sql
-- smarter_private.f06_try_lane
IF t IS NOT NULL AND (NOT pg_try_advisory_xact_lock_shared(
     hashtextextended('ca:tournament-terminal-settlement:v1', 0)) ...
  RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE = '40001';
```

`40001` is `serialization_failure`, the one error Postgres itself defines as
"this conflicted, run it again". The lock is taken before any work, so nothing
has been written when it fires, and the caller is told
`atomic_hand_rolled_back`. A retry re-runs a transaction that committed nothing.

It fires when a tournament terminal settlement holds the canonical lane, which
is why it went from 3 an hour to 240 an hour as tournament churn rose.

## Both Gates Were Shut

**`isTransientDbError`** asks, in its own title, _"Did the database blink, as
opposed to the code being wrong?"_ Every entry in it was a **transport** failure:
`ECONNRESET`, `fetch failed`, `socket hang up`, `ETIMEDOUT`. A serialization
failure was not among them, so the textbook case of the database blinking was
answered "the code is wrong".

**`STEP_RETRY`** gave `hand_history` no budget at all:

```ts
const STEP_RETRY: Record<string, number> = { leave_pending: 2 };
```

so `attempts > budget` was true on the very first throw. Even a recognised blink
would have been terminal.

Two gates, both shut, and the alert that fired named the second one in its own
payload: `retry_budget: 0`.

## The Change

`isTransientDbError` now recognises a serialization failure: the
`F06_RETRY_CANONICAL_LANE` sentinel by name, SQLSTATE `40001` exactly, and the
`could not serialize access` / `deadlock detected` wordings a driver may hand
back instead of a code.

`hand_history` gets the same budget the seats lane already has, two attempts,
under the existing 250ms + 1s backoff. The felt already holds 2.1 to 3.5 seconds
between hands, so the cost is invisible and the retry stays inside one hand
boundary.

## What This Deliberately Does Not Do

It does not make every refusal retryable. The rule written over that retry loop
still holds:

> Every refusal the database gives on purpose is a decision, not a queue.

A unique-constraint violation, a missing column, an RLS refusal and a type error
are all still terminal, and a near-miss code like `400010` is not read as
`40001`. Those are pinned, so widening this list again has to get past them.

## Pins

`server/src/engine/aDatabaseThatAsksToBeRetriedIsRetried.law.test.ts`, eight
cases.

Proven to bite: reverting both files fails the four new behaviours and leaves the
four guards passing, which is the profile that matters. The guards are the point
as much as the fix.

All 4,606 engine tests pass.
