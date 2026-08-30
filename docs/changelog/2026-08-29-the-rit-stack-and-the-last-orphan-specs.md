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

## 4. What the post-deploy tier found on its very first complete run

23 passed, 3 failed, 4.8 minutes, against the live site. Every failure was
worth having, and only one of them is a defect.

**Two were the tier crying wolf, and that was the more urgent thing to fix.**
It reported controls as unreachable on /friends and on the club home, including
a "Challenge" button with ZERO reachable pixels. Probed live, none of them was a
tap-target problem: `ClubArenaWelcomeModal` was open and
`document.elementFromPoint` was returning its overlay for every point on the
page. A suite that reports every control on every route as unreachable gets
muted, and a muted suite is the thing this whole workstream exists to prevent —
so the two mobile specs now set `STORAGE_KEYS.WELCOME_ACCEPTED` from an
`addInitScript`, which runs before every document in their own context. The
storageState global-setup captures is correct and stays; it is simply not
sufficient for a spec that opens its own `isMobile` context.

**One is a real accessibility defect, and it needs a design decision rather
than a patch.** `.club-identity__line` — the club identity card's two ID lines,
which are real buttons that copy the id — paints 11px tall with no hit area at
all. The repo's established remedy is an invisible 44px `::after`, and it
provably cannot work here: the two lines are adjacent rows of a
`grid-template-rows: 1.2fr 1fr 1fr 1fr` with no row-gap, so two 44px bands
centred ~14px apart overlap almost completely, the later-painted one wins the
overlap, and the upper line still fails. That is trap #1 in club-engine.css's
own notes ("the container needs a row-gap of at least 12px, not the ::after a
smaller height"), and adding that row-gap changes the proportions of a card
Dan approved.

I wrote the ::after fix, measured that it would not actually fix it, and took
it back out rather than ship a change that looks like a repair. The options are
real ones for Dan: give the identity card's detail rows enough separation to
carry two thumb targets, or stop making both lines buttons and copy the id from
one control. Until then the post-deploy job stays red on this single, named,
genuine finding — which is what an open bug should look like, and it cannot
block anyone's merge.

## 5. The orphan sweep had its own blind spot: it only globbed one level

The sweep that wired sixteen orphans into jobs used `tests/e2e/*.spec.ts`, and
`tests/e2e/routes/` is one level down. Nine route suites — admin, basic,
cashier-deep, clubs, features, financial-flows, hamburger-menu, operations,
social — stayed invisible to the very audit that existed to find them, and the
report that said "20 of 20" was counting 20 of 29.

They are wired now, and named as a DIRECTORY (`tests/e2e/routes`) rather than
nine filenames, so a tenth file added beside them cannot arrive orphaned.

`diamond-checkout-mobile.spec.ts` was also missing — it landed from another
branch the same afternoon and arrived with no job, which is the trap operating
in real time while the fix for it was being written. It is self-contained
(readFileSync + setContent), so it joined the merge gate: 12 specs, 108 beats.

Final state: **30 spec files, every one of them named in a job.** This morning
it was 4. The verification is stricter now too — the check confirms every spec
NAMED in a workflow actually exists on disk, because a typo'd filename in a job
is a silent orphan wearing a green tick.
