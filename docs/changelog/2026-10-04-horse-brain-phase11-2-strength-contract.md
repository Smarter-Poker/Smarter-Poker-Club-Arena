# Horse Brain Phase 11, P11.2: one strength contract per PLO5, PLO6 and PLO8 pack, locked before any measurement

`OMAHA_VARIANT_STRENGTH_CONTRACT` (`omaha-variant-strength-contract-v1`,
digest `0e58a56ab8d123e32d474f23f154e4026a9a2f1a6119b06e449b2a3039c10326`,
pinned by a test) states what a strength run of each Phase 11 pack must
measure and show. Each pack (`plo5-high-round1-v2`, `plo6-high-round1-v2`,
`plo8-split-round1-v2`) has its own population, three held-out seeds used by
nothing else, matrix, pilot and verdict; a pass for one never certifies
another. It locks when this merges; no held-out hand has been dealt.

What it keeps from Phase 10: cash after rake as the only objective it can
grant, at the published 1/2 row of each variant (PLO6 takes no jackpot drop);
six-max tables, five production styles; the same three gates (primary 99%
lower bound above 0, every held-out seed above 0, every gating cell's lower
bound at least -10 bb/100) with their reasons; the same exact interval and
guards. The tournament objective is refused by name per pack, outside the
cash reasons.

What it changes from Phase 10, in the contract rather than as a footnote:

1. Street families are reported as diagnostics, not gates (a contribution cell
   cannot fail at -10, and a conditional one cannot be planned). The 14
   gating cells per pack (5 profiles, 6 positions, 3 depth bands) are all
   effective.
2. Mood is on in both arms, on a decision clock taken from the deal seed and
   identical in both arms. The other harness-versus-live differences (style
   modifiers, HorseMind history, the fixed policy clock, the second look, the
   single candidate seat) are named limits, and P11.3 admission must also see
   natural completion-share evidence.

Shard counts come from a design pilot on development seed 11101101 (576 pairs
per profile, dispersion and time only): 243 jobs for PLO5, 243 for PLO6, 114
for PLO8. PLO6 shards run about 28.5 minutes rather than 25 because a GitHub
matrix holds at most 256 jobs.

Machinery: `runOmahaVariantStrengthShard`, `omahaVariantStrengthEvaluate.ts`
(npm `horse:omaha-variant-strength-evaluate`), `phase11-strength-assemble.mjs`,
`horse-phase11-strength-league.yml` (manual, main only, one pack per
dispatch) and `HorsePhase11PolicyDigest.ts` for P11.3. The shared PLO4 league
gained default-off, variant-keyed options only; PLO4 outputs are byte-identical
to main and the PLO4 contract digest is unchanged.

Tests: 46 new (contract 23, league 13, assembler and CLI 10); the existing
PLO4, Phase 10 assembler, Omaha variant, remaining-variant and joint league
suites pass unchanged (142). Every pack stays shadow; nothing is activated.
Record: `docs/horse-brain-phase11-2-strength-contract-2026-10-04.md`.
