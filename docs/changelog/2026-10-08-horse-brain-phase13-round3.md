# Horse Brain Phase 13 Round 3: The Joint Owner Prices Responses The Population Makes

The round-2 joint response model (`jointCallProbability`) read a present-board strength as though it were an equity and predicted far more folds than the horse population makes (NLH turn: per-opponent continue 0.24 predicted, 0.83 realized), so the candidate turned checks and calls into wagers and lost 92 to 953 bb/100 after rake on the development seeds, as on the October 6 held-out matrices.

Round 3 (`joint-action-response-round3-v1`):

- `JointResponseCalibration.ts`: continue and raise frequencies per variant and street, a logistic fit of every horse response facing a price in the P13.2 paired league on development seeds only; each responder's strongest sampled hands (ordered by runout strength) continue and raise.
- The bounded raise tree prices the flop as well as the turn and river.
- Selection keeps the baseline unless a row's paired edge over the baseline row on the same samples clears two paired standard errors by 0.1 big blind, and never acts facing a wager; a cash decision facing a wager is decided without pricing.
- The round-2 pack is kept as a comparison identity. The P13.2 contract changes only the candidate pack identity.
- `server/src/scripts/jointResponseCalibration.ts`: the development-seed harness (refuses every held-out seed).

Development seeds, cash after rake, horse population: NLH -663.01 bb/100 in round 2, +10.63 and +39.31 on two seeds in round 3; every variant's round-3 point estimate is positive on the confirmation seed. Nothing is selected: every Phase 13 selection stays `null` until the held-out matrix and the human-population check qualify a variant. Record: `docs/horse-brain-phase13-round3-2026-10-08.md`.
