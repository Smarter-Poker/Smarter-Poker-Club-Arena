# Phase 14 journaled opponent model consumer

The scoped opponent fitter and predictive holdout validator now have a real isolated service caller. The adaptive-journal worker sweeps durable actor/public-node coordinates, reads both cohorts and partitions in one bounded database snapshot, reconstructs decayed session-weighted estimates and stores a private latest report. It does not change a betting decision.

The modeled population is explicitly **journaled qualified observations**. It is separate from the complete-source estimator: model identities bind that distinction, incomplete source windows still fail the original API, and no journal report can claim source completeness, causal EV or activation authority. The five-action uniform prior is a versioned frequency diagnostic, not a legal-action policy or a calibrated population prior. Repeated holdout diagnostics have no selection correction and cannot promote a candidate.

## Ownership and recovery

`services/horseAdaptiveJournal/worker.ts` supplies `processJournaledOpponentModels` to the existing isolated loop. One model turn follows eight ordinary journal turns; model failures back off independently while acquisition, discovery and journal work continue. The main process receives only finite outcome counters and timestamps. Actor identities, journal payloads, digests, model probabilities and private reports stay out of public health and table state.

A single durable sweep lease serializes the learner across hosts. Only a fenced finish advances the coordinate cursor. Timeout, crash and lost-response recovery reconstruct from the journal; stale leases cannot overwrite a report. Inserts behind the cursor are revisited after wrap. The cursor is a sweep position, never a source-ingestion watermark.

The two private RLS-protected tables deny direct access even to `service_role`; the service can execute only the bounded claim/finish operations. Publication validates source release, evidence digest, snapshot, window, actor/node and the explicit absence of activation authority. A repeated exact finish returns its recorded digest. Invalid reports roll back.

`HORSE_JOURNALED_MODELS=off` disables model claims independently of source discovery and capture. Unrecognized settings and missing full release identity return unknown without a database call. The default is enabled. No production configuration or other worker ownership is changed by this patch.

## Bounds and evidence

- Acquisition uses the existing `(actor, scope, partition, origin, observation time)` index through six bounded index probes. It returns at most 20,000 observations and 16 MiB; an oversized population produces an explicit refusal, never a fit of a truncated prefix.
- Reports are at most 64 KiB. The latest-report store holds at most 10,000 coordinates and prunes at most 25 expired diagnostic records per finish. Capacity exhaustion records a durable refusal and advances the sweep without inventing a report or starving existing coordinates. This store is not immutable policy history.
- Transport deadlines are five seconds, leases sixty seconds, and modeling remains in the existing 256 MiB worker heap. Repeated exact public scopes share one validated frozen value; every observation still receives canonical, digest, identity and partition checks.
- Native PostgreSQL proof covers 480 observations, both cohorts/partitions, exact report readback, independent-process replay, duplicate finish, stale and expired leases, authority escalation rollback, role restrictions, observation/byte refusal, capacity refusal and competing-claim lock avoidance.
- A 19,000-observation / 16,463,500-byte diagnostic workload completed three deterministic fits within the configured 256 MiB heap. This is a bounded component check, not a strategy latency, sustained fleet-capacity or strength qualification.
- The final source passed the server TypeScript build and full suite: 12,280 passed, 146 existing fixture-dependent skips, 817 files passed and one skipped. The skipped native departure fixture is not claimed as passed. The model store was installed at 12:04 UTC with both function bodies and service-only ACLs read back. Source publication and natural model receipts remain pending.

## Remaining first-round requirements

Phase 14 is still incomplete. Source closure/commit/cutover/loss authority, calibrated prior provenance, node-specific counterfactual action/EV proposals, holdout-reuse control, candidate shadow selection, gated activation/rollback and natural publication proof remain separate requirements. The model consumer provides a real durable calculation path; it does not substitute diagnostic probabilities for causal uplift or certify the first fifteen phases.
