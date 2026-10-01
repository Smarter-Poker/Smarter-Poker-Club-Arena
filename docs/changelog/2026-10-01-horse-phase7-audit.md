# Horse Phase 7: request-bound receipt admission (audit, October 1, 2026)

A line-by-line audit of the Phase 7 merges (#5660, #5662, #5672, #5677, #5688)
before Phase 8. The three demonstrated 7A defects are closed in the connected
caller: the ordinary caller supplies the whole-chip settlement contract, reopened
responders are priced through `HorseLogic.decide`, and an ICM workspace that
revives an eleventh live stack uses its Monte Carlo clocks and says so.

## Fixed

- **A Phase 7 receipt was admitted without being bound to its request.** Worker
  admission validated the receipt's shape only. A structurally valid sampler
  for another state or board count, a multi-board receipt with no physical joint
  acquisition (marginal draws), or evidence naming a player who is not in the
  request was accepted and committed into the execution witness.
  `horsePhase7EvidenceMismatch` in `horseDecision/responseValidation.ts`
  recomputes each binding from the request (the joint state key, board count,
  multi-board test and opponent roster) and the client refuses a mismatch by
  name, as it already does for Phase 6. The private journal reader applies the
  same binding. Legacy receipts without evidence keep no new authority.
- The response validator's outcome ceiling now reads the utility owner's
  `MAX_UTILITY_OUTCOMES` instead of a duplicated literal.
- The multi-board equity pass no longer builds a Phase 7 outcome collector that
  its own guard made unreachable; marginal per-board draws never were, and are
  not, Phase 7 samples. No behavior changes.
- Six named joint-acquisition refusals that had no test are pinned.

## Limitations, not defects

- `HorseTournamentUtility.ts` `settleSample` keeps its fractional branch for an
  input without a settlement contract. Both live callers supply the contract;
  the branch serves offline and historical callers only.
- The Phase 13 joint bridge in `HorseLogic.ts` prices without sampler
  provenance or observations. Its candidate mode is refused in live requests and
  shadow mode stores only a shadow receipt; admission now refuses such a
  receipt if it ever became the live decision.
- The preflop capture samples at most the deck-feasible opponent count; a larger
  Omaha field is refused as `invalid_input`, not priced.
- The journal reader checks the input commitment, not a recomputation of it.
