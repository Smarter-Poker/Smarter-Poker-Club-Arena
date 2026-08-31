# Requirements

## Shared

- CE-S1: Preserve all routes, permissions, handlers, deep links, and Master Bus contracts.
- CE-S2: Provide loading, success, empty, offline, retry, and recoverable-error states.
- CE-S3: Support keyboard-only use, focus trapping, reduced motion, 200% zoom, and mobile safe areas.
- CE-S4: Emit privacy-safe analytics and Sentry breadcrumbs for each workflow stage.
- CE-S5: Rate-limit abuse-prone operations and retain immutable audit events.
- CE-S6: Meet explicit bundle and image budgets.

## Create a Club

- CE-C1: Validate ownership eligibility, membership limit, and name availability before submission.
- CE-C2: Save and restore an unfinished local draft.
- CE-C3: Upload, validate, compress, crop, and safely store a club identity image.
- CE-C4: Support moderated AI logo generation with visible progress and cost controls.
- CE-C5: Create club, owner membership, settings, audit event, and idempotency record atomically.
- CE-C6: Continue into an actionable setup checklist after success.

## Find a Player

- CE-F1: Search only the caller's server-authorized scope.
- CE-F2: Support query cancellation, pagination, typo-tolerant matching, and indexed ranking.
- CE-F3: Filter by club, relationship, online status, role, and live table type.
- CE-F4: Update permitted presence in realtime and respect player visibility preferences.
- CE-F5: Expose relevant actions: profile, watch, message, invite, favorite, block, and report.

## Join a Club

- CE-J1: Accept five/six digit codes, full invite links, universal links, clipboard codes, and QR input.
- CE-J2: Preview the resolved club and its policies before joining.
- CE-J3: Resolve code, validate invitation, attribute referral, and create membership atomically.
- CE-J4: Represent requested, pending, approved, declined, expired, suspended, and already-member states.
- CE-J5: Rate-limit enumeration and invalid-code abuse without leaking private club data.

## Operations

- CE-O1: Provide dashboards/queries for failures, suspicious attempts, orphaned assets, and latency.
- CE-O2: Document recovery, ownership, retention, deletion, and rollout procedures.
- CE-O3: Release behind feature flags with an immediate rollback path.
