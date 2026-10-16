# Runbook: Horse Brain Phase 15 policy-ledger alarms

Rules: `infra/monitoring/alert-rules.yml`, group `horse-brain-phase15`. Series:
`poker_horse_policy_decisions_total{variant,outcome}` and
`poker_horse_reference_agreement_total{variant,format,agreement}`, counted once per validated
live FAST decision by `server/src/engine/HorsePolicyLedgerObserver.ts` on the engine main
thread. The daily report of the same counters is `horse_reference_agreement_daily`
(`SELECT * FROM ca_horse_reference_agreement(14)` as service role).

All six rules are `severity: warning`. None of them means a seat is stuck: every decision
they count was made and executed; they say the brain's policy ledger looks different from
its measured normal.

## HorseBrainPolicyLedgerSilent

Horses act (more than 30 a minute) but no FAST decision reached the ledger for 10 minutes.

1. `curl -s https://engine.smarter.poker/health` and read `liveHorseDecision`: `phase`,
   `completedJobs` (moving?), `lastError`.
2. `poker_horse_decision_fallbacks_total`: if every action is a check/fold fallback,
   `HorseDecisionFallbacks` owns the incident.
3. Otherwise the main-thread observer or the result path stopped counting. Read the engine
   log for `horse decision worker returned invalid policy receipt` and for errors around
   `observeHorsePolicyDecision`.

## HorseBrainVariantSilent

One variant decided more than 5 times a minute for an hour, then not at all for 15 minutes.
First check whether its tables simply closed (lobby, `poker_dealable_tables`, the variant's
tournaments finished). If tables of that variant are dealing, its decisions are failing
before the ledger: read the engine log for that variant's worker errors.

## HorseBrainOutsideDomainSurge / HorseBrainPolicyUnavailableSurge

The variant's registered pack refused (out of domain) or could not compute (unavailable)
far more of this hour's decisions than ever measured (out of domain max 18% a day, 20% per 5
minutes; unavailable max 0.75% a day, 1.9% per 5 minutes). Those decisions were made by the
reference brain, so play continued.

- Out of domain: compare what is being dealt (seat counts, stacks and antes, bomb pots,
  multiboard, spins) with the pack's domain. The reason is on each decision's
  `policyOwnership.reason` in the private journal.
- Unavailable: the pack's sampler failed or its evidence was missing (or an input was
  refused). Read `policyOwnership.reason` on the decisions in the private journal and the
  serving release's changes to the pack's sampler and evidence inputs. The packs'
  wall-clock work budget is retired by the 2026-10-16 policy bundle (separate branch); a
  `work_budget` reason can only come from a release that predates it.

## HorseBrainPolicyUnregistered / HorseBrainPolicyGraphUnrecorded

Both have a measured baseline of zero and fire above 5 in 15 minutes. A decision without a
registered policy owner, or without its sealed eight-node policy graph, is a code fault in
the release that is serving. A shadow-only receipt the client dropped for a failed binding
is counted as `outcome="shadow_receipt_dropped"` (with
`phaseN_shadow_receipt_binding_dropped` in the daily telemetry), not as unregistered:
read the variant label (`other` is a variant the registry does not know) and the release's
changes to `HorseLogic`, `HorsePolicyRegistry` and `HorsePolicyGraph`.

## Thresholds

Each rule carries its measurement in a comment. The series are new as of 2026-10-16; the
thresholds were derived from the same counts in `horse_brain_telemetry` (eight days), a
read-only copy of the private decision journal, and 7 days of
`poker_actions_fleet_total{audience="horse"}`. Re-derive them from the new series once they
hold a week.
