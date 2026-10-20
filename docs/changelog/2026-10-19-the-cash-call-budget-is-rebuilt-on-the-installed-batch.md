# 2026-10-19 - The cash call budget is rebuilt on the installed batch

## What happened

#7485 merged migration `20261019190103`. It bounds each cash source call's
lock waits: 2 s per item, 8 s per call, with deferral, and the session's
`lock_timeout` is restored afterwards.

At 21:44 UTC the applier refused that migration (run 39329770170). Nothing was
committed. The error was:

```
fn_credit_agent_commissions_batch(jsonb) is not the pinned text (md5 9befae963f3b9cda25b357f60a9b53d7)
```

`20261019190103` pinned `20261019171753`'s batch text (`1ae9eb0e`). In the
meantime another task's `20261019194410` had been installed and had replaced
that text. `20261019194410` adds a key for every player whose `player_stats`
rows an item writes, taken in player order after the club keys. It did not
touch `fn_retry_cash_accounting_sources`; its header says "NOT CHANGED".

Production, read at 21:46 UTC:

| function                            | `pg_get_functiondef` md5 | `prosrc` md5 | installed by     |
| ----------------------------------- | ------------------------ | ------------ | ---------------- |
| `fn_credit_agent_commissions_batch` | `9befae96`               | `c99362ad`   | `20261019194410` |
| `fn_retry_cash_accounting_sources`  | `779590b6`               | `35e2337d`   | `20261019171753` |

## What changed

`20261019214727` keeps the same slug and replaces the never-installed
`20261019190103`, whose file is removed. This follows the precedent of
`20261019194410` replacing `20261019155432`.

- **Batch.** The new body is `20261019194410`'s text with the same budget
  edits applied. Its player key walk, shared 1 s key budget and player-key
  deferral are kept byte for byte. The migration refuses to proceed if that
  walk is missing from the installed result.
- **Retry.** The body is `20261019171753`'s text with the budget, as in #7485.
- **Either install order.** The batch accepts either installed text:
  - `20261019194410`'s `9befae96` becomes the combined body `1c9d9ff9`;
  - `20261019171753`'s `1ae9eb0e` becomes the budget-only body `6c9a3885`.

  Exactly one accepted preimage per function must be installed. Anything else
  is refused and nothing changes.

- **No table is created.** The substitution rows travel as `jsonb`.

The engine half of #7485 was already merged. Its source comments still name
`20261019190103`. They are left alone so this change does not trigger an engine
release.

## Proof (native PostgreSQL 17.11)

**`scripts/qualification/chip-deadlocks.py`.** It has a new stage, `keyed`,
which installs `20261019194410`'s batch. That is production's text. The
`budgeted` stage then applies this migration's `$subs$` block on top of it.

Every earlier stage still passes:

- the chip deadlocks;
- the busy-key pair;
- the retry-queue starvation;
- `batch-while-a-finish-holds-a-key`.

The new and changed cases:

| case                | production text (`keyed`) | this migration (`budgeted`)                         |
| ------------------- | ------------------------- | --------------------------------------------------- |
| held rows           | over 15 s                 | 6.04 s, same outcomes, `lock_timeout` back at 8 s   |
| out of budget       | -                         | 8 s, then the deferred item settles on resubmission |
| retry backlog drain | -                         | 400 of 400 accrued, once each                       |

The rolled-back probe on `20261019171753`'s text lands on `6c9a3885`.

**Whole file (`psql -f`).** On the `keyed` cluster:

- the batch moves `9befae96` -> `1c9d9ff9`;
- the retry moves `779590b6` -> `df10ba64`;
- the ACL and settings are unchanged;
- a replay is refused by the preimage guard.

**`20261019194410`'s own harness.** `replay-locks-and-player-stats-keys.py`
gets a third state that installs this migration's batch row on top of
`20261019194410`. All 16 checks pass:

- the 11 original checks;
- the three batch-versus-projection deadlocks, which stay fixed with every
  value written once;
- a held player key still defers the batch;
- the replay is unchanged.

That cluster has no retry function, so the retry row is qualified only by
`chip-deadlocks.py`.

The evidence is in `docs/evidence/settler-pacing-2026-10-19/`.

## Deploy order

1. Install `20261019214727`. It runs after `20261019194410`, which is already
   installed.
2. The engine half of #7485 ships at the normal :55 release. It is independent
   of step 1.
