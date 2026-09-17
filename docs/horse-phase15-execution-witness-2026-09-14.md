# Phase 15: private response-to-execution witness

The outer policy graph previously stopped at its sampled action. A returned
decision now carries the validated request identity, fast/deep lane, selected
action, outer graph snapshot, compute time and governor scale into the real
table executor. Late responses discarded by the worker client are explicitly
retired there, because no table callback will receive them. Cancelled turns,
discarded second looks and accepted replacements finish each witness once.

The controller can legally transform an all-in into a pot-limit or fixed-limit
wager. Reading the submitted action back after `performAction` returned true
therefore mislabeled execution. An optional, synchronous observer now receives
the controller's exact immutable action record after validation and cent
snapping, before broadcast and turn/street advancement. An observer exception
cannot veto or interrupt the existing action. The witness and the six existing
policy receipts use the accepted action when this record is available.

A witness preserves intended, coerced, fallback and not-executed outcomes.
Accepted-without-record, actor/street mismatch and multiple accepted records remain explicitly
unverified; a boolean alone never certifies the action. A recorded action is
not erased merely because a later callback threw. The existing finite telemetry
counters publish execution status and lane, without request identifiers.

Version2 binds the original Horse seat as well as its street. A mismatching
controller record is retained without inferring execution; see the
[decision-read consistency audit](./horse-decision-read-consistency-2026-09-14.md).

## Boundaries

This is a memory-only execution witness for returned betting decisions, not a
durable decision ledger, replay input, full internal graph or Phase 15 completion.
Queue requests that never produce a decision, terminal worker failures and
Pineapple discard retain their existing lifecycle telemetry. State digests are
private: they bind hero input and must never enter public/operator table views.
No cards, RNG seeds or full request snapshots are copied into the witness.
The graph contains eight bounded sampled-action transitions, not probability
distributions, counterfactual utility or a complete policy/source manifest.

There is no strategy, sizing, RNG, deadline, database, financial producer or
activation change. Existing canonical action and fallback behavior is retained.
Only the exact controller record can establish the observed execution. Full
durability, deterministic restart replay, OOD, fleet/reference certification and
the earlier phase gates remain open.

## Verification

Before executor integration, nine new scheduled-action checks reproduced missing
witness retirement/reconciliation. After integration, 171 focused checks pass:
both worker response lanes, discarded replies after abort/expiry, unchanged and
replaced deep decisions, cancelled/stale/coerced/rejected actions, immutable
identity and graph snapshots, no private input copying, exactly-once counters,
and missing/conflicting controller evidence.

Six actual-controller scheduled fixtures cover PLO4/5/6/8 and FLH/FLO8. A deep
preflop all-in is recorded as the actual raise to 7 chips (pot-limit) or 4 chips
(fixed-limit); all six layer receipts and the witness agree. Separate real
controller checks prove rejected actions produce no receipt and a throwing
observer leaves the accepted wager and turn advancement intact.

The final build/full-suite and release identities are recorded separately in the
task evidence bundle. Merge, successful deployment and natural execution must
each be verified; this source document does not claim them.
