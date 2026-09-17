# Publishing through the restored providers

**Non-engine delivery: push, publish, verify and finish without waiting for `:55`.** Apply the maintenance cutover only to an actual engine replacement or a specifically identified dependency on new engine behavior. A Club Arena client using existing engine APIs, an unrelated pending engine release, and a generic engine-health check do not create that dependency. Required checks and normal client publication/live proof still apply.

Read [AGENTS.md](AGENTS.md) and [the operating law](docs/agent-policy/OPERATING-LAW.md), including immediate failed-deployment recovery.

Current owner instruction, September 17, 2026. This is the active publication procedure for local and cloud agents. It supersedes older root-only authority, numbered delivery queues, stop-after-push directions, retired local-build procedures and reliance on disabled agent autopilot.

## Own the whole assigned delivery

Each agent authorized to push and publish completes its own submission, protected merge, publication and live verification. All assigned workstreams may proceed in parallel. Do not wait for the restoration task or an unrelated task to finish. Preserve actual code/schema dependencies, required technical checks, transactional safeguards, maintenance boundaries and provider concurrency controls. Those controls handle competing production publications; do not add an agent-managed queue.

Use an owned worktree and branch. Recover the existing PR, unmerged work, applied migrations and valid verification evidence before changing anything. Preserve unrelated changes and shared checkouts. Reading these instructions does not authorize another development phase or expand the assigned scope.

## Push and protected merge

1. Commit the intended files with the normal repository hooks and configured Git identity. Never force-push main, bypass hooks or disable required checks.
2. Push the owned branch through the configured authenticated Git transport. If the exact commit is already on its remote branch, reuse it.
3. Find the existing PR for that branch. Create one only if absent. Do not assume a PR helper is enabled, and do not depend on disabled autopilot or release-repair workflows.
4. Read the actual required results for the current PR revision. Use the configured GitHub CLI/API; if one interface cannot read check details, Actions run/job evidence is available through the authenticated REST API. An unreadable result is unknown, not passing.
5. Fix actual blockers with the smallest correct change, using the last successful equivalent as the baseline. Reuse successful evidence for unchanged source and inputs; do not add duplicate suites or run unrelated checks. Applicable required checks must actually pass.
6. Complete the protected squash merge with the reviewed current PR head. Let GitHub enforce branch protection. The agent owns this action once its assigned release is authorized; an additional restoration-owner handoff is not required.

## World Hub

The protected main merge triggers the existing Vercel Git integration for **hub-vanguard**, project **prj_op66GkZyZcygXQKm76iyycfVFAQx**. Vercel builds from source and publishes production. Keep that integration enabled and use that existing project.

Confirm the production deployment is **READY**, its Git commit is the intended protected revision, and **https://smarter.poker/api/health** reports the deployed commit. Verify the affected behavior as well as the version.

Do not substitute a local/prebuilt deployment, deploy hook, separate Vercel project, old shared-clone push script or background push service. Club Arena client changes do not require a World Hub rebuild.

## Club Arena client

The protected main merge triggers **publish-club-arena.yml**. GitHub builds and checks the client, and the existing publisher installs it on Hetzner's static origin with its immutable asset safeguards.

Require successful publication and matching client revision/build provenance at both:

- **https://ca-static.smarter.poker/build-info.json**
- **https://smarter.poker/hub/club-arena/build-info.json**

Record the actual publisher run and selected revision. Preserve the origin's append-only assets; do not create a second publisher or copy the bundle into World Hub.

In `post-deploy-e2e.yml`, read the **Client browser verification** job separately from **Live-table and engine verification**. The client job has no dependency on an engine revision, maintenance certificate or live-table job. Both jobs retain their required reports, isolated-account cleanup and exact client provenance. The live-table job continues to run after every client publication, using the exact healthy engine currently serving that client, with protected-main ancestry and unchanged engine identity throughout its actual-hand/reconnect checks. A later unshipped engine commit on main is not its target. Engine-triggered certification instead requires the exact immutable engine SHA in the release event and refuses a different serving version.

Verify the jobs and affected behavior applicable to the assigned change. A client change to table transport or gameplay presentation still needs its live-table interoperability proof against the serving engine. An unrelated engine-certificate failure remains visible and must not be described as passing, but it is not a maintenance hold on an independent page, style or client release. Neither separate job may skip its own required checks to obtain a successful verdict.

## Club Arena engine and other changed components

For engine changes, use the existing **stage-engine-release.yml** followed by **auto-deploy-hetzner.yml**. Preserve the hosted engine checks, production-door checks, Hetzner build, maintenance cutover, concurrency, sealed receipt and applicable post-deployment verification.

Record the staging run, selected runtime component revision and receiving engine release run. The runtime component revision can differ from a later documentation-only main revision. Confirm the expected component revision at **https://engine.smarter.poker/health** together with the existing release proof. A health response alone is not proof that the changed feature works.

If the assigned change includes monitoring, use its existing **deploy-monitoring.yml** route and final loaded-configuration verification. If it includes a database change, qualify and apply the exact migration through the configured authorized installation path, then read back the installed state and migration history. A merged migration file is not an installation. Do not replay installed migrations or assume an engine deployment applies them automatically. Preserve any actual application compatibility/cutover prerequisites.

## Concurrent deliveries and completion

Continue other authorized work while provider jobs run. Keep the exact pending run/revision and inspect the result afterward; do not create a watcher, scheduler or repair loop. A provider may serialize a shared production resource or publish a newer protected revision containing several agents' changes. Record the actual selected revision and prove it contains your merged change; do not force an older revision over a newer release merely to obtain a matching number.

Report the PR, merged revision, applicable checks, installation evidence, successful publisher/deployment, actual live revision and affected-behavior result. Keep submitted, tested, merged, installed, published and verified live separate. Never claim the entire delivery is complete from a push or green build alone. Six minutes remains a performance target, not a guaranteed duration.

The restored production builds use GitHub, Vercel and Hetzner; reasonable provider compute is authorized. The M3/SSD can hold source and owned worktrees. Do not reactivate retired custom/local pipelines, release watchdogs, repair loops or the removed external error-telemetry integrations. A self-hosted build upgrade requires a later explicit owner instruction.

On the owner's Mac, also read /Users/smarter.poker/Documents/AGENTS.md and /Users/smarter.poker/Documents/AGENT-HARDENING-STANDARD.md. Preserve later owner instructions and the assigned scope. Never print credentials or copy values from .env files into commands or documents.

## Failed or interrupted deployment

Follow the operating law's failure classification immediately. Repair build/test/preflight failures without waiting for a maintenance hour; reattach to an unknown owning operation; verify or recover missing proof without restarting a healthy deployed version. A cutover needs the existing durable maintenance certificate and full proof/rollback budget. Record failure, fix-ready, retry submission, admission and verification times separately. The additional certified engine recovery opportunity is a required implementation improvement, not a capability supplied by these Markdown changes. Do not extend a freeze or reduce safety reserves to force a retry.

## Publication timing

Push ready changes, run checks, complete protected merge, build and stage as soon as their prerequisites pass, throughout the hour. Do not hold these stages until `:55`. World Hub and Club Arena client publication have no hourly gate. Only game-engine activation uses its certified maintenance window; the immutable image must be prepared beforehand, followed by immediate live identity, behavior and rollback-budget verification at cutover. Commander and shared-package delivery retain their own component rules above. See the operating law for failed-attempt recovery.

### Route by the changed behavior

| Change                                                                                  | Required route                                                                                                                      | Hourly activation gate                                                                       |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Client pages, buttons, styles, assets or browser behavior with no new engine dependency | Client checks, protected merge, existing static publisher, both public build-info endpoints and affected behavior                   | None                                                                                         |
| Engine runtime or its release control                                                   | Required engine checks, protected merge, immediate engine staging/build, certified activation and proof                             | Engine activation only                                                                       |
| Client and engine together                                                              | Validate compatibility; stage both promptly and identify the exact dependency before exposing behavior that requires the new engine | Only the dependent behavior and engine activation; unrelated client work remains independent |
| Database or financial change                                                            | Applicable database/financial qualification and installation safeguards                                                             | Existing DDL/freeze restrictions where applicable, not a blanket client publication hold     |

CI classification and deployment selection are separate. A client financial change may correctly require database/server tests without requiring an engine restart. Do not rename files or weaken checks to evade that qualification. A docs-only or client-only merge can invoke the lightweight engine detector; a verified unchanged engine tree must produce no engine deployment request. Provider runner queues and the static publisher's own serialization are not hourly maintenance gates.

## Before submission

Run the applicable local prechecks on the final candidate before push, as required by `docs/agent-policy/OWNER-POLICY.md`. Include source contracts reading changed Markdown/workflows/scripts and qualification manifests, not only imported-code tests. Resolve missing or stale owned dependencies and actual failures before submission; never defer an available local check to the first hosted run. Record exact input and results in the task checkpoint. Hosted CI, protected merge, publisher admission and applicable live proof remain mandatory.
