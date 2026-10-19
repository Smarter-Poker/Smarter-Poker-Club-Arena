# 2026-10-19 - A cash source call fits the engine's patience, and a halted page comes back in a minute

## What happened (read-only on production)

At 17:02 UTC one `fn_credit_agent_commissions_batch` call of five cash sources
ran 16.1 s:

| time       | item | outcome                                           |
| ---------- | ---- | ------------------------------------------------- |
| 17:02:19.6 | 1    | refused at once (`accounting_terms_not_observed`) |
| 17:02:27.7 | 2    | refused: lock timeout after 8 s                   |
| 17:02:35.7 | 3    | refused: lock timeout after 8 s                   |
| 17:02:35.7 | 4-5  | refused at once                                   |

Items 2 and 3 waited on a `profiles` row (the `agents` foreign-key check in
`fn_post_accounting_commission_source`). One transaction held it, and it also
held a `union_wallets` row from about 17:02:20 to 17:03:05. The same
transaction stalled 141 raked hands. The postgres log shows "still waiting for
ShareLock on transaction 1465374476".

Inside an item, every lock wait used the session's `lock_timeout`, which is
8 s for the engine's role. Nothing bounded the call as a whole, so any two
items behind one long holder ran past the engine's 15 s client budget. The
client gave up and the server committed anyway. The page halted. The cycle had
acknowledged no page before the halt, so the settler did not get its one
"retry after a productive cycle". It waited the full 30-minute interval. The
cursor stayed at 16:23:59, and the next settler activity was 17:29:59.

What did **not** cause it:

- **The 1 s commission-key budget.** The keys were free.
- **Page size or batch size.** The batch is 5 items, and one item settles in
  about 290 ms when it is not blocked.
- **A slow query.** Each wait was a row lock held by another transaction.

## The two root fixes

**Database (migration `20261019190103`, install needs Dan's approval):** this
changes `fn_credit_agent_commissions_batch` and
`fn_retry_cash_accounting_sources`.

- **Shorter lock wait per item.** Each item waits at most 2 s for any lock, and
  never longer than the session's own `lock_timeout`. A blocked item is
  refused durably exactly as before, only sooner.
- **A bound on the whole call.** No item starts after 8 s from the start of the
  call, and no lock wait reaches past that point.
- **Deferral when time runs out.** An item the call has no time for is
  deferred, the same way as an item whose commission keys are not held: no
  receipt and no attempt.
- **Lock timeout restored.** The session's `lock_timeout` is set back before
  the call returns.

8 s is inside `BATCH_BUDGET_FRACTION` (0.6) of the client's 15 s. The constant
`CASH_SOURCE_CALL_SERVER_BUDGET_MS` in `cashAccountingBatchBudget.ts` records
it, and the law test checks it against the migration text.

**Engine (`RakebackSettlerService`, normal :55 release):**

- **Every halt re-arms the catch-up.** The first halt is retried in 60 s.
  Each further halt in a row, with no acknowledged page in between, doubles the
  wait: 60 s, 120 s, 240 s, 480 s and 960 s, then the 30-minute interval. An
  acknowledged page, or an empty range, resets the backoff. One slow call now
  costs a minute instead of half an hour. A database that keeps failing still
  drops to one attempt per interval within six tries, so this never becomes a
  tight loop.
- **Only resubmissions that settle nothing count toward a halt.** A deferral
  resubmission now counts toward `CASH_DEFERRAL_RESUBMITS` only when it is one
  of a run of resubmissions that settled nothing. The database's
  out-of-time deferrals arrive with progress, so a chunk behind slow row locks
  clears over several calls. Only a run of calls that settle nothing holds the
  cursor.

## Is the 15 s / 30-minute design right?

- **The 15 s client budget is right.** It is the only bound the engine can
  enforce. The defect was that the database never sized its waiting to fit it.
  With the database fix, a call cannot outlast it.
- **The 30-minute wait after a first-page halt was wrong.** A halt never means
  the work is done. The interval stays as the regular floor and as the backoff
  cap.
- **The page size and batch size are already derived from measured cost.**
  `cashAccountingBatchSize` gives 5 items, which is about 1.45 s of work. The
  16 s was waiting, not work.

## Proof

**Native, using `scripts/qualification/chip-deadlocks.py` stage `budgeted`.**
The new `batch-items-behind-held-rows` case uses the engine role's 8 s
`lock_timeout` and a long transaction that holds three of five agents' rows.

| text                               | call time | result                          |
| ---------------------------------- | --------- | ------------------------------- |
| production text (`20261019171753`) | 24.03 s   | past the client's 15 s          |
| this migration                     | 6.03 s    | same outcomes (2 ok, 3 blocked) |
| this migration, all five rows held | 8.01 s    | 4 blocked, 1 deferred           |

- In the all-five case, the one deferred item settled on resubmission.
- In both runs of this migration, `lock_timeout` was back at `8s` afterwards.
- Every earlier case still passes, including the chip deadlocks, the busy-key
  pairs and the retry-queue starvation.
- `whole-file-run.json` covers `psql -f` of the whole file: the md5 values move
  from the pinned values to the postimages, the ACL is unchanged, and a replay
  is refused by the preimage guard.

The evidence is in `docs/evidence/settler-pacing-2026-10-19/`.

**Engine tests that fail before the fix**, in `server/src/services/rakebackWatermark.test.ts`:

- 7 tests in "the catch-up re-arms while backlog remains", covering the
  first-page halt, the backoff ladder, the reset and the cap;
- "keeps resubmitting while each call settles something".

All 8 failed against the previous settler and pass now.

## Deploy order

1. `20261019171753` (#7466), already approved.
2. `20261019190103`, which needs Dan's approval. Its preimage guard refuses it
   until step 1 is installed.
3. The engine change ships in the normal :55 release, independently. The
   engine already accepts both response shapes, so steps 2 and 3 may land in
   either order.

Law: `tests/a-cash-source-call-fits-the-engines-patience.law.test.ts`.
