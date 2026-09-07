# One check red on every branch is a different signal

**2026-09-07** — branch `fix/one-check-red-on-every-branch-is-a-different-signal`

This closes the gap my own changelog for this morning's outage named and left
open: _"What nobody had was a reader who notices that the same check is red on
every branch at once, which is a different and much louder signal than one
branch failing."_

## What it is for

Twelve consecutive `CI - Build & Type Safety` runs failed for hours, every one
a different agent on an unrelated branch. One missing index on a brand-new
table (`bbj_drill_arms.club_id`) turned `Supabase Invariants - A Club Stays
Deletable` red across the whole estate.

Every part of that worked as designed. The gate was right, it printed the
offending column in its own output, and it failed loudly on each pull request.
The thing that was missing is that **nothing looks across pull requests** — so
each agent saw one red check on their own branch, read it as their own problem,
and went hunting in their own diff.

`check-main-is-green.mjs` next door cannot see it either. The failure never
touched `main`: it lived in production database state that the pull-request
checks read, so `main` was green the entire time nothing could land.

## The discriminator is concentration, not count

The obvious detector — "N branches share a failing step" — would page
constantly. Measured against the live repository the same day:

| window | fresh PRs | with any failure | most-shared real step |
| ------ | --------- | ---------------- | --------------------- |
| 3h     | 20        | 17               | 5 PRs (**29%**)       |

Open branches rot independently, and five sharing a step name is an ordinary
Tuesday. During the incident the same step was red on **12 of 12**: 100%.

So the alarm is a **share of the failing pull requests**, floored by a count:

- at least **4** distinct pull requests, so a two-branch repository cannot trip
  it at 100%; and
- at least **60%** of the fresh pull requests that have any failure.

29% against 100% is the separation those two numbers were chosen from. An alarm
that is always on is an alarm that gets muted (10.84).

## Two things it deliberately drops

**Stale branches.** A pull request nobody has touched in three days is failing
for its own reasons and has been for three days. Including them buries the
signal under a permanent floor of rot. Only pull requests updated inside the
window (6h) count.

**Summary steps.** `Fail if a suite that ran did not pass` appeared on 25 of 36
open pull requests and `Every shard passed` on 9. Neither names a cause — they
exist to turn another job's result into a failing status. Grouping on them
would report 100% concentration every day of the week.

## Three outcomes, and the one the test caught

```
0  no failure is estate-wide
1  one failing check spans the estate - nobody can merge
2  COULD NOT TELL - no token, an unreadable answer, or the request budget
   ran out before the window was fully read
```

`res.ok` before the body, three attempts before an unreadable answer is
believed, and a partial read is never reported as a clean one.

**Writing the cases found a real instance of exactly that coercion in this
file.** `hoursSinceNewest([null])` returned 496,878 rather than `null`, because
`new Date(null).getTime()` is **0**, not `NaN` — a missing timestamp parses as
1970 and reads as a real, very old date. A pull request with no `updated_at`
would have been silently excluded for being stale rather than reported as
unknown. Only a non-empty string is a timestamp now.

## Cost, because a watchdog that eats the rate limit is a defect

A `GITHUB_TOKEN` gets 1,000 REST requests per hour per repository, shared with
every other job. This scans **fresh** pull requests only, one call each plus one
per failing workflow run: **39 calls** on the live repository today, against a
budget of 120. Over the budget it exits 2 rather than judging a window it only
partly read.

## Verified against the live repository, not only in the cases

```
33 open pull request(s); 18 updated inside 6h.
18 of 18 fresh pull request(s) have a failing check; 14 distinct failing step(s).
    5 PR(s)   28%  TypeScript Check / Invariant guards (parallel)
    4 PR(s)   22%  CSS Beat E2E / Run the beats against this commit's CSS
    4 PR(s)   22%  Server Engine (typecheck + tests) / Full server test suite
OK - no single check accounts for 60% or more of the 18 failing pull request(s).
```

Exit 0, correctly: this is rot, not a blockage. The same run during the
incident would have reported 100% on one named invariant.

## Its reader

The `open_prs_are_green` job in `publish-watchdog.yml`, on `ubuntu-latest` so
the alarm never shares a failure domain with the boxes it watches. It raises
ONE issue naming the offending check and closes it again when branches are red
for their own reasons. A red run there is also picked up by
`check-main-is-green.mjs` in the same workflow.

It reports and never gates. The branches are already blocked; a thirteenth red
check would help nobody.

## What this is not

It is a detector, and 10.11 says a detector is not a fix. It cannot stop a
missing index from being shipped — the gate that catches that already exists
and already worked. What was missing was anybody being told that the estate,
rather than a branch, had stopped. That gap is closed.

## Files

- `scripts/ci/check-open-prs-are-green.mjs` (new)
- `tests/every-branch-red-at-once.test.ts` (new, 21 cases)
- `.github/workflows/publish-watchdog.yml` — the `open_prs_are_green` job
