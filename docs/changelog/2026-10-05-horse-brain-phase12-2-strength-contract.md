# Horse Brain Phase 12, P12.2: one strength contract per Short Deck, Pineapple, FLH and FLO8 pack, locked before any measurement

`REMAINING_VARIANT_STRENGTH_CONTRACT` (`remaining-variant-strength-contract-v1`,
digest `d85d7569c31a1cd583a2397c2f598e448859ff66b417ba8e549ba00bcc6e19f1`,
pinned by a test) states what a strength run of each Phase 12 pack must
measure and show. Each pack (`short-deck-round1-v2`,
`crazy-pineapple-round1-v2`, `fixed-limit-holdem-round1-v3`,
`fixed-limit-omaha8-round1-v3`) has its own population, three held-out seeds
written before any run and used by nothing else (1220xxxx, 1230xxxx, 1240xxxx,
1250xxxx), matrix, pilot, regression margin and verdict; a pass for one never
certifies another. It locks when this merges; no held-out hand has been dealt.

What it keeps from Phases 10 and 11: cash after rake as the only objective it
can grant, at the published 1/2 row of each variant (Short Deck takes no
jackpot drop); five production styles; mood on in both arms on the deal-seed
clock; the primary gate (99% lower bound above 0), every held-out seed above 0,
every gating cell above a regression margin, the same exact interval and
guards, street families as diagnostics only. The tournament objective is
refused by name per pack; Pineapple has no tournament format at all.

What is new for Phase 12, in the contract:

1. Each pack measures the seat ceiling it supports as a sixth profile (Short
   Deck, Pineapple and FLH nine-handed, FLO8 eight-handed): these games are not
   locked at six seats, and FLH Classic defaults to nine.
2. FLH and FLO8 add the legacy 1,000 BB exposure the league and pack support,
   as a seventh profile and depth band.
3. The fixed-limit packs carry a fixed-limit margin, -4 bb/100 (two big bets
   per 100 hands), stated before any run; the no-limit packs keep -10.
4. The P10.3 `illegal_candidate` guard now covers Phase 12 in `HorseLogic`
   (offline only: candidate mode is refused live). Every shard counts the
   candidate proposals it refused (`illegalCandidates`) beside `changed`.
5. Pineapple discards go through the same seeded chooser and the real
   controller in both arms, are counted apart, and are never candidate changes.
6. Independent settlement for each variant (`RemainingVariantStrengthChecks.ts`:
   Short Deck order and wheel, Pineapple dead cards, FLO8 high and low halves).

Shard counts come from a design pilot on development seed 12101101 (288 to 324
pairs per profile, dispersion and time only, 15,256 hands, zero validity
failures): 120 jobs for Short Deck, 195 for Pineapple, 42 for FLH, 102 for
FLO8, all inside 25 minutes per shard and the 256-job ceiling; about 136
runner-hours in all at 2.5 times the pilot time.

Finding (pilot, development seed): the no-limit packs size wagers in cents
while the legalizer sizes cash wagers in whole dollars, so the new guard
refuses about one in seven no-limit candidate changes (Short Deck 133 of 831,
Pineapple 96 of 675; fixed limit 0). Named in the record; the pack is not
changed here.

Machinery: `runRemainingVariantStrengthShard`,
`remainingVariantStrengthEvaluate.ts` (npm
`horse:remaining-variant-strength-evaluate`), `phase12-strength-assemble.mjs`,
`horse-phase12-strength-league.yml` (manual, main only, one pack per dispatch)
and `HorsePhase12PolicyDigest.ts` (21 files from the policy's runtime import
closure, each with its reason; the 7 excluded closure files named with theirs;
a test recomputes the closure). PLO4 and Phase 11 outputs are byte-identical to
the base commit; the Phase 12 league's off and shadow arms are identical.

Tests: 62 new (contract 26, league 17, assembler and CLI 11, policy digest 3,
selection guard 5), all passing. Affected existing suites: 436 pass across 21
files (PLO4, Phase 10 and 11 contracts, leagues and assemblers, Omaha and
remaining-variant leagues, joint league, the remaining-variant policy, pack,
dimension, completion and deep suites, references and settlement, registry,
graph, the Phase 10 and 11 selection suites, Phase 11 authority). One existing test fails, on the
base commit and on origin/main alike, independent of this change: the
HorsePhase11Authority "null proof" still asserts that no Phase 11 completion
record exists, and #6134 committed three. Every pack stays shadow; nothing is
activated. The held-out matrix is not yet run.
Record: `docs/horse-brain-phase12-2-strength-contract-2026-10-05.md`.
