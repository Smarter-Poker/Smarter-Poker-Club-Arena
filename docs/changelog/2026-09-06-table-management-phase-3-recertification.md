# Table Management Phase 3 Deep Recertification

## Scope

Phase 3 of 6 was re-audited from the browser command call sites through the
installed production functions. The review covered command identity,
per-game serialization, stale-contract rejection, durable receipts,
dropped-response recovery, lifecycle helper grants, occupied-game guards,
registered-tournament guards, row evidence, and shared UUID behavior.

## Defects Found

- The command gateway serialized on the game row but not on the command UUID.
  Concurrent reuse of one UUID across different games could lock two different
  rows and race at the receipt primary key. The losing request leaked a raw
  unique-violation instead of returning `idempotency_conflict`.
- The browser accepted any error-free object as a successful command response.
  A malformed or partial response could emit a success event without a matching
  terminal receipt.
- A thrown RPC promise bypassed the dropped-response reconciliation path, which
  only handled returned PostgREST error objects.
- Unknown receipt statuses defaulted to `succeeded`, presenting incomplete or
  incompatible evidence as a confirmed operator action.
- Row command state used only the UUID. A cash table and tournament that shared
  one UUID disabled and relabeled each other's controls.
- The painted disabled state did not close the event-loop window before React
  rerendered. A rapid same-row double tap could start a second command with a
  new command UUID.
- The original database law read only the original migration, so a later
  redefinition of the command gateway could silently remove Phase 3 while its
  tests remained green.

## Repairs

- Added a transaction advisory lock derived from the global command UUID before
  the first receipt lookup. The existing canonical game-row lock remains in
  place to order distinct commands for the same game.
- Required terminal receipt evidence before the client accepts a receipt-bearing
  command response: matching UUID, explicit terminal status, boolean outcome,
  and positive before/after contract versions.
- Routed thrown requests, malformed success responses, and incomplete receipts
  through the same bounded reconciliation and identical-UUID retry path.
- Made receipt mapping fail closed to `processing` unless the database explicitly
  reports `succeeded` or `rejected`.
- Changed in-flight UI identity to `(game_kind, game_id)` and added a synchronous
  per-game claim that rejects a second tap before React paints disabled state,
  while still allowing independent games to be managed concurrently.
- Added chronological migration coverage that certifies the latest installed
  command definition and the one authenticated mutation door.

## Production Proof

- Migration `20260906132537` was applied and recorded in the production
  migration ledger.
- The installed gateway contains the UUID advisory lock before receipt lookup.
- `authenticated` can execute the command gateway and cannot execute either
  lifecycle implementation helper.
- Transactional production probes returned durable `players_seated` and
  `players_registered` rejections, replayed the identical request, returned
  `idempotency_conflict` for cross-game UUID reuse, and left no probe receipts
  after rollback.

Full client, server, build, merge, and published provenance are recorded in the
Phase 3 completion summary after the automated release chain finishes.
