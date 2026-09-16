# Program State

- Current phase: 7 of 7 — End-to-End Verification and Release
- Status: Implementation complete; branch integration required before deployment
- Started: 2026-08-31
- Completed phase: 7 of 7 — End-to-End Verification and Release
- Current gate: Passed for the implementation worktree
- Next phase: Integrate onto current `origin/main`, rebuild, and deploy through the protected pipeline

## Known Baseline Issue

The worktree inherited `node_modules` through a symlink to another checkout.
That checkout contains package versions newer than this branch's lockfile,
including incompatible Vitest/tinyrainbow packages and the now-retired external telemetry SDK. Phase 1 replaces
the symlink with an isolated `npm ci` installation before tests are considered valid.

## Phase 1 Evidence

- Lockfile-matched Vitest 4.0.18, tinyrainbow 3.0.3 installed locally; the former external telemetry SDK has since been removed.
- 75 Club Entry/header/law tests pass.
- Full baseline: 590 files pass; 9,042 tests pass; one test is skipped.
- Typecheck passes; targeted lint has zero errors and three pre-existing hook warnings.
- Vite compiles 2,460 modules successfully and optimizes media from 114.92MB to 31.58MB.
- Two unrelated baseline tests remain failing and are explicitly recorded in Phase 1 plan.

## Phase 2 Evidence

- `fn_create_club_atomic` serializes creates and commits the club, owner membership, and
  idempotency key in one transaction.
- Name uniqueness, identity, and four-club allowance are enforced at the database boundary.
- Create Club saves drafts and exposes availability, allowance, launch access, and image status.
- Logos are decoded, center-cropped, resized to 512px, and compressed to WEBP before upload.
- Typecheck passes; targeted lint has zero errors; 57 phase and regression tests pass.

## Phase 3 Evidence

- `fn_search_players` derives caller permissions, privacy, ranking, pagination, and live context.
- Trigram indexes replace client-side ID batching and table/tournament N+1 queries.
- Search and suggestion requests are cancellable and filter changes reconcile the current result set.
- Players can control club/union discoverability, display-name, presence, and live-table exposure.
- Typecheck passes; targeted lint has zero errors; 58 phase and regression tests pass.

## Phase 4 Evidence

- `fn_join_club_atomic` resolves the club, creates or reuses membership, redeems referrals,
  persists application state, and stores an idempotent result in one transaction.
- Invalid invitations roll their new membership back; preview and join attempts are rate limited.
- All user-facing join surfaces now delegate to `ClubJoinService`.
- The modal confirms club identity and supports clipboard, deep link, QR, pending cancellation,
  and 24-hour auth/offline replay with the original request UUID.
- Typecheck passes; targeted lint has zero errors; 84 phase and regression tests pass.

## Phase 5 Evidence

- Feature availability is read once for the action bar and independently enforced in every
  authoritative Create, Find, and Join database path.
- Telemetry stores only allowlisted operational dimensions and exposes aggregated daily health
  data to the service role; raw names, queries, codes, and invite URLs are rejected by design.
- Direct client audit-log mutation is revoked and database triggers capture relevant mutations.
- Escape handling respects nested dialogs and cannot bypass Create Club's unsaved-work warning.
- React Router is upgraded to 7.18.3, `npm audit` reports zero vulnerabilities across 523
  dependencies, typecheck passes, targeted lint has zero errors, and 36 trust/regression tests pass.

## Phase 6 Evidence

- The action bar is a reusable semantic component with purpose-specific Create, Find, and Join
  controls, keyboard cues, rollout states, high-contrast support, and reduced-motion handling.
- Real-browser checks at 1100px and 390px confirm the final render; mobile targets are 70px tall
  and the document has zero horizontal overflow.
- The header selects responsive 320px/640px WebP identity art; the primary variant is 26.9KB,
  down from the original 2.1MB source.
- Production gzip budgets pass: HomePage JS 15.8KB/CSS 9.0KB; each lazy modal JS is 5.6KB or
  less and CSS is 3.8KB or less.
- Production compilation, typecheck, and targeted zero-error lint pass; 73 phase/law tests and
  104 focused visual/header tests pass.

## Phase 7 Evidence

- Four unique full-length migration versions parse as 77 PostgreSQL statements in an order that
  creates player preferences before the trust layer installs its trigger.
- Runtime component/service tests exercise semantic routing, disabled feature controls, all three
  dialog surfaces, Escape behavior, supported Join input shapes, recovery persistence, RPC input,
  event emission, and Find response/filter mapping.
- Create retries now reuse the draft's request UUID, replay the request-scoped logo upload, and
  preserve the uploaded asset when a transport failure leaves commit outcome ambiguous.
- The full production pipeline completes and its feature/media budgets pass. Provenance records
  this branch as dirty, 6 commits ahead and 233 commits behind `origin/main`; do not deploy it.
- Repository-wide typecheck and `git diff --check` pass. ESLint reports zero errors (690 inherited
  warnings). Production and complete npm audits report zero vulnerabilities.
- Full suite: 2,670 suites; 9,087 tests passed; one intentionally skipped; zero failures.
