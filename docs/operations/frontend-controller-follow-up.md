# Frontend and mixed releases: controller follow-up contract

This is the implementation handoff after the unchanged-frontend bridge. The
bridge retains all browser triggers and does not claim serial ownership across
publication and certification. This follow-up is not installed or activated.

## Existing implementation to extend

Compose the reviewed private release journal and provider boundary first. Use
`operations/release/source-coordinator.mjs`, `certificate-proof.mjs`,
`adapters/github-certification.mjs`, and the existing static publisher. The
coordinator currently requires an engine publication to plan certification;
the adapter and final certificate currently require an engine target. Remove
that assumption through a real frontend/mixed component contract, without
manufacturing an engine publication for a frontend-only release.

An admission owns one exact manifest until all publishing, certification,
cleanup, and final readback become terminal. Do not add a publisher or change
GitHub concurrency groups to simulate this ownership. Do not hold a database
or gameplay transaction open during browser tests. Ordinary frontend changes
must not invoke engine maintenance or restart it.

## Required request and receipt fields

Retain separate `admission_sha`, `control_sha`, `manifest_digest`, and each
component's `source_sha` and immutable artifact identity. A retained component
must include its previous verified receipt and explicit compatibility proof.
Frontend identity is its original `ca_sha` plus native manifest digest; it is
never the latest main SHA unless that source actually produced the artifact.

The certificate request binds release ID, certificate operation ID, exact
workflow/control identity, and every changed or retained component. It must
not discover a replacement target from then-current main. Require successful
terminal publication receipts for changed components and fresh readback for
retained components before creating fixtures. A changed engine additionally
requires its existing safe-resume and stability proof.

The final receipt must bind the exact run/attempt, all eleven report groups,
report digests, first-attempt outcomes, full component tuple before and after
cleanup, and exact guarded cleanup receipts. Store this receipt on success as
well as preserving failure/cancellation artifacts. The selected BUILD and
CERTIFICATION tuples must agree for both frontend and engine, including
retained component evidence. Dispatch acceptance or receiver appearance is
not terminal certification.

## Durable fixture cleanup

Before an account-creation effect, persist a sanitized creation intent with
the release, certificate operation, run/attempt, and exact reserved identity
key. Never persist passwords in the release journal. Record the returned
account ID when known. After a lost creation response, reconcile that exact
reserved key before creating another account. Track all subordinate fixture
resources through their existing guarded cleanup authorities.

The current runner-local account file and its missing-file no-op cannot prove
cleanup after runner loss. Retain ownership until exact account/resource
absence is proved or a separately audited unresolved disposition is recorded.
Do not use age-only stale-account sweeping as this run's cleanup receipt.

## Native acceptance sequence

Extend the existing real PostgreSQL integration fixtures in
`tests/operations/source-coordinator.integration.test.mjs` and
`provider-runner.integration.test.mjs`, and the actual adapter tests in
`provider-adapters.test.mjs`. Reuse their `postgres-fixture.mjs` local cluster;
never point these tests at production. Execute the composed suites with:

```sh
node --test tests/operations/source-coordinator.integration.test.mjs \
  tests/operations/provider-runner.integration.test.mjs \
  tests/operations/provider-adapters.test.mjs
npx vitest run tests/unit/retainedFrontendProof.test.ts \
  tests/unit/retainedFrontendWorkflow.test.ts \
  tests/unit/postDeployE2EConcurrency.test.ts \
  tests/unit/postDeployE2eHonestyLaw.test.ts
```

The integration harness must execute these scenarios against actual journal
transitions and provider submission counters, with native static transaction
fixtures for the new static adapter:

| Scenario / action sequence                                                                                         | Required observable result                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Frontend-only admission; publish frontend; retain verified engine; certify                                         | Exactly one web publication, zero engine/maintenance effects, all browser reports, full tuple receipt.                    |
| Mixed admission; web publication succeeds before engine                                                            | No certificate submission or fixture creation until the engine is terminal and safely resumed.                            |
| Duplicate web and engine completion deliveries for one manifest                                                    | One certificate operation/submission; later deliveries reattach to that exact operation.                                  |
| Main advances while an accepted request is applying                                                                | Its exact admitted tuple and original deadlines remain unchanged.                                                         |
| Source, image, native manifest, origin/public document, engine instance, run, attempt, or control identity changes | No successful certificate receipt and no VERIFIED transition.                                                             |
| Suite fails; guarded cleanup succeeds                                                                              | Retain the real red results; release is not verified.                                                                     |
| Suite passes; cleanup fails or is unreadable                                                                       | No VERIFIED transition and no next publication.                                                                           |
| Account creation succeeds but response/runner is lost                                                              | Reconcile the existing exact reserved account; no duplicate creation and no missing-file green result.                    |
| Dispatch response is lost; correlated receiver exists                                                              | Reattach; never blindly dispatch again.                                                                                   |
| Owner interrupted during certificate or cleanup                                                                    | New qualified owner reattaches to the same operation and effects. No overlapping publisher.                               |
| Next ordinary release attempts to publish before current certificate/cleanup terminalizes                          | Durable journal refuses it. After the selected complete receipt and VERIFIED transition, next admission may proceed.      |
| Daily scheduled certification meets an active publication                                                          | It queues as verification-only work or attaches to the exact equivalent owned certificate; no independent fixture writer. |

Preserve all eleven groups: cashier, stats, lobby, live-table realtime, club
members, customization realtime, customization commerce, daily missions,
daily-missions accessibility, daily-missions settlement, and sweep. Preserve
independent cashier checks, trusted assertion-source limits, auth checks,
missing/skipped report refusal, zero test retries, and final unchanged proof.

Only after this source composition, native rehearsals, real writer/identity
isolation, and an owned cutover inventory pass should legacy web/engine and
scheduled triggers be routed into the serial owner. Handle existing accepted
and queued runs explicitly. Do not cancel an active certificate or native
operation as a shortcut, and do not disable frontend-only coverage before its
replacement is proven.
