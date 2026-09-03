# Delivery Plan

## Phase 1 of 7 — Foundation and Regression Harness

- [x] Capture vision, requirements, constraints, and seven-phase roadmap.
- [x] Replace shared dependency symlink with an isolated lockfile installation.
- [x] Run typecheck, targeted lint, action-bar regression tests, and production compilation.
- [x] Add regression coverage for semantic actions, dialogs, focus traps, and header identity.
- [x] Record current service/RPC/deep-link contracts for downstream phases.
- [x] Establish the full-suite baseline: 9,042 passing, 1 skipped, 2 unrelated existing failures.
- [x] Record release provenance and dependency-audit gates for their owning phases.
- [x] Verify no unrelated worktree changes were modified.
- [x] Mark Phase 1 complete only when all applicable gates pass.

## Baseline Exceptions Routed Forward

- [ ] Release integration remains external to this implementation: the existing WIP branch is
      233 commits behind `origin/main`, and the provenance guard correctly warns against shipping it.
- [x] Correct stale wallet/ClubHome assertions and the full-suite geometry timeout ratchet.
- [x] Remediate all production and development dependency audit findings in Phase 5.

## Phase 2 of 7 — Create Club

- [x] Add a server-authoritative, serialized creation RPC.
- [x] Commit the club, owner membership, and idempotency request atomically.
- [x] Enforce exact case-insensitive name uniqueness and the four-club limit server-side.
- [x] Add live name availability and club allowance indicators.
- [x] Save and restore recoverable text/settings drafts.
- [x] Add public discovery and join-approval launch settings.
- [x] Decode, square-crop, resize, and compress uploaded logos before storage.
- [x] Use collision-resistant per-user object paths and clean failed pre-transaction uploads.
- [x] Preserve one cross-page membership event and post-create club navigation.
- [x] Pass typecheck, targeted lint, and all 57 Create/action regression tests.

## Phase 3 of 7 — Find Player

- [x] Replace browser-computed authorization and roster batching with one authenticated RPC.
- [x] Derive friend, club-role, and managed-union scope from `auth.uid()` server-side.
- [x] Add trigram indexes, exact/prefix relevance ranking, stable sorting, and bounded pagination.
- [x] Enforce discoverability, display-name, presence, and live-table preferences before results return.
- [x] Add cancellable suggestions and searches so stale requests cannot replace current results.
- [x] Add network/presence/sort filters and incremental “Load More” pagination.
- [x] Return cash-table and tournament context without per-player N+1 requests.
- [x] Add live presence reconciliation and contextual profile/watch actions.
- [x] Add an in-context visibility editor backed by owner-only preference RPCs.
- [x] Pass typecheck, zero-error targeted lint, and all 58 phase/regression tests.

## Phase 4 of 7 — Join Club

- [x] Add one atomic/idempotent code, slug, UUID, application, and invitation RPC.
- [x] Roll a newly-created membership back when referral redemption is invalid.
- [x] Add server-side preview/join enumeration limits and per-user transaction locks.
- [x] Synchronize pending/approved/rejected application lifecycle from membership status.
- [x] Add confirmation preview before a membership or request is created.
- [x] Accept numeric codes, `/invite` links, `?c=` deep links, clipboard text, and QR images.
- [x] Persist interrupted joins and safely replay the same request after auth/network recovery.
- [x] Add visible pending status and self-service application cancellation.
- [x] Route the modal, invitation page, discovery page, and shared store through the atomic service.
- [x] Pass typecheck, zero-error targeted lint, and all 84 phase/regression tests.

## Phase 5 of 7 — Shared Trust Layer

- [x] Add server-authoritative feature flags with deterministic staged rollout.
- [x] Enforce Create, Find, and Join flags in both the action bar and database RPCs.
- [x] Add privacy-safe, allowlisted telemetry with duration and outcome reporting.
- [x] Add a service-role daily health view and an operator incident/rollback runbook.
- [x] Replace permissive audit-log policies with actor/staff read-only access.
- [x] Add database mutation audits for clubs, memberships, and player-search privacy.
- [x] Add predictable Escape behavior without bypassing unsaved-create confirmation.
- [x] Upgrade React Router to a patched release and remove all known npm audit findings.
- [x] Pass typecheck, zero-error targeted lint, and all 36 trust/phase regression tests.

## Phase 6 of 7 — Casino Realism and Performance

- [x] Extract the action bar into a reusable semantic control component.
- [x] Replace generic glyphs with distinct Create, Find, and Join control icons.
- [x] Add machined-metal depth, active feedback, keyboard cues, and disabled status.
- [x] Preserve 70px mobile targets with no horizontal overflow at 390px.
- [x] Add increased-contrast support to the action bar and all three feature dialogs.
- [x] Preserve reduced-motion handling across the action bar and all dialogs.
- [x] Generate 320px/640px WebP Club Arena emblems and wire responsive header loading.
- [x] Add executable gzip and identity-media performance budgets.
- [x] Verify desktop and mobile renders in a real browser and save handoff screenshots.
- [x] Pass production compilation, performance budgets, typecheck, zero-error lint,
      73 phase/law tests, and 104 focused visual/header tests.

## Phase 7 of 7 — End-to-End Verification and Release Readiness

- [x] Give all four migrations unique full-length versions in dependency-safe order.
- [x] Parse all 77 new PostgreSQL statements with a PostgreSQL-native parser binding.
- [x] Add dynamic action routing, rollout disablement, dialog mount/Escape, Join recovery,
      and Find mapping interaction tests.
- [x] Persist Create's request UUID across drafts/retries and make logo upload replay-safe.
- [x] Preserve logo assets after ambiguous network outcomes; clean only definitive rejections.
- [x] Run the complete production build and re-check all feature/media gzip budgets.
- [x] Pass repository-wide typecheck, lint with zero errors, npm audits with zero findings,
      `git diff --check`, and the complete 9,088-test suite with zero failures.
- [x] Preserve branch provenance evidence and explicitly block deployment from this stale checkout.
