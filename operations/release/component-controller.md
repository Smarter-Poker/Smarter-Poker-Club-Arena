# Component controller source and installation boundary

The executable entrypoint is `controller.mjs`. It calls `controllerRuntime()`
from the immutable installed bundle, then passes its adapters and readiness
objects into `SourceCoordinator` and its two authenticated callbacks into the
existing admission socket. `controller.example.json` remains OBSERVE-only.
No source test or example activates production execution.

Changed frontend releases use one aggregate VALIDATION and one aggregate BUILD
operation. Each subordinate component has one immutable operation ID, provider
request, submission authorization, original run/attempt and result event. A lost
response permits readback of that same operation. It never dispatches a new
static publisher for publication: the original build run waits for its one-use
journal grant.

A mixed release stages the engine's actual built child run, then executes one
owned COMPATIBILITY source operation. Its qualification binds the exact schema,
before tuple, engine-first intermediate tuple, final tuple, artifact identities
and original provider receipts. The database and coordinator require engine
publication before web publication. STAGED and READINESS select the same full
qualified tuple, and certification requires exact native/public readback plus
cleanup of every reserved fixture. The gate refuses missing semantic evidence.

`RECONCILE` reads existing outcomes without authorizing a fresh submission,
cleanup, host acceptance restart or stage application. Native stage `current`
checks the running container image and instance against the release seal.
Installed native boundary upgrades are required before relying on those new
commands; source presence is not installed evidence.

## Configuration mapping

Configuration is root-owned, immutable-bundle verified and journal-bound. Values
below describe required fields; they are not credentials or an execution-ready
installation example.

| Runtime configuration                                                     | Journal installation binding                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `github.controlSha`, `github.controlRef`                                  | `github.control_sha`, pinned branch checked against that source                |
| `github.workflowId`, `github.runtimeImage`                                | `github.workflow_id`, `github.runtime_image`                                   |
| `github.frontendWorkflowId`, `github.frontendRuntimeImage`                | `github.frontend_qualification_workflow_id`, `github.frontend_runtime_image`   |
| `github.staticWorkflowId`                                                 | `github.static_workflow_id`                                                    |
| `github.certificationVersion: 2`, `github.certificationWorkflowId`        | installed component certificate ingress and `github.certification_workflow_id` |
| `github.componentQualificationWorkflowId`, `github.componentRuntimeImage` | `github.component_qualification_workflow_id`, `github.component_runtime_image` |
| `components.compatibility.contract.schema`, `.cutover_order`              | `compatibility.schema`, `compatibility.cutover_order`                          |

`components.compatibility.contract` also includes `version:1`,
`before_components` and `retained_artifacts`. The full schema `catalogue_digest`
and narrow live engine `database_contract_digest` have different meanings and
must both be supplied. Original artifact IDs, runs and immutable archive digests
are mandatory. See `native/component-semantic-runtime.md` for the exact runtime
and schema/fixture contract.

`components` supplies `database_credential_name`, `database_ca_path`,
`database_principal`, `static_host_alias` and `static_control_receipt_path`.
Credential values come only from the existing systemd credential directory.
The private database connection requires authenticated TLS and an exact login
with callback membership but no controller/operator/verifier/submitter role or
administrative flags. Admission separately requires its exact submitter login,
verified TLS and absence of those elevated or callback memberships.

`github.fixtureAuthority` and `github.staticAuthority` contain the exact ingress
URL, audience and installation receipt. Certificate OIDC binds the installed
control branch; static publisher OIDC binds `refs/heads/main`. A newer static
source is accepted only when its complete reviewed control closure is unchanged.
Neither callback gets the controller's owner session.

## Source limits and outstanding work

The semantic driver and actual browser/engine/SQL oracle are implemented. The
complete synthetic fixture-server runtime and schema/actor fixture remain a
separate unfinished source workstream owned by the parent operator. The driver
refuses that absence. Boundary/native tests use explicit disposable fixtures;
they do not certify a production artifact tuple.

Controlled static wait is bounded at 120 minutes within a 145-minute job, and
stops at least 20 minutes before the original release deadline. This accommodates
the declared 16-minute stage, 60-minute semantic job and 30-minute operation
ceilings without imposing the old 15-minute wait. Ordinary publication remains
25 minutes. These are initial source ceilings requiring measured Linux evidence,
not a latency promise and not a change to maintenance policy.

Production installation still requires isolated existing controller and callback
identities, enforced ordinary-writer exclusion, private service/TLS/ingress
installation, native host boundary installation, exact database migration and
bundle receipts, full synthetic qualification, and eventual served certification.
The reported Autopilot overlap of PR4327 and certificate34645068983 is retained
as a negative native artifact-race test; it does not prove those installed writer
permissions are repaired.
