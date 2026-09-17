# Publishing through the restored providers

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

## Club Arena engine and other changed components

For engine changes, use the existing **stage-engine-release.yml** followed by **auto-deploy-hetzner.yml**. Preserve the hosted engine checks, production-door checks, Hetzner build, maintenance cutover, concurrency, sealed receipt and applicable post-deployment verification.

Record the staging run, selected runtime component revision and receiving engine release run. The runtime component revision can differ from a later documentation-only main revision. Confirm the expected component revision at **https://engine.smarter.poker/health** together with the existing release proof. A health response alone is not proof that the changed feature works.

If the assigned change includes monitoring, use its existing **deploy-monitoring.yml** route and final loaded-configuration verification. If it includes a database change, qualify and apply the exact migration through the configured authorized installation path, then read back the installed state and migration history. A merged migration file is not an installation. Do not replay installed migrations or assume an engine deployment applies them automatically. Preserve any actual application compatibility/cutover prerequisites.

## Concurrent deliveries and completion

Continue other authorized work while provider jobs run. Keep the exact pending run/revision and inspect the result afterward; do not create a watcher, scheduler or repair loop. A provider may serialize a shared production resource or publish a newer protected revision containing several agents' changes. Record the actual selected revision and prove it contains your merged change; do not force an older revision over a newer release merely to obtain a matching number.

Report the PR, merged revision, applicable checks, installation evidence, successful publisher/deployment, actual live revision and affected-behavior result. Keep submitted, tested, merged, installed, published and verified live separate. Never claim the entire delivery is complete from a push or green build alone. Six minutes remains a performance target, not a guaranteed duration.

The restored production builds use GitHub, Vercel and Hetzner; reasonable provider compute is authorized. The M3/SSD can hold source and owned worktrees. Do not reactivate retired custom/local pipelines, release watchdogs, repair loops or Sentry integrations. A self-hosted build upgrade requires a later explicit owner instruction.

On the owner's Mac, also read /Users/smarter.poker/Documents/AGENTS.md and /Users/smarter.poker/Documents/AGENT-HARDENING-STANDARD.md. Preserve later owner instructions and the assigned scope. Never print credentials or copy values from .env files into commands or documents.
