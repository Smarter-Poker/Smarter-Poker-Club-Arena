# Scoped opponent holdout validation

The existing model separated training and holdout sessions but did not score
the trained model on those withheld observations. The validator now builds the
candidate strictly from training data, then compares its multiclass Brier loss
with the stated population prior on the separate heldout session distribution.
One physical hand cannot appear in both arms, even under relabeled sessions.

For prior probabilities p, trained probabilities q and heldout action a, the
improvement is sum(p² − q²) + 2(q[a] − p[a]). Positive means the model predicts
the observed action better. The computation removes the holdout estimator's
prior mass before grading, so prior shrinkage does not grade its own baseline.
The same per-hand/per-session caps, decay, sample floors, node, actor, cohort,
time window and deterministic session partition apply to both arms.

The uncertainty interval propagates the existing simultaneous heldout frequency
bounds through that linear score. It is conditional on independent sessions
and a fixed candidate; it does not correct repeated candidate selection using
the same holdout set. Both arms must meet their floors before any improvement
or regression verdict. A single long session cannot establish support.
Results bind both evidence digests, model IDs, policy, baseline and window;
replay and observation reordering leave the result unchanged.

This is predictive validation only. It has no tuning or activation authority,
does not estimate counterfactual action returns, and does not replace the legacy
tuner. It relies on independently established source-window completeness and
baseline provenance; this module cannot certify them. The live source producer,
model consumer, causal utility, controlled holdout reuse, shadow testing and
activation/rollback remain required Phase 14 work.

Validation: 115 focused checks passed, including 13 holdout-specific checks.
The full server suite passed 11,728 tests with 145 existing skips. Two fresh
compiled-runtime runs matched an independent direct-outcome Brier calculation
across 24 combinations of trained/heldout distributions and aged evidence.
The results were byte-identical across process restart, reordered observations
and duplicate delivery. The 20,000-observation input completed, and a 20,001st
input refused. These are synthetic offline checks, not production evidence.
The first focused run exposed an endpoint smaller by floating-point rounding;
reported intervals now round outward by the explicit numerical tolerance.
