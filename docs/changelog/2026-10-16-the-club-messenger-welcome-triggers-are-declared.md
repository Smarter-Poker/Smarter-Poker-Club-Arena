# The Club Messenger Welcome Triggers Are Declared (2026-10-16)

Migration `20261016104521_the_club_messenger_welcome_triggers_are_declared.sql` (held draft, owner installs).

## What Fired

`UndeclaredTriggerOnAMoneyTable` (critical, SMS) from 04:06 UTC: two undeclared triggers on `club_members`, `capture_club_messenger_admission` and the deferred `deliver_club_messenger_welcome`.

## Who Created Them

Migration `20261016033645` (`club_messenger_welcome_and_verified_relationships`), recorded with `created_by = 'antigravity_sql_push:v4'` about 04:05 UTC. It is an r5-date install that is not in this repository, so `scripts/ci/check-money-trigger-declared.mjs`, which refuses exactly this in a repository migration, never saw it.

## What They Do

Neither reads or writes a balance, stack, ledger or money table. The capture trigger keeps one `club_messenger_admissions` row per membership. The deferred trigger sends the admitting agent's or owner's enabled welcome template once per admission as an ordinary Messenger message, honouring blocks, and records it in `club_messenger_welcome_deliveries`.

## The Fix

Both are declared in `ca_declared_money_triggers`, after the migration proves each name is bound to the reviewed function. Nothing to settle.

Regression: `scripts/ci/test-the-club-messenger-welcome-triggers-are-declared.py`, run by `.github/workflows/the-club-messenger-welcome-triggers-are-declared.yml` (7 checks, native PostgreSQL).
