# Realtime Continuation Closeout Checkpoint

Recovered from the interrupted Resume Real Time Updates work on September 10, 2026. This checkpoint supersedes pending pagination statements in the earlier
Phase 17 release receipt. It preserves the historical Phase 16 evidence and
keeps full programme acceptance open where the required observations do not exist.

## Latest Inherited Repair Is Published And Accepted

PR #4195 merged as 904171acc4f143da4c8c6619ba73cfbc12293753 at 17:56:09 UTC.
It contains both the player-query repair and the matching Games pagination /
prefetch repair from source head a1f4f60b1e520efa65ac9417db70d93e644f35dd.
The previous September 10 worktree is clean. Its implementation and two test
blobs exactly match those in the public release recorded below.

Production run 34511362353, job 102986979570, executed 292 cases across 34 files:
288 passed, four failed, two additional skips, zero flaky results. All 259
sweep cases passed, including all seven Club Data cases and the unchanged
sorting/pagination/manual-refresh acceptance. Cashier, the financial routes,
Daily Missions, customization, accessibility and database settlement also passed.
The reserved account was hard-deleted and absence verified at 18:24:06 UTC.

The four failures all stopped before continuity execution because the running
engine identified 7732b971 and the required release was 904171acc4f143da4c8c6619ba73cfbc12293753.
They are not four observed gameplay failures and they are not four passes.

At 18:48:14 UTC, public and origin build-info both served
0e49f48409afb11d28f9e380ce19838aaddae9ec, built at 18:46:51 by publisher 34516159193. Both remained unchanged after the asset reads. Git ancestry proves
that release contains PR #4195. The referenced ClubDataPage-COWpYR9J-v6.js was
53,555 bytes and identical on public and origin, SHA-256
eccc71180610fc6f03151f1b695f991d9c1373dd0ae6a63505c8fb874ff8562b.
The companion JSON retains the entry hash, source/test blobs, artifact identity
and timestamped machine observations. Artifact digests are the GitHub-reported
digests, not a claim that browser artifacts were independently downloaded here.

## Recovered Uncommitted Draft

The older codex-realtime-continuation-sep07 tree held an uncommitted ticker
query change absent from current main. Before recovering it, tracked working
state was retained under refs/wip/codex-realtime-continuation-sep07/closeout-20260910T184110Z
(commit 21ec035f2d26cec80c1afeab30cf93f5b472225a). The original worktree status
was verified unchanged by the snapshot. Snapshot history remains local because
uncommitted snapshots may include private material; it must not be pushed wholesale.

The draft is completed in the separate codex-realtime-closeout-sep10 tree.
The operational ticker excludes completed tournaments older than its existing
ten-minute display window before the 80-row limit. Existing live/upcoming
statuses, member club scope, RLS, source switches, sort and display rules remain.
See the recovered-ticker changelog for validation. This checkpoint records the
source change before its own normal merge/publication, not an invented live claim.

Other codex-live-realtime release/rebuild trees and the active stage-b-v2 worktree
were inventoried and left intact. Some contain mixed staged changes and active
migrations belonging to the coordinated live-table/accounting release. They are
not a source to replay wholesale into this client closeout. The older release
ledger and those worktrees remain available; none was reset, cleaned or removed.

## Acceptance Still Required

1. The coordinated engine release must satisfy the unchanged exact-version
   prerequisite and then pass all four progressing-hand/reconnect certificates
   for cash, MTT, Spin and SNG. Engine sealing and Stage-B remain with the existing
   coordinating work, as the programme already records. No engine cutover,
   maintenance bypass or release-gate relaxation was performed here.
2. Physical iPad/PWA, natural network-switch/background-resume and natural-event
   delivery evidence remain unverified. Automated desktop/mobile viewport checks
   do not substitute for these specific device observations.
3. Detailed PostgreSQL caller logs and the historical per-service egress
   breakdown remain unavailable through the connected access documented in
   2026-09-10-supabase-email-follow-through.md. No missing data is called zero.

The later production run 34512870801 was still running when this checkpoint's
source observations were captured. Do not attribute its eventual result to the
older run, and do not rerun the broad suite merely to duplicate existing evidence.
The programme is not certified 100 percent complete by this receipt.
