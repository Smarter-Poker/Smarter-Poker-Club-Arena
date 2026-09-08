# Phase 5 status, and two open defects the verification found

2026-09-08, after the Phase 5 migrations landed. No code here - this is the
record, and the two things the next agent should pick up first.

## Where Phase 5 stands, measured

| Item                                                       | State                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 arena club, `is_platform`, one-platform-club index     | **Done**, `20260908114501`                                                                                                                      |
| 5.2 deposit / withdraw doors                               | Done earlier (foundation), now live: `ca_arena_settings.club_id` is set                                                                         |
| 5.3 reporting learns `asset`                               | **Done**, `20260908114517`                                                                                                                      |
| 5.4 horses may enter the arena                             | **Done**, `20260908114533`                                                                                                                      |
| 5.4 rake to the house, guarantees from the house, BBJ pool | **Not started, deliberately** - no diamond table exists to probe a diamond branch against, and the pool is gated by the roadmap on chip 4.2/4.3 |
| 5.5 World Hub arena pages                                  | Fabricated data removed (World Hub `fix/the-arena-pages-stop-inventing-players`); routing into the SPA still open                               |
| 5.6 trivia payout engine                                   | Not started                                                                                                                                     |

Verified on production after the three migrations: diamond trial balance
difference `0.00` on every account, suspense `0`, mirror mismatch `0`,
`players + arena = register` exactly, zero open critical incidents, zero
unreachable money paths, arena club holding zero, horses admitted, and zero
diamond tables open.

**The entry condition for opening a diamond table is unchanged and NOT met**:
seven consecutive days of the diamond trial balance at zero on every account,
suspense zero, no open critical incident. Day one is today.

## Open defect 1: one budget row is a platform-wide serialisation point

`fn_ca_diamond_earn_ledger` records every award with

```sql
INSERT INTO public.diamond_reward_budgets (period, engine, ...) ...
ON CONFLICT ... SET spent_diamonds = diamond_reward_budgets.spent_diamonds + EXCLUDED.spent_diamonds
```

so **every daily-challenge claim on the platform updates the same single row**
(`2026-09`, `daily_challenges`), and the row lock is held until the caller
commits. That is the identical shape as the register's advisory lock fixed in
`20260908060643`, and it broke in the identical way at the identical moment:

- **5,835 `DR7:ledger_write_failed` incidents, `canceling statement due to lock
timeout`, first at 05:37:01** - the same second the register began failing -
  plus **21 deadlocks**. Two more in the last three hours, so it is rare now
  that the claim backlog has drained, and it is not gone.
- When the write fails the award still happens and the incident is filed, so
  **`spent_diamonds` understates real spending by those 5,835 awards.**

**Why this matters before 2026-09-14.** `DR7:engine_over_budget` flips from
`log` to `refuse` that day. It will then refuse awards based on a
`spent_diamonds` figure that is known to be short. Refusing on a wrong number is
worse than not refusing at all.

**The fix, same lesson as the register**: a running total maintained on a path
that runs thousands of times an hour serialises the platform behind one row.
Make the spend append-only - one INSERT per award into a
`diamond_budget_spend(period, engine, amount, at)` table with `spent_diamonds`
derived by SUM - so the hot path takes no contended lock. Then re-derive the
current figures from the journal before the flip, because today's counters are
short. It is not a retry and not a sweep: those are band-aids under 10.12.

## Open defect 2: the merged-branch guard reads HEAD, not the push destination

`scripts/guard-merged-branch.sh` (Club Arena and World Hub both) decides which
branch you are pushing with

```sh
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
```

A pre-push hook is told the real destination on stdin
(`<local ref> <local sha> <remote ref> <remote sha>`). Pushing a NEW branch by
explicit refspec while the checkout happens to sit on an already-merged branch
is a correct push - it is literally the recovery the guard's own message
recommends - and the guard refuses it, naming the wrong branch and the wrong
pull request. It happened on 2026-09-08 pushing the World Hub arena-pages fix,
and the only way through was `AGENT_MERGED_BRANCH_OK=1`, which is documented as
meaning "I really do mean to move a merged branch" - which was not true.

**A guard that refuses correct work teaches everyone to set its override**, and
then it is not a guard.

**Why it was not fixed on the spot.** The obvious fix - read stdin - is unsafe
without restructuring: Club Arena's `.husky/pre-push` calls the guard at line 34
and then consumes the same stdin itself at line 77
(`while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA`). A guard that reads
stdin first would silently starve that loop, disabling whatever it checks
without any symptom - trading a rare false refusal for a permanent silent gap.
The correct change is to read the refspec ONCE at the top of the hook and pass
the destination branches to the guard as arguments, in both repos, with the
World Hub hook (which has no stdin consumer) done the same way so the two do not
drift. That is a deliberate change to the one script standing between every
agent and a lost push, and it deserves its own pass.

## Two numbers for Dan, not for an agent

Budgets for a future period are his (10.9). Both of these are stated, not
changed:

1. **`club_arena_daily` for `2026-10` is set to 9,223,372,036,854,775,807** -
   bigint max, an infinite budget waiting for October. Every other engine
   carries its September figure forward unchanged (catalog_v2 50,000,
   daily_missions 30,000, memory_game 2,000, referrals 5,000); this one is an
   outlier and reads as a sentinel rather than a decision. September's figure is
   10,000.
2. **`daily_missions` for `2026-09` has spent 74,505 against a budget of
   30,000** - two and a half times over, today, because the budget rule is in
   `log` mode and refuses nothing. Related: `daily_challenges` drops from
   12,000,000 in September to 100,000 in October.
