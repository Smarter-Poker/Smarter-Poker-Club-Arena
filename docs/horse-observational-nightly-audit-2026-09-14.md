# Observational nightly study boundary

The nightly study previously converted frequency and leak diagnostics into
permanent global modifiers and leak-profile inputs without node-specific
counterfactual, holdout or shadow evidence. Its real writer now records those
proposals as diagnostics and preserves the exact original profile. This is an
enforced observation boundary; the causal learning pipeline remains unfinished.

`HorseSelfTuner` calls `recordObservationalHorseStudy` after the existing study
and diagnostic calculation. Before its first await, the adapter captures the
original raw profile and all diagnostic values. It sends explicit
`observational_only` intent, identical expected/next profiles, identical applied
before/after modifiers, separately named proposed modifiers, review counts and
denominators, and reasons labeled as unapplied proposals. Its audit identifies
the contract version and records zero causal permission. String styles, null
profiles, aliases, authored persona fields and historical leak fields retain
their original values. Contradictory changed receipts remain unknown.

The forward atomic-writer migration refuses every new profile mutation through
this diagnostic RPC, including callers that omit the observational intent.
An unrecognized intent cannot grant authority. The function contains no profile
UPDATE. Exact receipts from previously committed legacy changes still replay
without applying those changes again or overwriting a later edit. New no-change
audits keep the original compare-and-set check, atomic audit/receipt insertion,
service-only execution and bounded payload. Applied modifiers must match the
original profile exactly. Values outside the legacy tuner's proposal range can
be audited unchanged; they are not clamped or overwritten as a side effect of
recording an observation.

Original eligible study cohorts, recorded-horse resume, lost-response handling,
completion markers and the nightly job/audit integration remain in use. A
partially recorded cohort cannot complete. Successful observational studies
report studied horses with zero newly tuned profiles. Missing or contradictory
receipts retain the unfinished study instead of reporting completion.

Verification: compilation; 114 focused checks across eight files, including the
real nightly study and actual cohort/job integration; 11,756 server tests across
794 files (145 existing skipped tests and one skipped file; 67.54 seconds).
The final PostgreSQL fixture passes 27 groups with cleanup. It reproduces the
old intent bypass and authored-value no-op refusal before applying the forward
migration, then verifies the compiled adapter against the real database: lost
reply/replay, exact preserved profiles, proposed versus applied values, explicit
and omitted intent, forged intent, leak-only mutation, modifier boundaries,
historical receipt replay after a later edit, stale CAS, audit failure, two-horse
completion and application-role denial. All fixture writes are isolated; no
synthetic production tuning or profile reset is used.

Initial integration assertions still expected the former applied-tune count;
they now assert the new diagnostic/applied distinction and retain all failure
and completion checks. The native harness initially missed a trailing comma in
the compiled import it redirects to the local database; that harness issue is
fixed. Earlier logs and the intermediate permissive-gate proof remain in the
task evidence. The final forward gate also closes omitted-intent mutation and
removes the unreachable profile UPDATE.

Older RPC callers requesting a new change receive an explicit refusal after
the schema upgrade. Current runtime behavior must be verified against the
published source: an older engine using the former direct profile-write path
does not acquire this boundary from the SQL migration alone. Publication and
natural nightly execution therefore remain separate acceptance requirements.

Historical leak-conditioned strategy reads still require a separate audit.
This change does not reset earlier profiles or implement source discovery,
coverage/cutover, throughput qualification, causal action estimates, the model
consumer, holdout reuse controls, shadow uplift, activation or rollback. A
disabled mutation path does not satisfy the Phase 14 control-pipeline gate.
