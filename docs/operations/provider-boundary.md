# Installed provider boundary — local implementation, activation blocked

This slice adds an executable source coordinator and provider-operation runner to journal schema 1. It can promote an exact, already qualified Vercel production deployment and delegate an already qualified engine release to the existing Hetzner intake. Both paths retain the global release until their exact terminal outcome is recorded. It also supplies native controller installation and upgrade artifacts. None is installed or activated by adding this code.

The event consumer defaults to `OBSERVE`. For an engine-only admitted PR, the coordinator claims one item, qualifies its exact prospective merge, submits one protected squash merge, verifies the resulting base/tree, builds the exact merged source, and selects linked receipts. It advances publication only from installed staging/readiness evidence and retains the item through selected served certification. World Hub/native Git build orchestration, frontend/static publication, actual trusted artifact transfer/staging, automatic readiness/certification execution, migration execution, Vercel rollback and controller-upgrade dispatch remain **unavailable**. The new isolated qualification workflow is source code pending installation on a protected control branch; existing combined publishing workflows are unchanged and still require authority retirement before activation.

## Source integration and event admission

`source-coordinator.mjs` is used by the installed controller entrypoint. `source_plans` admit one immutable phase per attempt. Validation dispatch is an external BUILD intent before MERGING, through the narrower additive `begin_source_plan` API; the original journal migration/API is unchanged. Every dispatch/merge uses the same durable INTENT, committed single-send authorization, persisted readback windows and UNKNOWN barrier as publication. A source read transport failure records a bounded existing retry; a source contract mismatch blocks the item. Unsupported target/recovery source contracts remain visible and owned.

The first executable source contract supports exactly one `club-arena-engine` component in an admitted Club Arena PR. It reads the PR's current base/head/prospective merge, requires the prospective commit's two exact parents, and captures its tree. `release-candidate.yml` is dispatched through a registered protected control branch at a pinned control SHA. The controller rechecks that ref and workflow identity before dispatch. Candidate tests run as nonroot in a read-only, capability-dropped container with bounded CPU/memory/processes, only a read-only source archive, container-local scratch, and no runner secrets, control checkout, host socket or writable artifact directory. The configured digest-pinned Node 22 image must match the candidate's single Dockerfile FROM. The fixed commands run TypeScript and the server suite. Build qualification reuses the frozen `build-engine-image.sh` from trusted controls against the exact committed server tree, preserves the immutable image ID and archive digest, and uploads the image without staging it on a production host.

The workflow has only contents-read permission and no production environment or publication credentials. Checkout/upload actions are pinned to provider-verified commit IDs. It must be reviewed and installed on a protected control branch; its Actions run and Linux container execution were **not** dispatched here. The native tests verify process construction and authority isolation at that boundary, not a successful hosted build.

The GitHub adapter uses the [current workflow-dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), version `2026-03-10`, which documents HTTP 200 with `workflow_run_id`; an older 204 or lost response remains UNKNOWN. Readback requires one exact operation UUID in the trusted run name, workflow ID/path/control SHA, first run attempt, terminal success and a digest-verified immutable receipt artifact binding the entire request. Missing/duplicate runs, reruns, pagination beyond the bounded result window or invalid artifacts cannot silently satisfy qualification or cause resubmission. GitHub archive URLs receive no GitHub bearer credential. Runtime artifact IDs and archive digests are retained for the future trusted stager.

The [merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) uses accepted-head SHA compare-and-swap. GitHub supplies no expected-base CAS parameter. Immediate exact base/tree preflight, protected up-to-date checks, verified exclusive writer authority and the native lifetime lock are therefore required; those installed settings are not claimed here. A merged result whose parent/tree differs from qualification becomes a failed owned operation. The merged source is rebuilt and selected before STAGED. A successful merge or build never releases the next admission.

Authenticated `repository_dispatch` deliveries with action `release_intent` carry `client_payload: {client_key,intent}`. `event-admission.mjs` verifies the original bytes with the [GitHub HMAC signature](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), exact repository scope and delivery UUID before `enqueue_delivery` atomically commits admission plus immutable delivery digest. A repeated delivery returns the original receipt; altered contents reject. The endpoint runs in the existing controller process on the fixed private Unix socket `/var/lib/club-arena-release-controller/admission.sock`, with one active request and bounded body/time. It requires separately installed existing constrained submitter identity and systemd credential references. The signed HTTPS ingress, credential provisioning and identity grants are **not installed** here. Ordinary journal CLI enqueue remains available and wakes the same LISTEN consumer.

After BUILD, the coordinator consumes only selected STAGED and READINESS receipts, creates exact qualified provider plans, waits for every component publication to terminate successfully, enters VERIFYING, and requires selected exact served certification with cleanup before VERIFIED. No staging/behavioral proof is fabricated. Native PostgreSQL end-to-end tests use clearly marked external boundary fixtures to prove that a second PR remains QUEUED through the first item's UNKNOWN, STAGED and VERIFYING states, then becomes claimable only after exact final certification. Queued-only withdrawal remains the existing supported cancellation scope.

## Durable operation boundary

Apply the allocator-reserved additive migration `20260911160341_provider_operation_boundary.sql` after journal migration `20260911151748`. The base migration is unchanged. Provider API version 1 is checked independently of journal schema version 1.

`submit_provider_plan` admits an immutable request only for the active `APPLYING` release. Its bytes must already occur in the selected READINESS receipt's `provider_requests[adapter]`. Its source and artifact identity must match the selected BUILD receipt; its manifest/recovery revision must match the current resolution. The Vercel project must match the journal target registry. No operator-supplied request becomes its own qualification evidence. Changed caller keys do not let altered qualification replace an admitted plan; original plan receipts remain append-only.

The installed process then follows this order:

1. Validate the fixed adapter request and commit `EXTERNAL_INTENT` through the existing journal API.
2. Perform preflight readback and persist its sanitized observation.
3. Recheck current owner, epoch, backend/session lock, deadline, installed bundle/config digest, principal and enabled authority; commit a unique `PROVIDER_SUBMIT_AUTHORIZED` receipt.
4. Only the process that observed that commit may make the one provider request. No retry is attached to POST/SSH submission. A lost intent or authorization COMMIT response cannot authorize another send.
5. Persist the accepted/unknown response. Provider timeouts, SSH exit codes, missing operation records and disconnected callers keep the active release and become readback-only.
6. Store an immutable terminal observation before resolving the external operation. If the final resolve commit is lost, the stored observation can be replayed. A successful provider operation returns to APPLYING and still requires the selected final certification chain before releasing the global queue.

An explicit local preflight refusal can produce NOT_ACCEPTED only in the same invocation that saw the initial INTENT commit and never requested submit authorization. A restart cannot infer that from an absent provider record.

The consumer registers LISTEN before acquiring its fresh epoch and scanning. It scans bounded head/active-operation records, never all release history. Only already journaled retries/readbacks have timers: 40 checks, with persisted delays up to 60 seconds. After that it stops automatically checking and retains UNKNOWN. An operator may explicitly authorize up to three additional immutable windows of 40 read-only checks using `recheck`; this never resets normal release retries or resends the provider request. Beyond that budget, independent terminal evidence/recovery through the existing journal APIs is required.

## Fencing and installed authority

Vercel's promote API and GitHub's merge/dispatch APIs have no journal-epoch conditional write. The SQL gate rejects stale owners immediately before submit, but a field in a request is not API-side fencing. The installed native service therefore holds an exclusive lifetime `flock` at `/var/lib/club-arena-release-controller/controller.lock`, including during provider calls and shutdown. A paused predecessor still holds the lock. The successor cannot overlap it. Unknown external intent also prevents the successor from advancing another release while the original provider action might still run.

This argument requires one verified existing operations host and exclusive use of the installed identity. Merely adding a second controller on another host would violate it. Candidate code and interactive sessions must not hold that identity or an equivalent production-writer credential. No account, credential, role membership, SSH grant, Vercel setting or production boundary is changed by this migration or installer.

An independently installed verifier may record `register_provider_installation`, with exact bundle digest, configuration digest, host/service/lock identity, journal/provider schema versions, existing constrained login membership and named evidence references for code, membership, native exclusivity, legacy writer retirement, isolated candidate-build authority, provider scope and compatible recovery. The controller cannot register this receipt. The function cannot turn execution on. The installed process must match the selected receipt and `session_user`; role grants and execution activation remain outside this bootstrap.

As observed during takeover on 2026-09-11, the available database login is a broad provider account; no existing dedicated release login was found. The direct and session paths are technically usable but do not establish identity isolation. Vercel production auto-domain assignment was ON, API access returned 403, and production build configuration contained references to write-capable GitHub/Vercel credentials. Those are actual activation blockers. This code does not use or print their values.

## Vercel adapter

The production transport is fixed to `https://api.vercel.com`, uses an installed systemd credential, disables redirects and automatic retries, bounds time/body size, and retains only explicit non-secret response fields. It never records project environment payloads.

The qualified request contains `project_id`, `team_id`, `deployment_id`, exact merged `source_sha`, `manifest_digest`, the complete configured production domain list, and `expected_current` with prior deployment ID and last alias-request timestamp. Preflight requires production target + READY/STAGED, matching GitHub source metadata, exact project/team, auto domain assignment OFF, no rolling release, the prior current deployment and all configured domains still on that prior deployment, and no intervening/pending alias request. Preview deployments are refused; this adapter never creates a new build.

One POST to `/v10/projects/{projectId}/promote/{deploymentId}` requests promotion. HTTP 201/202 is nonterminal. Readback requires a new matching `lastAliasRequest` tuple `(project,type,from,to,requestedAt)`. Missing, old, foreign, pending or skipped requests remain UNKNOWN. Success requires job status succeeded, the exact current production target, PROMOTED state and **all** configured aliases mapped to the deployment, bracketed by a final exact project/request read. A matching failed job is terminal FAILED and requires owned recovery. This slice does not implement rolling release or rollback.

The contract follows the official [promote API](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment), [project API](https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name), [alias API](https://vercel.com/docs/rest-api/aliases/get-an-alias), and Vercel's [promotion status implementation](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/promote/status.ts), inspected 2026-09-11. Unlike the CLI's user-facing “no promotion in progress” result, absent provider state is never treated here as proof of nonacceptance.

## Existing engine intake adapter

The production client uses one installed SSH alias with BatchMode and strict existing host-key checking. It invokes only the fixed root-owned one-shot `engine-boundary.py`; structured JSON goes over stdin. No candidate shell, new root login, arbitrary remote command or host fallback is accepted. The forced-command/identity installation must be verified independently.

The host wrapper requires an independently pinned trusted control SHA and hashes for every staged helper, secure root ownership, the separately prepared existing v1 image lease, an existing image whose exact ID/source/server-tree/build-contract match qualification, exact prior seal identity and an unexpired immutable run deadline. It validates the **installed** frozen v1 unit templates with `systemd-analyze verify` and checks their loaded state before submit. Missing or invalid templates block execution, including the reported `RestartForceExitStatus=75` with Type=oneshot failure. No v1 script, unit or format is changed here.

Before calling the existing `install-engine-intake.sh`, the wrapper fsyncs a new sidecar binding global operation/epoch/manifest to the exact run key. It passes the unchanged ten-argument contract in its original order. A repeated sidecar is readback-only; local process/SSH timeout does not cancel the host. The existing systemd intake remains the durable engine transaction owner.

Terminal success requires the existing observer's seal, local/public runtime and retirement checks plus an exact result attestation for the expected control SHA/image. Terminal failure requires the exact failure attestation and retired run files/units. Host attestation may repair its existing idempotent failure-audit append; it never dispatches another release. The prepared image/lease and valid installed v1 units are prerequisites supplied by a trusted stager; this slice does not manufacture them.

## Native bundle and lifecycle

`build-bundle.mjs OUTPUT EXISTING_SERVICE_USER EXISTING_SERVICE_GROUP` creates a reproducible directory and SHA-256 manifest including runtime, adapter/native code, rendered service identity and installed `pg` dependency bytes. It rejects symlinks and excludes Python caches. Stage the resulting directory under `/opt/club-arena-release-controller/versions/<manifest-digest>/` using the already authorized native installer path. The installer/runtime require secure root-owned files, exact hashes, an exact file inventory and compatible schema versions. Account names must already exist; no accounts or credentials are created.

`install-controller.py --bootstrap DIGEST` accepts only an idle, execution-disabled journal and root-owned OBSERVE configuration. It writes a durable bootstrap receipt before installing/starting the single controller service. A started process reports a fresh journal epoch and `reconciliation_required: true`; installation is not activation.

For an upgrade, a root-owned immutable intent file at `/var/lib/club-arena-release-controller-upgrades/<operation-id>.json` must reference an already pending external operation on the active release and current journal instance. The exact `native_upgrade` object must also occur as `controller_upgrade` metadata on the matching component of that release's resolved manifest. It includes prior/target bundle digests, service name, compatible schema versions and prior epoch. The already installed `upgrade-check.mjs` verifies that binding before stopping the predecessor. Dispatch through `club-arena-release-controller-upgrade@<operation-id>.service` uses the existing native service manager, not another persistent coordinator.

The oneshot fsyncs the original intent/checkpoints, stops the old service, atomically swaps the version pointer, installs the reviewed service bytes, starts the successor and requires a fresh PID/epoch/instance startup receipt. Interrupted STOPPED/INSTALLED transitions resume the same intent. Failed startup restores the compatible prior bundle; interrupted restoration resumes restoration rather than trying the failed candidate again. Three native restart attempts bound automatic retries. Neither success nor rollback marks the release complete: receipts explicitly say RECONCILIATION_REQUIRED, and the original global external operation remains owned until independently reconciled.

The unit and installer files are implementation artifacts. Native systemd execution, loaded-unit acceptance, identity/credential installation, host capacity and real provider access have **not** been certified from this macOS workspace. Tests use isolated native PostgreSQL, loopback HTTP, child processes, real filesystem/fsync/rename and explicit systemd/SSH boundary fixtures.

## Operator interfaces and validation

From `operations/release`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:native
node cli.mjs observe --once
node provider-cli.mjs plan qualified-plan.json operator-name
node provider-cli.mjs register-installation installed-evidence.json verifier-name
node provider-cli.mjs recheck bounded-readback-request.json operator-name
```

`plan` input is `{release_id,operation_key,adapter,request}`; `recheck` input is `{operation_id,reason}`. These use the explicit private journal connection and existing role grants. Do not substitute the broad production account. Runtime entry is the immutable installed `controller.mjs /etc/club-arena-release-controller/controller.json`; repository execution cannot satisfy installed-bundle verification. The shipped example config contains only `{"mode":"OBSERVE"}`. Real adapter scopes, SSH alias, credential reference and host configuration are deliberately absent until verified installation.
