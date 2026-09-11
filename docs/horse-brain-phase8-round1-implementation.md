# September 11 parity-backfill update

This historical implementation record is superseded for readiness by [the parity backfill manifest](./horse-brain-phase8-10-backfill-acceptance.md). Version 2 now includes a funded subsequent hand and resulting payout/bounty utility, with a conservative current/next-level envelope. It uses 16 outcomes spread across the 32 captured samples, retries all 32 when calibration requires them, and caps only the extra large-field future ICM estimate at 128 trials with its resulting wider uncertainty. Phase 7 retains its original work and estimator. Decision-local common-card facts and repeated resulting states are reused; the funded NLH rollout pays each pot with a fast score whose awards are differentially checked against production in 512 cases. Bounty ownership uses per-pot awards. Cooperative deadline stops retain the baseline; only actual wall-clock overruns count toward the three-overrun disable gate. The separate 32-eligible-without-a-fire sentinel remains in force. Original promotion evidence remains rejected. Read the final closeout for current publication status.

# Historical version 1 implementation and evidence contract

Status: unpromoted shadow candidate. The acceptance manifest remains the release
gate. A passing fixture or source merge does not complete Phase 8.

## Decision path

`HorseLogic` passes the accepted Phase 7 decision, canonical public state and
legal candidate menu into `HorseTournamentPostflop`. Confident Phase 7 overrides
keep ownership. Other complete-context NLH postflop decisions can receive a
counterfactual continuation evaluation. Shadow returns the original decision.
The live worker rejects an explicit offline `candidate` option.

The bounded continuation uses the first 32 common conditioned outcomes from
Phase 7. Each remaining street permits one opening wager and fold/call
responses. Each simulated actor reads only its own sampled cards and the board
available on that street. Response prices use canonical contestable pots.
Settlement uses the existing pot partition, payout, bounty and recovery-option
accounting. Chips are never added to payout utility. The Phase 7 ICM workspace
is reused within this decision and never serialized or cached across decisions.

This is a declared opponent-policy model, not equilibrium play. Its own-contact
strength scale, value boundary and half-pot opening policy are recorded in the
receipt. Sampling confidence does not establish that the opponent model is
calibrated. Tournament league evidence is required before any activation.

The separate future-game projection advances two hypothetical hands through
the current and supplied next blind level. Those levels are bounds when hand
duration is unknown, not a fabricated transition probability. It records blind
position, orbit cost, M velocity when timing exists, retained reshove capacity
and coverage. Sampled continuation receipts record short-stack collisions,
retained chips, coverage and loss of a full-blind raise. These resource measures
are not added again to payout value. A table-break forecast is unavailable
because the canonical snapshot does not carry an authoritative forecast.

The one-pair catastrophe bucket uses at least 200 starting big blinds, at least
25% of the starting stack in additional chips that live opponents can match,
and prior public postflop raise/all-in pressure from an opponent still in the
hand. Returned uncalled excess and pressure from folded players do not count.
Actual sets and better hands are excluded. A proposed
bluff jam also requires a real nut-flush blocker, enough modeled fold equity
to cover its investment and separated tournament utility. Missing value,
conflicting objectives, unsupported boards or uncertain continuation retain the
baseline with a reason.

The receipt records the policy constants, before/after utilities, shadow versus
applied action, continuation retention, model confidence, elapsed time and final
authoritative execution. Work stops at 4 ms to reserve room inside the 5 ms
component budget; policy bookkeeping has a separate 2 ms ceiling. Illegal
output, new critical commitment, three consecutive overruns, or 32 eligible
decisions without a firing produce a process-local disable signal. Restart
returns to shadow. It cannot activate a policy.

## Tournament league

The existing isolated, low-priority league process accepts `RUN_TOURNAMENT`.
Its equity load governor is disabled before imports. Tournament work rejects
a variable sample budget, so host contention cannot change paired sample sizes.
MTT, satellite, PKO and mystery fixtures start 18 entrants across balanced
six-seat tables. SNG starts six; Spin starts three. The declared benchmark
balances after each completed hand in stable entrant order. It uses a fixed
global deal-count blind schedule, identical across paired runs. Remote stacks
remain in the actual field used by ICM. This models a bounded tournament
population, not the production tournament scheduler.

Original entrant card slots and board slots are fixed by the pair seed and
global hand index, including after eliminations and table moves. Each hand is
played to completion through `HandController` and its authoritative action
menu. The controller deck override belongs only to this isolated instance;
opponent cards and the deck never enter the decision snapshot. Every settled
hand reconciles the whole field's chips.

PKO rollover is not paid immediately. Knockout claimants receive their payable
share once, and the residual funded bounty pool reaches the champion at
completion, matching the production completion receipt. Mystery fixtures use
an explicitly fixed chest value. Primary return includes only realized prize
and paid bounty; satellites use seat attainment, preserving fractional seat
value when equal-stack eliminations split the final award. Chip returns, busts, finishes,
deep commitments, prevented commitments, latency and failures are separate.
The regret reference is Phase 7 action utility, not an external solver.

Run from `server` with a new output directory:

```text
tsx src/scripts/horseTournamentEvaluate.ts --output=/absolute/new-fixture-directory
tsx --env-file=/approved/env src/scripts/horseTournamentEvaluate.ts --hydrate --output=/absolute/new-hydrated-fixture-directory
tsx --env-file=/approved/env src/scripts/horseTournamentEvaluate.ts --promotion --output=/absolute/new-promotion-directory
```

Promotion mode requires a clean commit, approved-project solver hydration and
the complete fixed 3-seed/6-objective/1,024-pair matrix. Each run is saved once;
the summary recomputes eligibility and pooled paired variance rather than
trusting a supplied promotion flag. Small fixtures carry the full possible
return-difference interval and cannot promote. Interruptions preserve partial
receipts and reject promotion. The command writes only local artifacts.
`--objective=spin --seed=8101101` selects a declared matrix shard without
changing its sample floor. A shard never establishes the full promotion gate;
combined receipts must share the same source hash, commit and solver identity.

## Verification map

- `HorsePhase8Replay.test.ts`: four recorded hero/public lines with an explicitly
  reconstructed field; the historical full tournament field was not captured.
- `HorsePhase8Tournament.test.ts`: shadow retention, boundaries, nut protection,
  blockers, all six objectives, side-pot exclusion, privacy, uncertainty,
  timing and automatic disable.
- `HorseTournamentLeague.test.ts`: matched whole tournaments, multi-table field,
  legal play/conservation, cancellation, forged receipts and promotion matrix.
- Existing Phase 5 T8, Phase 6, Phase 7, live worker, league transport and table
  execution suites remain required integration controls.

The tiny development fixtures do not establish improved tournament return.
Promotion-sized runs, protected publication, exact live provenance and natural
telemetry are separate outstanding acceptance gates until evidenced.
