# The pivot the page shows is the pivot the bank applies

2026-09-11. Branch `fix/bbj-the-rules-page-and-the-engine-agree`.

Every raked hand's jackpot drop is split three ways, and `fn_bbj_allocate`
reads that split from one authority: `ca_bbj_policy` row 1. Below the pivot a
drop is 50% main / 25% backup / 25% promo; at or above 100,000 in main it
becomes 25 / 25 / 50. Dan's ruling, 2026-08-18.

**That number is written down in four places and nothing checks that they
agree.**

| where                              | what it holds                                        |
| ---------------------------------- | ---------------------------------------------------- |
| `ca_bbj_policy`                    | the authority, read on every raked hand              |
| `server/src/config/RakeConfig.ts`  | `BBJ_PIVOT_THRESHOLD = 100000`, both splits          |
| `src/config/RakeConfig.ts`         | the same three constants, and no reader at all       |
| `src/pages/BadBeatJackpotPage.tsx` | bare `80000` and `100000`, in a player-facing banner |

Nothing has gone wrong, because nothing has changed. **It is about to matter.**

## The measurement that makes this urgent

| pool               | main      | main/day | reaches 80k | reaches 100k |
| ------------------ | --------- | -------- | ----------- | ------------ |
| Midway Union       | 52,376.70 | 3,614.80 | 7.6 days    | 13.2 days    |
| Deep Stack Society | 19,421.59 | 3,696.01 | 16.4 days   | 21.8 days    |

In about a week the platform's largest pool starts showing a banner built on a
literal. About a week after that, the allocation actually changes.

And `ca_bbj_policy` is a **table**. One `UPDATE` moves the real threshold with
no migration, no review and no failing test anywhere, after which the page
would go on counting toward a number the bank had stopped using.

An earlier audit already caught two of these literals out of step: the alert
fired at 50k while the progress bar measured against 100k. It was fixed by
typing a third literal.

## The fix, which is the same one this whole sweep has been applying

`fn_bbj_allocation_policy()` (migration `20260911220331`) publishes the rule
the allocator actually reads, and the page reads it.

- **Promo is derived as the remainder**, exactly as `fn_bbj_allocate` derives
  it, so this function cannot describe a split the allocator would not produce.
- **It proves itself against the allocator, not against the table.** The
  migration calls `fn_bbj_allocate(10000, ...)` on both sides of the threshold
  and aborts if the answer disagrees with what it publishes. A future change to
  the allocator that stops reading the policy is caught here rather than on a
  felt.
- **A function, not a grant.** `ca_bbj_policy` has RLS on, zero policies and no
  SELECT for `anon` or `authenticated`, which is exactly why a constant got
  mirrored into TypeScript in the first place. Opening the table would expose a
  writable-shaped surface for one read.
- **`jsonb`, not a `TABLE`.** An unscoped set-returning definer reachable from
  a browser is the shape `check-definer-authorization` refuses, and this one
  has no scope to take: it is one platform-wide rule.
- The allocation rule is not private. A club's own rake **rate** is, phase 3
  gated it, and it is not in here.

## What the banner says now

It used to read **"100K Pivot Alert"** over **"Pool At 82.3% Of Pivot
Threshold"**. That is internal vocabulary on a page any player can open, shaped
like a warning about their own jackpot, and it taught them nothing.

It now names the real threshold and says what happens at it: each hand starts
sending 25% of its jackpot drop to the pool instead of 50%, and 50% to club
promotions. The jackpot keeps growing, more slowly. Every percentage in that
sentence comes from the policy, never typed beside it.

**A rule that could not be read is not a rule of 100,000.** `getBbjAllocationPolicy`
returns null on a failed read, on an unparseable rule, or on a threshold of
zero, and the banner renders nothing rather than counting toward a number it
invented (CLAUDE.md 10.86). It is cached for the session rather than polled:
this is a rule, not a figure, and a timer here would be the
40,219-updates-a-day mistake in miniature.

## One stale comment corrected

`server/src/config/RakeConfig.ts` said the pivot split is "applied at banking
time in `logBBJCollection` against the LIVE main balance". `logBBJCollection`
does no arithmetic at all; it calls the `bbj_record_table_contribution` RPC and
the split is decided in SQL. Every reader of that comment was being sent to the
wrong file.

## Pinned

`tests/the-jackpot-is-one-allocator-with-an-opening-balance.law.test.ts`, LAW 6:
both configs carry the threshold and the split the policy row was **seeded
with** in its own migration, and both splits re-sum to the whole drop; the
banner reads `allocationPolicy.pivotThreshold` and contains neither `80000` nor
`100000`; an unreadable rule comes back as null rather than as numbers; and the
read is a definer no signed-out visitor holds.
