# The Tournament Preflop Atlas States Its Domain

Date: 2026-09-25. Horse Brain Phase 6B, slice 2 of 4. One engine module and three test
files changed, two documents added. No migration, no client behaviour change, no action
path change, no database access, no publication.

## What was missing

The NLH tournament preflop atlas in `server/src/engine/HorseTournamentPreflop.ts` was total
over 215,424 coordinates and had a revision string, but nothing in the repository said what
its domain was in a form a test or a release record could read. The anchor grid, the rings,
the branches, the ante modes, the M zones and the fallback order were scattered literals,
some inline in the functions that used them, and none of the exported arrays were frozen.
The earlier suite also left eleven boundary and intersection cases open: hysteresis at four
of the five zone boundaries, the projection gate at equality and just outside it, velocity
saturation, equal and tied covering stacks, the short-handed orbit transition, sparse and
wrapping seat rings, a dealt sit-out's ring slot, endpoint clamping, a literal shift oracle,
the stale and incomplete context routes through the real consumers, and any runtime
immutability check.

## What changed

`TOURNAMENT_PREFLOP_ATLAS_DOMAIN` is now exported, deep-frozen, and built from the same
arrays the lookup reads. It names the revision, the implementation prefix, the supported and
labeled game families, the baseline and fallback context statuses, the sizes and rings, the
branches, the ante modes, the depth grid with its endpoint approximation stated as
approximation, the M zone boundaries and hysteresis, the projection gate, the fallback
precedence and the coordinate total. `canonicalJson()` serialises it with sorted keys, and
`TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST` pins the sha256 as a literal:
`4a8918a0f015e9e96b31dc63e0a7ab45eca503698c514c82f55627bec7864305`. Any domain edit is now a
deliberate two-line change. The inline M literals moved into shared frozen constants with
identical values; every exported array and the position table are frozen to their leaves.

`HorsePhase6TournamentDomain.test.ts` (58 tests) pins the descriptor field by field, the
digest, the freeze, the eleven missing cases with hand-derived expectations, the three
non-complete routes and the two unsupported families through the pure lookup, real
`HorseLogic.decide` and the real worker, and receipt refusal on a changed revision or an
out-of-domain coordinate. The existing totality loop now iterates the descriptor and asserts
its total. Five worker rows exercise the labeled statuses, the sit-out covering exclusion
and an Omaha tournament request through real decisions.

## What it does not claim

The totality loop and these tests do not validate numerical strategy, calibration, game
strength or natural reachability of a coordinate. Depth below 2bb or above 100bb is a clamp
to the endpoint and is described as an approximation, not a calibrated cell. NLH evidence
qualifies no other family. Nothing here is live, natural or controller-accepted evidence;
`docs/horse-brain-phase6b-domain-matrix-2026-09-25.md` lists every executed row and every
named exclusion.
