# The customization certificate releases the write before the reader

## Change 1 - remove the routed-gameplay certificate deadlock

**File:** `tests/e2e/gameplay-customization-runtime.spec.ts`

**Lines before:** the `OneShotRequestGate.waitForRequest` and
`chooseAppearance` helpers around lines 100 and 581.

**What existed:** the production certificate intercepted an appearance RPC,
proved the writing table's optimistic repaint, and then waited for a separate
browser context to receive the durable database change while the RPC was still
blocked. That second browser cannot reconcile an uncommitted write. When the
assertion failed, the route stayed held, browser cleanup waited on it, and the
test ended only at its 20-minute outer timeout. Production run `37459888614`,
job `112256560903`, reproduced that exact non-verdict.

**What changed:** the writer's immediate repaint is still asserted while the
request is held. One shared request-gate helper then releases every table,
frame, and aura write in `finally`, observes the response promise from the
moment it is created, requires the exact response to succeed, and only then
allows cross-device reconciliation. Waiting for the request has the same
bounded timeout as the rest of the certificate, and `release` also disarms a
gate whose request never began.

**Why:** realtime cannot deliver a database post-image before its write is
allowed to commit. Cleanup must also remain reachable after any failed
optimistic-paint assertion.

**Verified:** YES - the edited source was reread, the ordering is pinned by
`tests/unit/postDeployE2EConcurrency.test.ts`, and
`tests/unit/oneShotRequestGate.test.ts` executes both the success and
optimistic-assertion-failure paths.

**TypeScript:** PASS - the final grouped client typecheck completed with exit
code 0 after the shared request gate and all three production call sites were
in place.

## Change 2 - keep the release-before-reconcile order from regressing

**File:** `tests/unit/postDeployE2EConcurrency.test.ts`

**What existed:** the source-law suite pinned the routed table projection and
its production anchor, but did not constrain the persistence-gate ordering.

**What changed:** a focused source contract requires the writer assertion to
precede `gate.release()`, the release to precede the exact response, and the
response to precede the second-browser assertion. It also requires the release
to remain in `finally`.

**Why:** this is the causal boundary that distinguishes immediate local paint
from durable cross-device realtime reconciliation.

**Verified:** YES - the focused source contract and executable gate tests pass.

**TypeScript:** PASS - the final grouped client typecheck completed with exit
code 0 after the source contract and executable failure-path test were in
place.

## Change 3 - certify the affected Phase 1 journeys exactly

**Files:** `scripts/ci/phase1-customization-certificate-coverage.mjs` and
`.github/workflows/post-deploy-e2e.yml`

**What existed:** the cutover seal required the entire long production browser
job to be green. A Financial Admin or Club Data failure could therefore erase
complete customization evidence, while the generic honesty check could not
distinguish a renamed, retried, skipped, or wrong-project customization case.

**What changed:** a dedicated classifier requires exactly one first-attempt
Chromium pass from each realtime, routed-gameplay, and commerce journey, with
the exact file, title, project, expected status, result, retry index, report
statistics, and empty error set. The seal still requires one exact release,
successful fixture deletion, all four live-table cases, equal client SHAs, and
the exact engine. Unrelated browser failures remain red and visible in the
overall workflow but cannot impersonate or erase Phase 1 evidence.

**Why:** a scoped release receipt should answer the affected behavior question
without weakening the broader operational audit or making unrelated pages a
database-migration dependency.

**Verified:** YES - the classifier/verdict suite rejects missing, malformed,
renamed, duplicate, skipped, failed, flaky, retried, wrong-project, dirty
cleanup, and unstable-release evidence. The workflow YAML parses and the
existing post-deploy honesty and durable Final Table laws pass.

## Change 4 - discover an eligible MTT before the bounded health read

**Files:** `tests/e2e/support/tournamentHudWitness.ts` and
`tests/e2e/production-live-table-realtime.spec.ts`

**What existed:** the public candidate read ranked by dealable/seated count and
then truncated to 32. In runs `37454244089` and `37459888614`, one large
temporarily ineligible MTT filled all 32 slots and hid any smaller eligible
field. The refusal attachment also omitted the HUD qualification reasons.

**What changed:** one authenticated, RLS-constrained joined read now requires
RUNNING tables, RUNNING fixture tournaments, and an authoritative `mtt-v1` or
`mtt-v2` contract before applying the unchanged natural-clock predicate. It
uses stable table-ID keyset pages under one deadline, gives every eligible
field one candidate before any field gets a backup, and advances through at
most three exact 32-table engine-health batches. A stale top table therefore
cannot hide its live backup. Rejected or still-in-flight reads remain
operational failures rather than being mislabeled as an absent MTT. Bounded
scan limits fail closed, and refusal evidence names requested/readable/eligible
counts, categorized tournament/table refusals, and exact IDs absent from engine
health.

**Why:** the certificate must not confuse a biased candidate sample with the
absence of an eligible production subject. It still cannot invent a clock or
weaken the required MTT, SPIN, SNG, and cash cases.

**Verified:** YES - 50 focused MTT/HUD tests pass, including an ineligible SNG
competing with an MTT, forty higher-occupancy tables from one ineligible add-on
field ahead of a lower-occupancy eligible field, stable pagination beyond
exactly 1,000 tables, fair stale-table backup selection, bounded exact-health
fallback, operational read failures, and a read still in flight at the outer
poll deadline.
