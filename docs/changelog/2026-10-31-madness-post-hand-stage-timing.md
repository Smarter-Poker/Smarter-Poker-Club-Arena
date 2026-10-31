# Original Madness post-hand stage evidence

## Change 1: bounded exact-hand stage evidence

**Files:** `server/src/engine/ServerTableEngineSettlement.ts`,
`server/src/engine/ServerTableEngineDealing.ts`, existing explicit-table health
selection in `GameServer.ts` and `observability/PublicTableLiveness.ts`.
**Lines before:** settlement 1926–2042, 2990–3191, 4146;
dealing 1717–1758; public selection 65–108.
**What existed:** successful settlement steps only update fleet aggregate
metrics. Committed-seat refresh and add-on announcement have no successful
wall-time evidence. The original table still exhibited delayed post-hold hand
boundaries after its durable database obligations were complete.
**What changed:** one bounded current/last hand trace per engine,
fixed stage names/outcomes and monotonic durations anchored to the matching
hand's actual completion hold. Copy only sanitized numeric/fixed-enum evidence
for an explicitly selected table through the existing health route.
**Why:** distinguish the actual remaining await before choosing a root repair.
Do not alter settlement/seat/animation ordering or add production operations.
**Verified:** YES, final source and connected callers reread. Existing settlement
barrier and predecessor tests pass; connected deferred-refresh/announcement/seat
lane proof preserves commit/obligation/leave call counts and the original await.
**TypeScript:** PASS, server and root `tsc --noEmit`, both exit 0.

This diagnostic prerequisite does not establish that the Madness delay is fixed.
Production activation belongs to the existing engine owner; actual original-table
behavior still needs verification after adoption.

## Change 2: fixed numeric evidence and bounded public selection

**Files:** `server/src/engine/PostHandStageTiming.ts` and its focused test;
existing `PostHandStepRetry.test.ts` and `PublicTableLiveness.test.ts`.
**Lines before:** new helper; existing native-engine/public-selection fixtures.
**What existed:** no exact-hand successful-path trace. The first new contract
attempt could not collect because this helper did not exist; that is not a
reproduction of the production latency or a passing baseline.
**What changed:** maximum 24 fixed stages per current/last hand; no retained
fleet history, player data, cards, error text or lease metadata. Pending stages,
failed clocks, missing/mismatched hold anchors and truncation remain explicit.
Only requested table IDs allocate timing snapshots, through the existing bounded
health selector; tournament discovery and ordinary health omit this evidence.
Parallel stages carry an explicit overlapping flag and must not be summed.
**Why:** obtain the missing causal stage evidence without a new telemetry
platform, log stream, endpoint, timer, retry or production mutation.
**Verified:** YES. Focused five-suite check: 54 PASS. Expanded connected/public
proof: 40 PASS across three suites (overlapping coverage, not 94 unique tests).
Source binding verifier: 1814 pins PASS. Root and server locked dependencies
were installed only in this private SSD tree.
**TypeScript:** PASS, server and root `tsc --noEmit`, both exit 0.

A single current identity read at 2026-10-31T15:53:46.847961Z still served EED,
instance `1-40a4a692`. Original table `8aea2cc5-e05a-4aa2-9404-ffa34a9fb33e`
was running, four seated/three dealable, hand 52945731, without the new timing
field. This read does not certify latency or instrument adoption.

## Change 3: retain the existing pause/progress source contract

**File:** `tests/a-parked-table-is-not-a-stalled-one.law.test.ts`.
**Lines before:** the liveness-snapshot method locator, line 212.
**What existed:** the declaration locator required the old no-argument method
signature and therefore could not locate its new optional observation scope.
**What changed:** use the existing line-start/access-modifier anchored declaration
prefix, `tableLivenessSnapshot(`. All 12 existing assertions remain unchanged.
**Why:** verify the actual same method's `isPausedByDesign` and progress-clock
facts, preserving every stall/pause assertion after the signature extension.
**Verified:** YES, actual extracted private method body reread; the locator
cannot match the earlier `this.tableLivenessSnapshot(...)` call. Affected
12-case contract PASS. Initial hook correctly refused this locator mismatch;
no remote source was admitted by that attempt. Related server checks passed
317 files/4241 tests with 166 existing conditional skips, not full-suite proof.
**TypeScript:** unchanged runtime/header inputs retain root/server PASS.

## Hosted source-extraction harness compatibility

Read owning CI 41218058874/job124586719010 actual failed log: two existing fixtures failed before reaching their guarded behavior. OriginalPayloadRetry.runtime.mjs lines 13/96 imported existing production dependencies but did not bind the new real PostHandStageTiming into its isolated VM; import and bind the production helper, preserving every financial/custody assertion. LiveTableFormatHealth.guard.test.ts lines 13/23 located the old no-argument declaration; retain the private declaration anchor with an open argument prefix so the existing sourceWindow matcher still extracts the whole actual method. No runtime/helper/header changes. Read verified: YES. Affected existing suites: 28/28 PASS (26 original payload retries, 2 public category/privacy guards). Server TypeScript: PASS, exit 0; runtime/header unchanged and root TypeScript PASS retained.
