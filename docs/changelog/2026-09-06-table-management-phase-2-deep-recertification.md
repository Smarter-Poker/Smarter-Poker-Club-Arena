# Table Management Phase 2 Deep Recertification

## Scope

Phase 2 was re-audited from the two squash commits on current `main`, through
the production database definitions and the rendered management board. The
review covered published-contract history, tournament readiness, guarantee
funding scope, creation and hamburger entry points, occupied-game guards,
targeted realtime refreshes, tests, merge provenance, and production
provenance.

## Defects Found

- Readiness recognized only `variant = 'satellite'`, while the overlay writer
  correctly recognizes a satellite by variant, `tournament_type`, or target
  id. Production contained 1,121 valid satellites missed by readiness, whose
  seat guarantees totaled 127,030 chips.
- The tournament publication trigger did not re-evaluate readiness when the
  satellite shape or private-versus-union funding scope changed.
- A later migration's installed contract-capture function still named the
  repeated-hash constraint that Phase 2 removed. New contract publications
  could therefore fail at runtime before recording any revision.
- The immutable tournament document omitted creator-selected payout,
  freeroll/add-on, legacy satellite, description, and mystery-bounty settings.
  Those promises were therefore absent from history and from the registered
  event guard's document comparison.
- The management board claimed to have one row mapper but its initial load
  duplicated that projection. Realtime reconciliation also keyed games only
  by UUID even though the database identity is `(game_kind, game_id)`.

## Repairs

- Made readiness use the same three-part satellite predicate as the atomic
  overlay writer for the current event, other live exposure, and completeness.
- Expanded the publication trigger to every operator-controlled field that can
  change the guarantee or its funding account.
- Replaced the stale capture body, serialized version allocation per logical
  game, and restored real A to B to A append-only publication.
- Expanded the canonical tournament contract to every creator-controlled
  promise and appended a corrective revision for all 114,589 production rows
  that differed. A full live recomputation returned zero current-contract
  mismatches across 114,594 tournaments.
- Routed initial, paged, and targeted reads through one mapper and used the
  composite game identity throughout merge and realtime reconciliation.
- Added regression coverage for all satellite forms, publication-trigger
  coverage, and a table plus tournament deliberately sharing one UUID.

## Proof Required Before Closure

Both corrective migrations are applied and recorded in production. Live
readiness matches all semantic satellites, the contract ledger matches every
current tournament, and destructive-action probes roll back. Focused and full
client/server suites plus the production build must still pass, and the
published `ca_sha` must equal the resulting squash commit on `main`.
