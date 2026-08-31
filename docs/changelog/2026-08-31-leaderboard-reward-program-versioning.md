# 2026-08-31 — Leaderboard Reward Programs Become Reproducible

Phase 2 replaces the wizard's mutable prize-plan history with an append-only,
period-bound publication contract.

## What Was Wrong

- A save overwrote the only settings row, so nobody could prove which prizes
  were advertised for a completed week or month.
- A mid-period edit immediately changed the prize badges on the active board.
- Two owner tabs could overwrite each other without a conflict.
- Retrying after a lost response had no caller-owned publication identity.
- The page read the latest settings row instead of the program that applied to
  the selected canonical period.

## What Phase 2 Adds

- Immutable numbered program versions with a content hash, publisher, funding
  owner snapshot, publication time, and explicit superseded version.
- Server-derived union promo-wallet ownership for affiliated clubs and club
  promo-wallet ownership only for standalone clubs.
- Weekly and monthly activation at their next canonical UTC boundaries. An
  edit can never rewrite standings already in progress.
- An optimistic `expected_version` guard and caller-owned operation UUID. A
  stale tab fails visibly; a lost-response retry returns the original version.
- A period resolver used by the live page for prize badges, including
  historical boards. The newest owner plan is no longer treated as the rule
  for every period.
- A separate idempotent data migration that preserves any already-published
  mutable settings as version 1.
- An owner review screen that states the next-period boundary and distinguishes
  publication from chip movement.

## Safety Boundary

This phase does not debit a union or club promo wallet, credit a player, write
a payout, or reactivate the retired payout function. Automated settlement is a
later phase because it requires an independently proven, idempotent batch
transfer with complete debit/credit ledgers and conservation checks.

The audit table deliberately stores raw club, union, and publisher IDs instead
of foreign-key cascades. An append-only trigger must never block an unrelated
club, union, or profile deletion elsewhere in Club Arena.

## Verification

- Targeted component, service, migration, and safety contracts.
- TypeScript and targeted ESLint.
- Both migrations compiled together inside a production transaction and were
  rolled back.
- A transaction-wrapped production behavior probe published and retried a
  union-owned program, rejected a stale version and unauthorized actor,
  rejected mutation of the published row, and verified current-versus-next
  period resolution before rolling every test row back.
- Full regression, build, production apply, deployment, and live artifact
  results are recorded in the Phase 2 release summary after completion.

Money movement: **none**.
