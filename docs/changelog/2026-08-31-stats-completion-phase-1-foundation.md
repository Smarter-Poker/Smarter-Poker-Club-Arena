# Stats Completion Phase 1: Foundation

Phase 1 introduces the versioned Stats access and truth boundary.

## Changes

- Captures previously external production index and rake definitions in a normal migration.
- Revokes browser access to legacy arbitrary-target overview and notable-hands RPCs.
- Adds owner-asserting v2 browser RPCs with explicit scope, source-quality and coverage metadata.
- Removes the incompatible `player_stats` fallback from the selected-range page.
- Prevents cross-profile routes from reading or hydrating all-club financial Stats.
- Removes the fabricated leak-analysis engine route and every client success claim attached to it.
- Adds a versioned metric dictionary and cache namespace.
- Adds contract tests for authorization, reproducibility, metadata and Assistant-route removal.

## Deliberately Deferred

Club selection is not simulated in Phase 1. It begins only after Phase 2 creates durable exact facts and Phase 3 can enforce club scope in the database. Until then, cross-profile Stats are explicitly private and owner reads are labelled All Clubs.
