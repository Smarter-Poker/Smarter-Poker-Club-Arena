# 2026-08-29 — The run-it-twice stack, and the last specs with nowhere to run

Two items closed that were left open earlier the same day. One of them closed
by proving the existing code right, which is a result and not a non-result.

## 1. The run-it-twice stack: measured, and DELIBERATELY LEFT AT 68%

`.table-page[data-boards] .community-area` is `width: 68%`, and the comment
above it derives that from side seats at x 10.5/89.5. The 2026-08-26 pass moved
the rail out to x 8/92, so the derivation looked stale and the stack looked
about 20% narrower than the felt allowed. Dan has asked twice for bigger cards
on a phone, so this was worth settling properly.

Measured on PRODUCTION rather than in the synthetic harness (which had already
produced two false readings on this exact question earlier the same day): an
authenticated phone-sized session on a live table, real seat plates, Dan's own
notch and home-indicator insets applied, the stack forced to 1, 2 and 3 runs.

    stack at 68%          x 25.01 .. 74.78 of the scaler, board card 37px
    seat plates in band   clear from x 17.28 .. 81.69
    apparent cap          88% of .table-surface

I widened it to 76% on that evidence — and `tests/unit/mobileBoardAndActionBar
.test.ts` went red and was RIGHT. Two things the production probe could not
see:

- **the bet chips.** A seat's chips rest further inboard than its box
  (4-max, x 8, y 58 rests its chips at x 20.60 against a box edge at 21.83).
  There were no chips on the felt at the moment I measured, so the probe
  never saw the marker that binds.
- **the stack's real height.** I forced three runs by CLONING the run node on
  a table between hands, which does not carry a real showdown's headers. The
  shipped model assumes a stack can reach y 75; my clone measured 57. An
  under-measured stack over-states the width available, in the direction that
  puts cards on a nameplate.

Re-derived against every marker the estate models — chips, dealer button and
seat box, on every ring at every table size — the cap is **69.86%**, and the
binding marker is the bottom-cap seat's box at (10.5, 82.5) reaching up into
the stack's band. 68% is that cap with margin. **The number was already
correct, and the comment above it is what was stale.**

So the width is unchanged and the guard that caught this is untouched. A
speculative widening of a run-it-twice board — the single most dramatic moment
of a hand — is not worth ~10% bigger cards bought with a measurement that had
already been wrong twice that day. If this is ever revisited, the work is to
measure a REAL run-it-twice showdown's stack height with its true headers; if
it is genuinely shorter than the modelled y 75, the bottom-cap seat leaves the
band and roughly 77% becomes available.

## 2. Every e2e spec now runs in a job

The earlier pass wired seven of sixteen orphans into `css-beats-e2e`. The rest
needed a login or a deployed URL, which that gate has neither of by design.
They had nowhere to run, and nowhere to run is how a guard becomes a comment.

**New `post-deploy-e2e.yml`** runs the nine URL/login-dependent specs against
the real deployed bundle after the World Hub sync publishes. It waits for
`build-info.json` to name the commit before measuring anything — otherwise it
would test the PREVIOUS bundle and report the verdict against this one, the
exact class of false result this whole day was spent removing — and skips with
a warning if another commit overtakes it. It is `workflow_run`, not a
`schedule:` trigger, so it does not touch the estate's cron rules. It cannot
gate a merge (the code is already published by then) and does not pretend to:
what it provides is somebody looking at production after a deploy, which is
what this estate keeps discovering it lacks. `mobile-fit-audit.spec.ts` finally
runs in the `MOBILE_FIT_STRICT=1` mode its own header has described since the
day it was written.

**The last two orphans are fixed rather than exiled.** customization-studios
went red on the Linux runner on a TEXT-metric assertion: it required each tab
label to fit its column, and the studio font loads from /fonts which a
`setContent` harness cannot resolve, so macOS fell back to a narrow face and
Linux to a wide one. The page ships correctly on both. The beat now asserts the
ROOM the grid guarantees (`minmax(124px, 1fr)`) instead of the rendering of a
font that never loaded. Both specs are in the gate.

Result: 20 of 20 e2e spec files run in a job. Before today, 4 did.

## 3. The post-deploy job's first run cancelled itself, and that was a design flaw

The workflow above fired on its own merge and was CANCELLED — in the wait step,
by the next deploy. Working as written, and wrong as designed.

The first version waited up to ten minutes for production to serve its OWN
commit's sha before testing anything. On a repo where merges land every few
minutes, `cancel-in-progress` then kills each run mid-wait when the next one
starts, so a run could spend its entire life waiting and never reach a single
spec. A job that always cancels is a job that never runs, which is exactly the
"a guard with nowhere to run is a comment" failure this workflow exists to end.
It would have shipped looking green and guarding nothing.

The fix is to stop pinning to a sha. The question this job answers is "is
PRODUCTION healthy right now", not "is commit abc123 healthy": the specs check
routes, layout and touch targets on the live site, and any deploy that reaches
production is a fair subject — in fact the newest one is the MORE useful
subject, because it is what players actually have. So it now confirms
production is serving, records which sha it is about to test (and says plainly
in the summary whether that is this run's commit or a newer one that overtook
it), and runs. About three minutes instead of thirteen, and cancellation only
dedupes a burst instead of starving the job.
