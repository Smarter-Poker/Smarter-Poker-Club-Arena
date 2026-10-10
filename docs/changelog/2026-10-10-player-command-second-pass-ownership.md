# Player Command second pass: response truth and request ownership

Protected baseline: `052899dd3f52a2d9367ef0eec8dcc33bdbd74071`.

## Directory responses

`src/services/ClubRosterService.ts` previously turned a null/missing roster-page envelope into an empty successful directory and malformed summary fields into zero totals. Validate the required envelope, capability booleans, finite nonnegative counts, member identifiers and continuation cursor before rendering. Explicit null summary access denial and an actual empty page remain valid. Real Supabase/PostgREST transport tests fail on the original response handling and pass the correction without retries or empty fallbacks.

## Viewer ownership

`src/pages/PlayerStatisticsPage.tsx` previously cancelled/reset only for club/member route changes. Include the signed-in viewer in both ownership dependencies, so private results and variant lists are cleared and an old viewer response cannot finish the new viewer's read. The real component account-switch regression fails before and passes after.

## Unsaved notes

`src/pages/MemberManagementPage.tsx` previously copied every refreshed nickname/remark over local text, clearing the unsaved flags. Adopt incoming verified notes only for unchanged fields; preserve dirty drafts and unresolved receipt payloads. A range-refresh component regression proves the draft survives while the unchanged remark adopts the server value. An unconfirmed save also keeps Revert disabled and the explicit retry available, including when a newer local draft equals the old saved value. A recoverable range-read error also retains the same mounted note owner, with edits disabled and financial sections absent until verification recovers. The draft and original receipt survive Retry Member. Explicit input labels remain stable when the inline unsaved status appears. Both real component assertions fail before and pass after; existing same-receipt retry coverage remains enforced.

## Vault operation ownership

`src/pages/PromoVaultPage.tsx` previously awaited unbounded purchase/grant requests and applied an old club's result to the next club's inventory/balance. Bound each original attempt to40 seconds, discard UI delivery after navigation/account changes/unmount, and scope grant receipt keys by club and viewer as well as item/recipient/quantity. Preserve unknown grant receipts for explicit retry; never automatically replay a write. The late-purchase component regression fails against the original source and passes the correction; stalled-request and same-receipt/new-club cases pass.

The existing database purchase refusal is an intentional Diamond Accounting Standard restriction, confirmed by read-only current function inspection. This change does not fund club Diamond wallets, enable unavailable purchases, change prices or move production chips. No migrations or engine changes are required; all ten prior installed Player Command migrations remain immutable.

## Verification

The full client suite passed 35,211 tests across 2,549 files (one existing skip). The final note-error recovery refinement reruns all affected checks; unchanged suite evidence remains valid. Final focused component/real-PostgREST results are recorded in the checkpoint. Full exact-candidate client checks, type/build checks and protected publication/live proof are recorded separately in the existing external task checkpoint; queued checks are not passes.
