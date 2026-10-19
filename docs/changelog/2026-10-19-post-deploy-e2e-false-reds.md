# Post-Deploy E2E: two false reds that were not the maintenance break

Investigated after Post-Deploy E2E runs 39273904016 and 39278744529 failed
around the 15:53-16:00 UTC break on 2026-10-19, and several runs sat queued.

## 1. Client browser verification lost its own account mid-run

Job 118134919713 (run 39273904016) failed 65 checks between 15:44 and 16:17 UTC,
mostly Club Operations admin routes and the WebKit mobile lobby. The break was
not the cause: the failures started at 15:44, before the :53 announcement, and
continued for seventeen minutes after the 15:58:56 thaw.

Read from Supabase:

- the job created its disposable identity `23f23947-...` at 15:14:07 and its
  isolated template club `5c2556ae-...` at 15:14:08;
- at 15:43:22 a Supabase MCP session ran
  `fn_ca_retire_welcome_certification_club('5c2556ae-...', 'orphaned-certification-fixture-cleanup')`;
  the club no longer exists;
- at 15:44:06 a `DELETE /auth/v1/admin/users/23f23947-...` from a workstation
  address (not GitHub) soft-deleted the identity (its email became an opaque
  token, which is what the notification observer saw).

From then on every signed-in check ran as a signed-out visitor with no club:
redirects to `/auth/login` and `/invite/shark-club`, "Club Operations Sections"
missing, `unknown_club`. None of it was a production defect.

Fix: `scripts/ci/retire-reserved-certification-account.mjs`, the explicit
"recover another run's identity" door, now refuses an identity younger than
`STALE_ACCOUNT_AGE_MS` (112 minutes, the longest job that may own it), and
refuses one whose creation time it cannot read. The owning job's own always()
cleanup is unchanged. The club retirement went through a direct SQL call, which
no repository script mediates.

## 2. The publication gate turned a cancelled publisher into a red certificate

Run 39283184506 failed in "Confirm The Hetzner Web Publish Reached Production"
with "The origin job is missing one of its release-verdict steps." Its source
publisher 39275112750 was cancelled while its read-only `retain-runtime` job was
verifying, so `publish-to-origin` was skipped with no steps and nothing reached
the origin. The gate already stood down for a publisher cancelled with zero
jobs; it now also stands down when every origin-facing job is skipped (or
cancelled before it started), at least one job was cancelled, and no job
failed. A publisher whose own tests failed, or a `publish-to-origin` cancelled
after it started, still fails red.
Pinned by `tests/unit/postDeployGateCancelledPublisher.test.ts`.

## Not fixed here

- Run 39278744529, "Live-table and engine verification", failed at 16:11:44 in
  the opt-in natural multirun observation (`production-live-table-multirun.spec.ts`),
  not in the break: the engine had thawed at 15:58:56 and resumed every table by
  16:00:10, and the four realtime cases passed 16:03-16:09. One of four
  simultaneously opened observer pages had its `smarter-poker-auth` lock
  acquisition aborted (`getSession() threw: AbortError`, `TableWS.connect.failed`)
  and showed "Reconnecting To The Table". PR #7463 owns that lane.
- The queued runs were the intended `post-deploy-e2e-production` serialization
  (39278744529's client job waited behind 39273904016's until 16:17) followed by
  the GitHub Actions incident "Degraded availability for GitHub Actions, GitHub
  Pages and Webhooks" from 15:49 UTC, when around 100 runs in this repository
  queued while only three to five jobs ran. All jobs use hosted `ubuntu-latest`;
  no runner label is unserved and no concurrency groups wait on each other.
