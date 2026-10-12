# Horse Phase 7A: single-board utility and original-input evidence

Phase 7A repairs three demonstrated defects in the existing Horse tournament utility path:

- Hypothetical single-board tournament awards now use the existing whole-chip pot allocator, including button-ordered odd chips. The ordinary caller previously omitted this contract and modeled fractional tie awards.
- A seat that acted before the Horse but still owes a re-raised price participates in the response model. Static opening order previously omitted that seat.
- An ICM workspace that started with at most ten positive behind stacks can use its bounded common-clock Monte Carlo estimator when awards restore an eleventh live stack. It previously returned exact zero with zero stated error for that candidate.

The existing utility ledger now commits to its actual economic inputs and sampled outcomes and identifies the response formula as uncalibrated. Opponent inputs identify the actual family/size or pooled statistics and recency counters. Historical observation windows and table/format/exact-variant isolation remain explicitly unavailable; this change does not invent those facts or certify GTO strength.

The worker attaches the original private read-frame digest to FAST and DEEP results. Response admission validates the bounded new receipt. The execution witness preserves a compact immutable commitment, and the private journal reader checks the same commitment and original read frame against the accepted action. Retained legacy receipts remain readable without being promoted to new provenance.

Regression protection stays in the existing Phase 7 utility, ICM, worker response, execution-witness and journal suites, plus the new small evidence owner's suite. Independent arithmetic reproduces the three defects before their repairs. The ordered plan and remaining publication/natural-use gates are in [the Phase 7 build plan](../horse-brain-phase7-build-plan-2026-09-30.md). Phase 7B multi-board sampling remains separate and unstarted; this source record is not a publication certificate.
