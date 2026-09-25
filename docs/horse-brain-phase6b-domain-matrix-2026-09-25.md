# Horse Brain Phase 6B: the tournament preflop atlas states its domain

Date: 2026-09-25. Branch `agent/codex-horse-brain/phase6b-tournament-atlas-domain-20260925`,
based on `f1d98dd753`. Repository code and tests only. No migration, no client change, no
database access, no live or natural evidence, no publication.

This document is the executed-coverage matrix for Phase 6B slice 2 of 4. It records what
was tested on this exact revision and names every exclusion. It does not claim solver,
GTO or calibration coverage, and it does not certify any unobserved cell.

## What the descriptor is

`server/src/engine/HorseTournamentPreflop.ts` now exports a deep-frozen
`TOURNAMENT_PREFLOP_ATLAS_DOMAIN` built from the same arrays the lookup reads (no second
copy), plus `canonicalJson()` and the literal `TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST`.
The descriptor is read-only evidence. It adds no cells, changes no shift, changes no
action sampling, and it is not a policy-authority token. Consumers keep calling the
existing functions.

| Field                   | Value on this revision                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`         | 1                                                                                                                                                                                                                                         |
| `atlasRevision`         | `horse-tournament-preflop-v1`                                                                                                                                                                                                             |
| `implementation`        | `phase6-v1` (the cell-string prefix)                                                                                                                                                                                                      |
| `gameFamilies`          | supported `['nlh']`; labeled `['omaha', 'other']`                                                                                                                                                                                         |
| `contextStatuses`       | baseline `['complete']`; fallback `['incomplete', 'warming', 'stale']`                                                                                                                                                                    |
| `tableSizes`            | 2 to 10 dealt seats                                                                                                                                                                                                                       |
| `positionsBySize`       | the clockwise ring per size, SB and BB first, BTN last above two-handed                                                                                                                                                                   |
| `positions`             | UTG, UTG1, UTG2, UTG3, MP, HJ, CO, BTN, SB, BB                                                                                                                                                                                            |
| `branches`              | the eleven named preflop branches                                                                                                                                                                                                         |
| `anteTypes`             | none, per_player, big_blind                                                                                                                                                                                                               |
| `depth`                 | anchors 2..100 (17), minBB 2, maxBB 100, belowMin `clamp_to_2_approximation`, aboveMax `clamp_to_100_approximation`, nonFiniteHelperDefaultBB 20, shiftRoundingDecimals 5, velocityUrgencyRoundingDecimals 3                              |
| `m`                     | boundaries 1, 5, 10, 20, 40; six zones; hysteresis 0.5 M; multi-zone jump bypasses hysteresis; players clamp 2..10; effective scale denominator 10; velocity urgency divisor 2; projection gate maxMinutes 3, minMultiplierExclusive 1.15 |
| `fallbackPrecedence`    | invalid_coordinate, unsupported_variant, incomplete_context                                                                                                                                                                               |
| `totalValidCoordinates` | 215,424 = 384 (sum of n squared, n in 2..10) x 3 x 11 x 17                                                                                                                                                                                |

Domain digest (sha256 of `canonicalJson(TOURNAMENT_PREFLOP_ATLAS_DOMAIN)`):

```
4a8918a0f015e9e96b31dc63e0a7ab45eca503698c514c82f55627bec7864305
```

The digest is pinned as a literal in the source and recomputed by
`HorsePhase6TournamentDomain.test.ts`. Editing the domain requires editing that literal on
purpose.

Correction to the recon proposal: the depth bracket weight is not rounded anywhere, so the
proposed `weightRoundingDecimals` field was not adopted. The descriptor states what the
code does: shifts round to five decimals and velocity urgency to three.

### Domain axes stated outside the descriptor (B-T1)

These are bound by existing guards, not by the descriptor, and are recorded here so an
omitted dimension is never mistaken for a calibrated one:

- Tournament context: only a `schemaVersion: 1` tournament snapshot that carries an M state
  reaches the lookup (`HorseLogic.ts` Phase 6 block). Cash tables never do.
- Street: preflop only. Postflop never consults the atlas.
- Betting structure and family: `HorseLogic.ts` maps Omaha to `omaha`; two-card, full-deck,
  non-fixed-limit games to `nlh`; every other shape (short deck, pineapple, fixed limit) to
  `other`. Only `nlh` yields nonzero baseline shifts. NLH evidence qualifies no other family.
- Pot, rake, objective (bounty, satellite, ICM) and special configurations (straddle) are
  not coordinates of this heuristic; they are handled by other layers and are outside this
  atlas's qualified coverage.
- A valid algebraic coordinate is not a claim that a real betting history reaches it, nor
  that every format launches ten seats.

## Source identity at this commit

`git hash-object` of the owning files:

| File                                               | Blob                                       |
| -------------------------------------------------- | ------------------------------------------ |
| `server/src/engine/HorseTournamentPreflop.ts`      | `6209a4aba8f59d22fefd3c7baf53f0a5dea33b82` |
| `server/src/engine/AnteMath.ts`                    | `833fb44e097b86cd513eff29c39ecd19dcd54d97` |
| `server/src/engine/HorsePreflop.ts`                | `8060e8e9706ba6ab6732bb0acf3bcca980476b25` |
| `server/src/engine/HorseLogic.ts`                  | `e4c97effec996db20085c37ba7306d7da3ab0c89` |
| `server/src/engine/HorsePhase6Attribution.ts`      | `9560d847496f95f80cd244aa2aff20327fddbf96` |
| `server/src/engine/ServerTableEngineTurns.ts`      | `c165f3d627b05a335b93d2e62fd8149e3c030b75` |
| `server/src/engine/horseDecision/workerRuntime.ts` | `63e72056027bd33e6cd7851e8aec023b478c16f4` |

Only `HorseTournamentPreflop.ts` changed among these seven. `AnteMath.ts`, `HorsePreflop.ts`,
`HorseLogic.ts`, `HorsePhase6Attribution.ts`, `ServerTableEngineTurns.ts` and
`workerRuntime.ts` are unchanged from `f1d98dd753`.

## Preservation evidence (B-T3)

The descriptor stays descriptive and off the action path. The only source edits inside
decision code hoist the literals the lookup already used (`[1, 5, 10, 20, 40]`, the zone
names, `0.5`, `2`/`10`, `20`, `100_000`, `1000`, `'phase6-v1'`) into module constants with
identical values (`10 ** 5` is exactly `100000`; `10 ** 3` is exactly `1000`), and freeze the
existing arrays. No shift constant, branch precedence, sampling call or candidate flag moved.
Evidence: the existing 43 tests in `HorsePhase6Tournament.test.ts` (including the shadow
replay controls and the one-chip-either-side action stability) pass unchanged; the 215,424
totality loop, now iterating the descriptor, still counts 215,424 with no invalid cell; the
hand-derived shift oracle in the new file matches the documented formula at every branch.
New wire, digest or runtime-metadata checks: not applicable with reason, because no runtime
field was added and the v2 receipt already pins `atlasRevision`.

## Executed coverage matrix

Status vocabulary: `executed on exact revision` means the named Vitest test ran green on
this checkout; `source assertion identified` means the behaviour is asserted from source
text only. Nothing here is `published containing revision` or `naturally observed`.

| Recon case                                        | What is pinned                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                                      | Status                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. Hysteresis at boundaries 1, 5, 10, 20, 40      | From the lower zone: b, b+0.49 stay; b+0.5, b+0.51 improve. From the upper zone: b-0.01, b-0.5 stay; b-0.51 worsens. Raw boundary without a prior.                                                                                                                                                                                                                                                              | `HorsePhase6TournamentDomain.test.ts` "holds the half-M deadband on both sides of boundary" (5 rows)       | executed on exact revision                                            |
| 2. Outer zones and unknown prior                  | dead at 1.2 stays dead; blue at 39.6 stays blue; unknown prior returns the candidate; NaN and negative are dead; two-zone jumps bypass in both directions                                                                                                                                                                                                                                                       | same file, "keeps the outer zones sticky"                                                                  | executed on exact revision                                            |
| 3. Projection gate boundary, HorseLogic           | (3, 1.16) fires, (3, 1.15), (3.01, 1.16), (2, 1.15), null, undefined do not; branch flips reshove versus cold_call with hero BTN, raiser CO, six dealt, 60bb effective                                                                                                                                                                                                                                          | same file, "HorseLogic re-zones the classifier branch only inside the gate" (8 rows)                       | executed on exact revision                                            |
| 3. Projection gate boundary, HorsePreflop         | Same rows through `decidePreflopV7`: jam inside the gate, never jam outside it, unopened button 27bb, projected 9bb                                                                                                                                                                                                                                                                                             | same file, "HorsePreflop applies projected M and depth only inside the gate" (8 rows)                      | executed on exact revision                                            |
| 4. Velocity                                       | 0 for null, 0, negative, NaN minutes and for a cheaper next level; 2 M/min saturates urgency at 1, 4 M/min is identical, 1 M/min halves; 2/3 M/min rounds urgency to 0.333 and the open shift to -0.04 at five decimals; urgency touches only open and jam; a warming fallback cell still records `velocity=1` with zero shifts                                                                                 | same file, "Phase 6B velocity urgency" (3 tests)                                                           | executed on exact revision                                            |
| 5. Covering stacks                                | Equal stack included; tied covers ordered by userId; empty id and zero stack excluded; hero largest gives no cover and null M; zero hero stack                                                                                                                                                                                                                                                                  | same file, "Phase 6B covering stacks" (2 tests)                                                            | executed on exact revision                                            |
| 5. Sit-out excluded from cover, counted in census | Worker refuses an M snapshot that lists a dealt sit-out as cover and accepts the canonical one with `playersAtTable` 3 and effective scale 0.3                                                                                                                                                                                                                                                                  | `horseDecision/workerRuntime.test.ts` "a dealt sit-out counts in the census but never as a covering stack" | executed on exact revision (worker boundary)                          |
| 5. Turns roster rule                              | `dealtPlayers = players`, `actionablePlayers` excludes sit-outs, `playersAtTable = max(2, dealt)`, cover from actionable, `stackBehind = player.stack`                                                                                                                                                                                                                                                          | domain test "keeps the table-engine sit-out rule on record"                                                | source assertion identified (not executed: Turns is not instantiated) |
| 6. Short-handed transition 9 to 6 to 2            | Per-player ante orbit 240/210/170, real M 20 / 22.86 / 28.24, effective 18 / 13.71 / 5.65, zones yellow/yellow/orange, projected depth 48 throughout; authored-total BBA orbit 250 at every census with effective 18/12/4; per-seat BBA 350/300/200; census clamp 1, 0, NaN to 2 and 11 to 10, 9.9 floors to 9                                                                                                  | domain test "rescales orbit cost and effective M" and "clamps the dealt census"                            | executed on exact revision                                            |
| 7. Sparse seats and dealer wrap                   | [1,4,7,9] with dealer 9, 4 and 1; [2,5,8] dealer 5; three-handed to heads-up on the same seats, both dealers; undealt hero, missing dealer, single seat give MP                                                                                                                                                                                                                                                 | domain test "labels sparse seat numbers" and "moves from three-handed to heads-up"                         | executed on exact revision                                            |
| 7. Dealt sit-out keeps its ring slot              | Five dealt with SB sitting out: hero CO, raiser HJ, tableSize 5, effective depth 40bb, branch reshove (yellow zone, hijack raiser), through real `HorseLogic.decide`                                                                                                                                                                                                                                            | domain test "keeps a dealt sit-out on the ring"                                                            | executed on exact revision                                            |
| 8. Endpoints                                      | 1.99, 0.5, 0, -5 clamp to 2; 100.01, 1e6, MAX_SAFE_INTEGER clamp to 100; NaN and both infinities give the 20 helper default; raw `coordinate.stackBB` 1.99 retained beside the clamped bracket in `observePhase6Lookup`; shifts at 1.99 equal shifts at 2, at 1e6 equal 100                                                                                                                                     | domain test "clamps finite depth" and "reports the raw coordinate"                                         | executed on exact revision                                            |
| 9. Literal shift oracle                           | 22 hand-derived rows covering all 11 branches at 20bb, nine-max, per-player; table widen at 6, 10 and 2 seats; ante none and big_blind; the 11bb interior bracket; three_bet_facing deep ramp at 40, 70 (weight 0.5) and 100                                                                                                                                                                                    | domain test "matches a hand-derived shift vector" and "widens with table size and ante type"               | executed on exact revision                                            |
| 10. Context routes, pure lookup                   | incomplete, stale, warming give incomplete_context with zero shifts and the exact cell string; complete control gives call 0.012, threeBet 0.008 on the same coordinate; omaha and other give unsupported_variant even when complete; precedence rows including invalid + omaha + stale                                                                                                                         | domain test "Phase 6B context routes" (first 6 tests)                                                      | executed on exact revision                                            |
| 10. Context routes, HorseLogic                    | Each of incomplete, stale, warming through real `HorseLogic.decide`: policy input status, labeled fallback, zero shifts, `phase6_route_atlas` and `phase6_atlas_fallback` counters, receipt reason incomplete_context, status unavailable, valid receipt; complete control reaches baseline; plo4 to omaha and short_deck to other take `phase6_route_variant_fallback` with receipt reason unsupported_variant | domain test "HorseLogic routes an NLH ... context", "complete NLH control", "HorseLogic maps ... family"   | executed on exact revision                                            |
| 10. Context routes, worker                        | incomplete, warming, stale through `harness(true)` real decisions return FAST_RESULT receipts with reason incomplete_context and zero shifts; complete control reaches atlas_evaluated; an Omaha tournament request returns unsupported_variant                                                                                                                                                                 | `workerRuntime.test.ts` "routes a real ... decision", "complete control", "Omaha tournament request"       | executed on exact revision                                            |
| 11. Immutability (B-T2)                           | `Object.isFrozen` to the leaves on the domain and eleven exported constants and on every `tournamentPositionsForTable(n)` result including NaN; push, reverse, index assignment on a held ring or anchor list throw; domain fields cannot be reassigned; detached copies do not move the lookup                                                                                                                 | domain test "freezes every exported constant" and "keeps the lookup unchanged"                             | executed on exact revision                                            |
| Domain and revision pin                           | Descriptor field-by-field against independent literals; ring length equals size for every size; digest recomputed; canonical serialiser properties; the existing totality loop iterates the descriptor and asserts 215,424 equals `totalValidCoordinates`                                                                                                                                                       | domain test "Phase 6B atlas domain descriptor"; `HorsePhase6Tournament.test.ts` totality loop              | executed on exact revision                                            |
| Mismatch refusal                                  | A real v2 receipt is refused when `atlasRevision` is changed, when `tableSize` becomes 11, and when `anteType` or `branch` leaves the domain; the lookup on an invalid coordinate still answers zero shifts                                                                                                                                                                                                     | domain test "refuses a receipt whose atlas revision or coordinate leaves the pinned domain"                | executed on exact revision                                            |

## Named exclusions

- `ServerTableEngineTurns.ts` is not instantiated by any of these tests. Its sit-out roster
  and chips-behind rules are source assertions here; their executable counterpart is the
  worker's canonical M check.
- `HorseLogic.ts` and `HorsePreflop.ts` keep their own `3` and `1.15` gate literals; the
  descriptor's `m.projection` binds them by behaviour (16 executed rows), not by a shared
  symbol. Changing a consumer literal fails those rows; it does not change the digest.
- The totality loop proves the lookup is total over the declared coordinates and labels
  impossible pairs. It does not validate numerical strategy, calibration, game strength or
  whether a real betting history reaches a coordinate. Reachable-history coverage remains
  the small connected route set above plus the existing branch fixtures.
- Below-2bb and above-100bb depth is an approximation (a clamp to the endpoint). No
  calibrated deep-stack or micro-stack cell was invented; the tests assert the clamp.
- Unknown `anteType` or `branch` strings are not validated by the lookup (TypeScript types
  prevent them; an unknown ante type would receive the per-player widen). Only the receipt
  validator rejects them, and that rejection is executed above.
- No natural cohort, live route counts, controller acceptance, published containing
  revision or 6C/6D replay were produced. Missing cells stay unobserved.

## Code observations reconciled with the recon

- Confirmed and executed: heads-up with a dealer outside the dealt pair labels both seats
  BB. Unreachable from a complete table snapshot; recorded, not repaired.
- Confirmed by reading; validator refusal executed: the lookup does not validate branch,
  ante type, context status or family strings.
- Confirmed: `tournamentPositionsForTable(NaN)` answers a nine-ring while the lookup labels
  a NaN size `invalid-NaN`. Both asserted.
- Confirmed: HorseLogic takes `tableSize` from `tournament.playersAtTable` and the ring from
  the dealt census. The descriptor test asserts ring length equals size for every size; the
  worker enforces `playersAtTable === max(2, players.length)`; the lookup itself does not
  cross-check the two, which is left as observed.
- Recon line anchors moved by four lines around `tournamentPositionsForTable` (now :288)
  and `tournamentPositionForSeat`; everything else matched.
- Recon item 6 expected the two-handed per-player zone as red; at 5.65 effective M it is
  orange. The executed expectation is orange.

## Test counts

| Suite                                            | Before | After                                      |
| ------------------------------------------------ | ------ | ------------------------------------------ |
| `src/engine/HorsePhase6Tournament.test.ts`       | 43     | 43 (totality loop bound to the descriptor) |
| `src/engine/HorsePhase6TournamentDomain.test.ts` | none   | 58                                         |
| `src/engine/horseDecision/workerRuntime.test.ts` | 148    | 154                                        |

Affected run on this revision: `HorsePhase6Tournament`, `HorsePhase6TournamentDomain`,
`HorsePhase6Attribution`, `horseDecision/*`, `testing/horseRegression/*`,
`TournamentJamDepth`, `HorseCanonicalTournamentIdentity`, `TournamentBrainContext*`,
`HorsePhase7TournamentUtility`: 42 files, 1529 tests passed. `tsc --noEmit -p server` clean.
`check-no-emoji`, `check-ui-text` and `check-horses-are-players` pass.
