# Table Management Phase 3: Command Integrity

## Status

Phase 3 of 6 is implemented in source. It has not been deployed and its
Supabase migration has not been applied to the linked production project.

## What Changed

- Added `managed_game_command_receipts`, the durable receipt ledger for Table
  Management updates and closes.
- Added `fn_execute_managed_game_command`, the only authenticated command door.
- Required a client-generated UUID and the exact published contract version
  the operator reviewed for every command.
- Serialized commands on the canonical game row and rejected stale editors
  before any mutation could occur.
- Stored successful and rejected results in the same transaction as the game
  mutation, including the contract versions before and after execution.
- Made completed receipts immutable and prevented receipt deletion.
- Revoked authenticated access to the older update and close RPCs, which now
  remain private implementation functions behind the command gateway.
- Added bounded dropped-response recovery. The client checks the durable
  receipt and retries once with the identical UUID; it never polls and never
  creates a second command.
- Added governed receipt reads for the latest command on up to 500 games.
- Added contract-revision reconciliation so a receipt whose referenced version
  is missing is visibly marked as drift.
- Added command outcome, short receipt ID, and version transition evidence to
  every Table Management row.

## Integrity Laws

1. One command UUID represents one actor, fingerprint, game, action, payload,
   and expected contract version.
2. Reusing a UUID for different work returns `idempotency_conflict`.
3. Two commands for one game serialize on its canonical database row.
4. A command created from an old contract version is durably rejected without
   applying any part of its payload.
5. A successful or rejected receipt and its mutation outcome commit together.
6. Completed receipts cannot be changed or deleted.
7. A lost browser response is reconciled from the receipt before the UI reports
   failure.

## Verification

- Focused architecture and service tests cover command hashing, immutable
  receipts, authorization, stale-version rejection, concurrent replay,
  idempotency conflicts, dropped-response recovery, bounded retry, event
  emission, receipt mapping, and UI wiring.
- TypeScript, focused ESLint, Prettier, Title Case, painted-text, UI-text, and
  no-emoji checks pass.
- The migration parses as PostgreSQL SQL and PL/pgSQL.
- Full client tests, server tests, and production builds are recorded at the
  phase handoff after the final branch synchronization.

## Realtime Law

Successful commands continue to emit the existing explicit `TABLE_UPDATED`,
`TABLE_CLOSED`, `TOURNAMENT_UPDATED`, and `TOURNAMENT_CANCELLED` events. This
phase adds no polling, snapshot-diff gameplay path, or new realtime authority.

## Deployment

No production migration, push, merge, server deployment, or World Hub sync was
performed as part of this phase.
