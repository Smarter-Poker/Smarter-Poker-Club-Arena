# Table Management Phase 2 Recertification

## Finding

The published-contract system was present and wired into Table Management, but
its final guarantees were weaker than its description in four places:

- A unique `(game_kind, game_id, contract_hash)` constraint made an intentional
  A to B to A re-publication fail instead of recording version 3.
- Contract rows had browser writes revoked but no database trigger prevented a
  privileged maintenance path from rewriting or deleting history.
- The migration replay order restored a readiness definition that treated text
  blind and payout structures as JSONB. A rebuilt database could reproduce the
  earlier 42804 tournament-creation outage.
- Start readiness read the stored row before a combined update and checked the
  bank before the overlay writer locked it. A competing start could consume the
  bank between those steps. Satellite seat value and private-event funding also
  did not match the actual overlay writer.

## Repair

- Kept versions unique and hashes indexed, while allowing a non-consecutive
  contract document to be published again as a new immutable revision.
- Added an unconditional database trigger that refuses updates and deletes of
  published contract history, including privileged direct writes.
- Centralized readiness around the exact row snapshot being evaluated and used
  the total text/JSON array parser already proven in production.
- Made the start guard validate `NEW`, cover every transition out of registration
  into a downstream state, and lock the actual union bank or club treasury before
  it calculates readiness. Competing starts now serialize before either can be
  accepted.
- Counted satellite seat value in both the current event's guarantee and other
  live exposure, and aligned private or union-less tournaments with the club
  treasury used by the atomic overlay writer.
- Kept all helper functions private to triggers and service-role execution.

## Verification

- A dedicated chronological migration-law suite covers re-publication,
  immutable history, exact-`NEW` validation, bank serialization, safe JSON,
  satellite guarantees, funding-scope parity, grants, and installation asserts.
- SQL parsing, focused Table Management tests, TypeScript, lint, full client and
  server suites, production build, live migration application, merge provenance,
  and production provenance are recorded in the Phase 2 completion summary.
