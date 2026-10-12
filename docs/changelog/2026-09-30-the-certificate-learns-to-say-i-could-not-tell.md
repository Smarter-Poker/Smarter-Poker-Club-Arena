# The Post-Deploy Certificate Learns To Say "I Could Not Tell"

2026-09-30. `Post-Deploy E2E (production)` had produced no green verdict in
days: over the last twenty runs, **12 failure, 6 cancelled, 0 success**
(issue #4076). It is the estate's only signed-in browser proof against live
production, so for those days nothing could prove a player-facing change
actually rendered.

Two of the three causes were the same mistake in three places, and it is the
one CLAUDE.md 10.86 rule 1 is about: **the suite had no name for "I could not
tell", so every scheduled platform event got shouted as a defect on
production.** Not one of the runs below had found anything wrong with the live
site.

## 1. The provenance race (structural, every run)

`scripts/ci/production-e2e-provenance.mjs` required the live `ca_sha` to be
`same` or an `ancestor` of the run's checkout, and required it to be
**unchanged** from the first browser to the last.

`publish-club-arena` fires on every merge, merges land every few minutes, and
the suite takes forty. So by the time the browsers finish, production is
normally serving a **later** commit on the same protected main. Both guards
read that as a failure:

- run 36673263757: `Production SHA 4ea12227d... is not an ancestor of checkout 5879d3194...`
- run 36720417423: `Production changed from 2782d0921b... to 2620e36182... during certification`

At this merge rate the "one frozen SHA" demand could essentially never hold.
That is not a flake; it is the normal case, and calling it red taught everyone
to ignore the only check that looks at production.

The reasoning behind the guard is still right - a green assembled across two
bundles certifies neither - so it is kept and **classified** instead of
collapsed:

**Lineage now has three answers, not two.** `descendant` means production is
ahead of this checkout because another publisher landed while we queued. The
run **re-targets**: it takes the whole suite from the live commit, so the
assertions match the bundle the browser actually loads. `ancestor` is
unchanged (assertions from the deployed commit, harness kept at this one). A
SHA that shares no lineage, or resolves to no trusted commit, is still refused.

**The closing read classifies the release window.** `certified` means
production never left the recorded SHA. `superseded` means it advanced to a
later trusted commit on this same main: the suites that finished before the
switch still certify the recorded SHA, and anything that straddled it could
not tell. That is a **named non-verdict**, reported as `::warning::UNKNOWN`
and `NON-VERDICT` in the job summary - never as a defect, and never silently
as success. A **rollback, an off-lineage SHA or an unreadable document is
still a hard red**; those were exactly what the old string comparison could
not tell apart from an ordinary publish.

UNKNOWN exits **3**, and a law forbids it sharing a code with certified (0) or
error (1), the same convention `pr-status.mjs` already uses.

`unchanged` is deliberately NOT reused for this and keeps its own meaning:
`publish-club-arena` calls it the instant after it swaps its own symlink,
where any change at all really is wrong. A test now refuses to let the browser
window borrow it.

## 2. The engine's own :55 restart, read as a production failure

`live-table-e2e` opened with one `curl -fsS https://engine.smarter.poker/health`
and no tolerance. The engine restarts at :55 of **every** hour inside an
announced break (section 13) and is genuinely down for about two minutes of
it. Run 36717851302 started at 12:54:24Z and died at 12:55:36Z on:

```
curl: (22) The requested URL returned error: 502
[production-e2e-provenance] Production engine health is not valid JSON.
```

The engine was keeping the schedule we set for it.

`scripts/ci/read-engine-release.mjs` now waits through it, on the **same
measured budget the resume step a few lines later already waits**
(`GAMEPLAY_WAIT_MS`, 720s, derived from the 663.712s the engine needed on
2026-09-27) - reused, not re-guessed. It parses with the same
`readReadyEngineSha`, so nothing about what counts as a healthy release
changed, and **an answer it can read is never polled past**: a 200 that is not
one healthy release throws on the first attempt.

## 3. What is left is real, and is named rather than silenced

No assertion was weakened to make anything pass. These stay red:

**`fn_cashier_statement_totals` returns HTTP 500 on production.** A live
defect, not a harness one. `production-cashier-statements.spec.ts:157` reports
`httpStatus: 500`. Measured on production: `pg_stat_statements` has the
PostgREST-wrapped call at **21 calls, mean 3,482ms, max 7,968.7ms** against
the `authenticated` role's **8s** `statement_timeout`, with 42,676
`shared_blks_read`; postgres logs the cancellation
(`canceling statement due to statement timeout`) and PostgREST returns 500 at
exactly 8.07s. Over 24 hours the RPC answered **500 twelve times and 200 four
times** - and the four fast 200s are the unauthorized early return, not a
successful total. Warm, it runs in 61-190ms; that is the buffer cache lying,
not the defect being absent. A real club admin opening
`clubs/:clubId/cashier/statements` gets "Unavailable For This Range" most of
the time. The indexes it needs already exist
(`idx_chip_ledger_cashier_totals_cover`, `idx_chip_tx_club_time_totals`), so
this is not one missing index: it is ~75,700 entries aggregated across two
tables under constant engine write load, and fixing it means changing how the
total is derived. That is Cashier Phase 5 work on a money surface, it is not
small, and it is not started here.

**The certification fixture cleanup cannot survive a platform freeze.**
`tests/e2e/support/temporaryCustomizationAccount.ts` budgets
`PLATFORM_FREEZE_CLEANUP_ATTEMPTS = 37` x 10s = **370s** for
`platform_is_frozen`, and `scripts/ci/production-e2e-account.mjs` repeats the
identical 37 x 10s loop. Measured against `engine_maintenance_break_log`,
**435 breaks over 14 days, every single one longer than 370s**: min 395s, mean
448s, p95 533s, p99 550s, largest ordinary break 578s. The 13:55 break on
2026-09-30 ran 501s and ended at 14:03:20.539Z; run 36722592438's Daily
Missions cleanup gave up at 14:03:10 - ten seconds early. So a cleanup that
starts inside a freeze is **guaranteed** to fail. It is not fixed here because
raising the budget alone moves the trap one level up (10.86 rule 4): the
enclosing test's timeout is 600s and the job ceiling is 50 minutes shared with
eleven other suites, so covering a 578s freeze needs the cleanup moved out of
the frozen window, not a longer wait. Separately, the freeze has never once
fitted its documented five-minute `:55-:00` window.

**The MTT live-table case has a precondition production cannot always
supply.** SPIN, SNG and the network-loss case pass; the MTT case failed
because no already-running MTT table had 3+ dealable players _and_ a
selectable natural HUD clock inside its 90s poll. Three MTT tables exist in
the fixture scope; when all three are on a blind break or in an add-on period,
there is nothing to observe. The fleet is alive (checked at 16:22Z: three MTT
tables, 5-6 dealable each, all progressing). An absent subject is a
non-verdict, not a defect, and the case does not yet distinguish them.

**Unattributed:** the club lobby rendered
`Warning Something Went Wrong Please Reload The Page` at
`/clubs/shark-club` at 13:48-13:50Z, inside the same window in which the
database was returning 500s broadly. I could not attribute it to a specific
RPC from the logs retained, and I am not guessing.

## Addendum, 17:11Z: a fourth instance of the same mistake, found by watching

The two fixes above merged as `78cd51a8c7`. The very next runs never reached
either of them: they died in the **publication gate**, which is the same
mistake one step further upstream.

`publish-club-arena` cancels in progress when a newer merge arrives, and
merges were landing every few minutes. Publisher run `36749429418` was
cancelled **while still queued** and produced ZERO jobs. The gate read the
jobs API, found no `publish-to-origin`, and threw:

```
Error: Expected one latest publish-to-origin job, received 0.
```

Runs `36749436277` and `36749498583` both went red on that within thirty
seconds of each other, before a single browser started. Nothing had gone
wrong. A newer publisher had taken over, and its certificate is the one that
means anything.

So when **no `publish-to-origin` job exists AND every job the source run did
produce ended `cancelled` or `skipped`**, nothing reached the origin: the gate
now stands down without writing `should_run`, so every downstream job skips
and the run occupies no production lock. It is a non-event, not a pass and not
a failure.

This deliberately cannot hide a real publish. A source run holding any job
that actually ran with no `publish-to-origin` among them is the
renamed-or-missing-job hole and still throws, as does a failed origin job and
a malformed jobs response. The source run's own top-level conclusion is still
never consulted - an optional Capgo failure must not suppress web E2E, which
is why `SOURCE_CONCLUSION` remains banned. `postDeployE2EConcurrency` now
executes the gate's actual node block against all six payload shapes.
