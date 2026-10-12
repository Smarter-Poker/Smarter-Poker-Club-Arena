# Horse Brain Phase 13 P13.2: one strength contract per variant for the joint multiway owner, locked before any measurement

`JOINT_STRENGTH_CONTRACT` (`joint-strength-contract-v1`, digest
`a036e702e7659334a2c531f8bf90fb5e3a852686028fad47f182e486b57bb754`, pinned by a
test) states what a strength run of the joint multiway owner must measure and
show, separately for each of the nine variants. Each domain is
`<variant>-cash-joint-multiway-after-rake-horse-population`. It locks when this
merges; no held-out hand has been dealt.

- Candidate: `phase13Joint: 'candidate'` at the hero seat (domain
  `joint-multiway-round1-v4`, response `joint-action-response-round2-v1`).
  Reference: the same hand with `phase13Joint: 'off'`, the action live tables
  play today. Every earlier phase is off in every seat, as live.
- Profiles: three dealt, the cash seat ceiling (four dealt for PLO6), six-max
  at 40, 100 and 200 BB, one-, two- and three-board bomb hands, and 1,000 BB
  for FLH and FLO8. Diamond NLH is a named exclusion with its reason.
  Tournaments are refused by name per variant.
- Gates as Phase 12: pooled 99% lower bound above 0, every held-out seed above
  0, every gating cell (profiles, positions, depth bands, board counts) above
  -10 bb/100, or -4 for FLH and FLO8. Same z and interval guards.
- Three held-out seeds per variant, in a new 132 V K xxx series, written before
  any run and refused everywhere else.
- A candidate the guard refuses (`illegal_candidate`, `earlier_phase_applied`)
  is a software validity failure for its shard, not a strength gate. Work
  budget, branch and sample refusals are counted as diagnostics.
- New: the shard runner, the independent multiboard checks, the CLI
  (`npm run horse:joint-strength-evaluate`), the assembler
  (`server/scripts/phase13-strength-assemble.mjs`, 16-key qualification file)
  and the manual workflow `horse-phase13-strength-league.yml`.
- Design pilot on a development seed: 21,318 hands, zero validity failures,
  zero guard refusals. Matrices: 69 to 192 jobs per variant (1,209 in all),
  each shard about an hour on a hosted runner, each variant about 2 to 3 hours
  at 20 in parallel.
- Stated plainly: for every variant but FLH the hosted budget leaves the
  planned intervals wider than the margin, so only a large real edge can
  qualify. Shortfall of power, not of validity.
- `HorsePhase13PolicyDigest.ts` is a stub with the agreed exports until the
  P13.3 version lands.
- Earlier phases unchanged: every earlier development league and strength
  shard hashes identically before and after.

Record: [horse-brain-phase13-2-strength-contract-2026-10-06.md](../horse-brain-phase13-2-strength-contract-2026-10-06.md).
