# The Post-Deploy Run That Could Not Report A Verdict

**Date:** 2026-08-31 · **Phase:** 6 of 8 · **PR:** #2184

## What was claimed

`post-deploy-e2e.yml` was built on 2026-08-29 to end a specific failure: sixteen
spec files that ran in no CI job at all. Its own header states the principle it
was written against, and states it well:

> "nowhere to run" is how a guard becomes a comment.

It succeeded at giving the specs a job. It did not close the next door.

## What was true

A run could report success having verified nothing, four different ways, and all
four were live on `main` when this phase opened.

### 1. Nothing counted skips

Playwright exits 0 when every test skips. This suite is full of specs that skip
themselves - on `/auth` when signed out, or when no live tournament exists. So
"the job was green" and "production was checked" were unrelated statements, and
nothing in the pipeline could tell them apart.

### 2. The signed-out fallback was silent by design

`tests/e2e/global-setup.ts` falls back to a signed-out session when a login
fails, and says so plainly in its own header: the cost is 47 skips. That trade
is right for a merge gate. It is wrong for this job, whose entire purpose is to
look at production **with a real session**. A login blip here produced a green
run in which the auth-gated majority of the suite reported nothing.

### 3. One red step hid the whole sweep

The Cashier step carries this comment:

> "Keep the release-critical Cashier result independent from the broader
> production sweep. A failure on Stats or another route must not obscure whether
> the money surface itself passed or failed."

It delivered that independence in one direction only. Because the sweep step had
no `always()`, a failed Cashier step **skipped it entirely**. Run `33394046555`:
Cashier failed, and thirteen spec files plus all of `tests/e2e/routes` never ran.

This is the third time in this eight-phase effort that the real defect was a
**gate documenting a promise it did not enforce** - after the title-case gate
that claimed expression values were "cased at their source" while nothing checked
the source, and the definer gate that printed "Never from a parameter" while
clearing a function that took its actor from a parameter.

### 4. And once more, one level down

Inside the sweep step, `set -e` meant a red Stats invocation aborted the route
invocation behind it. Same fault, smaller blast radius, equally invisible.

## The failure that was not a failure

Runs `33394046555` and `33394398578` failed on `[data-cashier-recovery="true"]`
not found. Nothing was broken.

The element was on `main` - `src/pages/CashierTradePage.tsx:2162`, merged in
#2165 at 12:43 - and the spec asserting it was in the checkout. Production was
still serving a bundle from before it. Ten minutes later the same spec passed,
unchanged, against a production that had caught up.

The cause is structural, and it comes from an earlier correct decision. The
workflow used to wait for production to serve its own commit's sha, spent every
run in that wait, and was cancelled by the next one - a job that always cancels
is a job that never runs. So it stopped pinning to a sha and began testing
"whatever is serving when it starts". The reasoning is sound and is preserved.

But the **checkout was never brought along**. The run tested the bundle players
had, using the assertions from a newer commit. Every commit that adds a spec
alongside the feature it asserts produces a red run until production catches up,
and that red is indistinguishable from a real defect.

A guard whose reds are routinely false is a guard people learn to ignore. That
is the same death as having nowhere to run, arrived at from the other side.

## What changed

| Fault                       | Fix                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skips uncounted             | `scripts/ci/assert-e2e-actually-ran.mjs` reads Playwright's JSON and fails the run when a spec **file** executed nothing, naming the file and the recorded skip reason |
| Silent signed-out fallback  | `E2E_REQUIRE_AUTH=1` makes it throw, with its real cause. Unset everywhere else, so no other consumer changes                                                          |
| Cashier red hid the sweep   | `if: always() && steps.live.outputs.ready == 'true'`                                                                                                                   |
| `set -e` hid the routes     | Both invocations run; either failing still fails the step                                                                                                              |
| Specs newer than the bundle | Assertions taken from the commit production is serving, when it is an ancestor; loud drift report when it is not                                                       |

**Per file, not a ratio.** "88% executed" is the same number whether twelve files
each skipped one variant or one money surface skipped end to end. The second is
the one that matters, and only a per-file rule can name it.

**The exemption list is a ratchet.** `scripts/ci/e2e-may-skip-entirely.json` lets
a file be exempt from "must execute something" only with a stated reason, and the
law test caps how many exemptions may exist. It ships empty.

**The harness does not travel with the specs.** Taking `tests/e2e` wholesale from
the deployed commit would also take `global-setup.ts` back to before
`E2E_REQUIRE_AUTH` existed - restoring the signed-out fallback on exactly the
runs where production is behind. A fix that disables itself under the condition
it was written for is worse than no fix. `global-setup.ts` and `support/` stay at
`HEAD`; only the assertions move.

## What the guard found once it could speak

The first run of the fixed workflow (`33398218482`, this branch, 2026-08-31
13:43-13:52 UTC) reported, for the first time in this workflow's history, a
verdict with its working shown:

```
| Executed | Skipped | Failed | Flaky | Spec files |
|      148 |       4 |      3 |     1 |         23 |
```

Every one of the 23 spec files executed at least one test, so
`e2e-may-skip-entirely.json` ships **empty** - the honesty check passed, on
evidence, rather than on an allowance. `routes/hamburger-menu.spec.ts` alone
executed 33 tests against production, which is Phase 1 and Phase 2's work being
verified on the live site for the first time.

The drift path was exercised too, and correctly. This branch is not an ancestor
of what production serves, so the workflow refused to swap the specs and said so:

```
::warning::deployed sha 09bd8409… is NOT an ancestor of 701c729a… -
specs left at 701c729a… and may not match the bundle.
```

That is the behaviour that matters: it did not guess.

## The failures are real, and they are not this repo's specs

Two specs failed, both reproducibly, and both on `main`'s run
(`33395347273`) before any of this work existed:

- `smoke.spec.ts:88 - No console errors on critical pages` - **88 console errors**
  across three page loads
- `routes/clubs.spec.ts:9 - should show create club page` - the Create Club
  dialog never appeared

They share one cause, and it is a live production defect:

```
[useWalletStore.Load_transactions_failed] {code: PGRST002, message: Could not
query the database for the schema cache. Retrying.}
Failed to load resource: the server responded with a status of 503
```

Measured against the project's own logs rather than inferred from the test:

| Measure                                            | Value          |
| -------------------------------------------------- | -------------- |
| 503 responses, 13:00-14:00 UTC                     | **47,202**     |
| All requests, same hour                            | ~793,000       |
| **Share of API requests failing**                  | **~6%**        |
| 503s on `/rest/v1/table_seats` (live seating)      | 8,758          |
| 503s on `/rest/v1/profiles`                        | 9,130          |
| 503s on `/rest/v1/rpc/insert_hole_cards` (dealing) | 674            |
| 503/429 per hour, 02:00-07:00 UTC                  | **4**          |
| 503/429 per hour, working hours                    | 5,000 - 46,000 |

The 503s are spread across every table rather than concentrated on one, which is
what a missing PostgREST schema cache looks like rather than a broken endpoint.
The schema is very large - **966 relations, 2,729 functions, 15,288 columns** -
and PostgREST's schema-cache load query is logged at 18-31 seconds routinely,
with one outlier at 125 seconds, against its own `statement_timeout` of 58s. The
overnight/working-hours split points at DDL frequency: this estate applies DDL to
production from agent sessions continuously, and every DDL asks PostgREST to
reload that cache.

**This is deliberately not fixed here.** It is not a Club Arena spec defect, it
is a platform-level production degradation that needs an owner, and it is
affecting live gameplay - `table_seats` and `insert_hole_cards` are the seating
and dealing paths. It is recorded here because the whole point of Phase 6 was to
have a guard that can say something true about production after a deploy, and the
first thing it said was this.

The correct outcome for those two specs is therefore to **stay red**. They are
not flaky and they are not stale; they are reporting a fault.

## Verification

- Checker proven in both directions with synthetic reports, and against a real
  Playwright JSON produced locally - including the detail that Playwright reports
  `file` relative to `testDir`, so an allowlist entry written from the repo root
  would have exempted nothing while looking correct. Pinned by a test.
- `E2E_REQUIRE_AUTH=1` proven to fail a credential-less run, by running one.
- Each workflow assertion proven red by seeding the revert it guards, then
  restored green.
- `noFixedSizeSourceWindows.test.ts` caught this work's own first draft for
  bounding a source window with `.slice(0, 200)`. Correct catch; the windows are
  now bounded by the workflow step.
