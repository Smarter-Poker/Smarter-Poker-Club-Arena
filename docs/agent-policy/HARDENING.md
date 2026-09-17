# Mandatory Source Fixes, Hardening, and Regression Protection

Read `AGENT-OPERATING-LAW.md` for continuity and failure recovery, and `AGENT-REFERENCE-INDEX.md` for the applicable references. In repositories without the Mac files, use the versioned copies under `docs/agent-policy/`.

**Scope precedence for Club Arena / World Hub:** The latest execution state and blocker-only laws in `/Users/smarter.poker/Documents/AGENTS.md` take precedence. Hardening is not permission to expand a pending release into new infrastructure, unrelated audits or repeated verification. Apply this standard only inside the expressly authorized boundary.

Owner instruction, effective September 15, 2026. Applies to every agent, vendor, project, repository, alias, owned worktree, and projectless task, including Club Arena, World Hub, and Club Commander.

Apply this standard whenever you build, fix, improve, enhance, upgrade, refactor, optimize, or otherwise change anything within your assigned area: application code, interfaces, schemas, configuration, infrastructure, scripts, tooling, and agent instructions. It does not authorize a product-wide audit or changes outside the assignment.

Read this standard at the start of an applicable task, after resuming or losing context, and before final validation and completion. Each agent owns the correctness, hardening, and retained regression protection of its own change. When delegation is already authorized, include this standard and the exact scope in the handoff; verify the returned evidence before accepting the work. This standard does not itself authorize delegation.

## Mandatory implementation rule

**Deliver a durable fix in the authoritative implementation, validate the actual affected behavior, harden it against identified failure modes, and retain proportionate regression protection. All four are part of completing the change.**

"Hard coded" means the correct behavior is implemented permanently in the maintained source of truth: the owning code path, schema, constraints, or approved configuration, as appropriate. It does not mean embedding credentials, environment-specific values, arbitrary exceptions, fake data, or magic constants. A manual runtime edit, temporary patch, or one-time data cleanup is not a complete source fix.

**Do not add watchers, cron jobs, background reconcilers, polling repair loops, recurring cleanup jobs, scheduled agent tasks, or equivalent mechanisms to implement, finish, or harden a change. Do not rely on them to supply missing correctness, repair state repeatedly, or hide an unresolved defect.** Renaming the same mechanism a watchdog, self-healer, retry service, or monitor does not satisfy this rule. No such mechanism may initiate, advance, retry, or certify a release.

Put correctness and required validation at the original request, transaction, state transition, or explicit event that owns the operation. Use direct, bounded execution and an authoritative result. A periodic process that eventually repairs incorrect state is not a substitute for preventing the incorrect write or transition.

Preserve unrelated existing scheduled product behavior and observation-only health reporting; this standard is not authorization to delete them. If an existing repair loop is involved in the assigned defect, remove its correctness dependency within scope and retire it only after verifying the replacement and preserving necessary business behavior. New scheduled functionality requires an explicit task-specific owner instruction. Existing observers may report a failure; they cannot make a broken implementation qualify as fixed.

Use Markdown instruction entry points for this policy. Do not put prose policy in `.env`, embed secrets in instructions, or treat an environment flag as proof that an agent loaded or obeyed the standard.

## Scope, authority, and execution

This is the owner's standing implementation standard and supersedes older local instructions that permit symptom-only fixes or omit hardening and regression protection. Follow applicable higher-priority instructions and later explicit owner directions. Preserve existing worktree ownership, credentials, security, financial rules, and release safeguards.

For Club Arena and World Hub, read `/Users/smarter.poker/Documents/AGENTS.md` for the current authorized delivery policy. The owner has authorized the original GitHub-hosted checks, World Hub Vercel source builds and publication, and Club Arena GitHub/Hetzner publication and engine builds, including reasonable provider compute charges. The retired local/custom pipeline must not be used or reactivated without a new explicit manual owner prompt. This standard does not authorize bypassing required checks, erasing production data, or expanding production access beyond the assigned delivery. Other projects retain their own execution policies. If required verification cannot run through the authorized route, complete eligible source and review work and report the exact verification gap; do not invent a passing result or create a workaround scheduler.

1. **Establish And Maintain The Exact Scope**

Identify the assigned area, the specific change, its intended behavior, and the directly affected components and user flows.

Use the task requirements and actual implementation to establish this boundary. A change can affect several files without becoming a product-wide assignment.

Check the dependencies and callers necessary to establish that your change works correctly. Do not expand into unrelated features, other operational areas, a complete product audit, or a retrospective review of every previously completed task.

If you discover a potentially related issue outside your assignment, record the evidence, explain its connection, and identify the narrowly scoped follow-up needed from the responsible owner. Do not launch that additional work automatically.

2. **Define What Correct And Complete Means**

Before verification, state the expected outcomes and the relevant rules that must remain true.

Identify what your change is supposed to improve, what existing behavior it must preserve, and how success or failure can be observed.

Use the approved requirements and established business rules. Do not invent new functionality, change business rules, redesign approved interfaces, or introduce unrelated enhancements under the label of hardening.

Create a finite checklist for this specific change so completion can be demonstrated.

3. **Inspect The Entire Affected Implementation**

Review the implementation of the assigned change and its directly connected path for bugs, gaps, stubs, errors, regressions, incomplete branches, and wiring issues.

Where applicable, check for placeholder responses, fake success messages, hardcoded demonstration data, unfinished handlers, no-op functions, missing return paths, unhandled promises, swallowed exceptions, incorrect imports, mismatched parameters, and code that exists but is never reached.

Inspect relevant TODOs and disabled paths in context. Their presence alone does not prove a defect.

Confirm the intended implementation is actually called by the running application. A completed function that the real feature never invokes does not satisfy the task.

4. **Verify The Wiring From Trigger To Final Result**

Trace the actual affected flow from its initiating action through every necessary connection to its final observable result.

Depending on the change, this may include a button, form, route, API, authorization check, service, database operation, worker, event, subscription, cache, and rendered state.

Confirm that producers and consumers agree on field names, identifiers, types, units, permissions, event names, and response formats.

Verify both that the operation happens and that its result reaches the intended consumer. Check persistence, refresh, or reconnect behavior when relevant.

Test applicable entry points and affected callers within the assignment. Do not treat a working helper function as proof that the connected feature works.

5. **Repair The Cause And Preserve Existing Behavior**

Owner update, September 16: for every blocker, first identify the last actually successful deployment or check in the same component/category, including its revision and run/artifact evidence. Compare the failing source, inputs, configuration and environment against that working baseline. Reuse the proven implementation or make the smallest correction supported by the difference; do not rebuild a working mechanism or add release stages. Record the comparison in the existing handoff/blocker entry, and state explicitly when no successful baseline is available. Preserve unrelated newer work and current execution/spending restrictions when reusing older code.

For a defect, reproduce the failure safely when possible and identify its underlying cause.

Repair the cause within the assigned scope. Avoid patches that merely hide symptoms through arbitrary delays, repeated refreshes, hardcoded special cases, silent fallback values, or periodic cleanup jobs.

Check directly affected alternate paths for the same problem.

Preserve valid existing behavior. If the necessary repair extends beyond your assigned scope, document the specific dependency and required change rather than silently expanding the assignment.

Never claim the original failure was reproduced if it was not.

6. **Harden The Implementation Against Relevant Failures**

Identify the realistic ways this specific change could fail and implement appropriate safeguards.

For changes involving persisted state or transactions, assess validation, authorization, atomicity, concurrent updates, legal state transitions, and duplicate requests.

Where retries or repeated events are possible, ensure they cannot repeat an operation’s financial effect or incorrectly advance its state.

Where interruptions are possible, retain the operation identity and authoritative outcome or an explicit pending/unknown state. Implement bounded recovery at the owning request, transaction, or explicit authorized event, with duplicate-effect protection. Do not add a watcher, cron, or background reconciler to finish or repair it later. A timeout is not proof that an operation failed, never completed, or was cancelled; obtain authoritative evidence before any retry that could repeat a side effect.

For interface changes, address relevant loading, empty, error, stale-state, and repeated-action behavior.

Apply safeguards because they address an identified risk. Do not add unrelated infrastructure or unnecessary complexity.

7. **Use Meaningful, Proportionate Verification**

Owner continuation, September 17: perform applicable local prechecks before pushing, including tests reading documentation/configuration and exact qualification manifests. Follow the owner policy for private SSD dependencies and exact candidate evidence. Missing local tooling does not make an applicable check optional, and hosted checks still remain required.

Verify the intended behavior, preserved behavior, and realistic failure conditions for this change.

Use focused unit tests, integration tests, browser verification, contract checks, or other existing verification methods according to the risk.

Critical connected behavior requires evidence from the relevant real components in an isolated environment. Mocked results alone cannot establish that the actual database, permissions, worker, or event delivery works.

Calculate expected results independently where practical. Reusing the same defective calculation in both implementation and test does not provide meaningful protection.

For a reproducible bug, demonstrate that the regression check detects the defective behavior and passes with the repair, using an isolated environment.

Do not create unnecessary tests for trivial cosmetic edits. Reuse existing coverage and add checks for concrete gaps.

8. **Test The Relevant Boundaries And Interruptions**

Select scenarios that could realistically affect this change: invalid input, permission failures, duplicate submissions, simultaneous requests, disconnects, reconnects, delayed events, partial completion, restarts, rounding, timing boundaries, and dependency failures.

Run only the scenarios relevant to the assigned behavior. Do not turn a small change into an unrelated stress-testing or disaster-recovery project.

Keep destructive tests, fault injection, and synthetic financial activity away from active production users and games.

Preserve reproducible inputs and event sequences for failures that depend on timing or randomness.

9. **Retain Protection For Future Changes**

Retain the appropriate regression checks with the implementation in maintained source and include them in the same scoped commit when committing is authorized. Connect them to the existing relevant, directly triggered verification workflow. Do not create a periodic watcher, cron, or reconciler to execute or enforce these protections.

Ensure applicable checks actually execute for changes that could break the protected behavior, including changes to directly relevant shared dependencies.

Reuse established required checks and release protections. Where focused workflow changes are necessary and authorized, implement them.

If enforcement requires access or a separate global configuration change, prepare the concrete requirement and report that gap accurately. Do not claim that a check is mandatory merely because its test file exists.

Do not weaken assertions, silently skip tests, suppress failures, or accept repeated reruns as a substitute for resolving a relevant flaky test.

10. **Verify The Final Version And Applicable Release Behavior**

Run the necessary verification against the final version of the change after any edits made in response to findings.

If the change affects compatibility, migrations, or persistent state, verify the relevant transition and recovery behavior. Reverting application code must not be assumed to undo committed data changes.

When deployment is part of the authorized assignment, confirm the deployed version and safely verify the affected behavior.

Keep “implemented,” “tested,” “merged,” “deployed,” and “verified in production” distinct. Report only the stages actually completed.

Do not expand deployment or production access beyond the authorization already provided.

11. **Keep Failures Visible Without Broad Operational Lockouts**

Use the existing logging, error reporting, and notification mechanisms where this change requires operational visibility.

Do not conceal failures behind success messages or silently alter records to make a discrepancy disappear.

For accounting-related changes, preserve traceable transaction history and the existing management notification requirements.

Do not introduce blanket table, club, or account lockouts as a hardening shortcut. Continue enforcing necessary transaction-level validation and authorization, including preventing duplicate or invalid writes.

12. **Close The Assigned Change With Evidence**

Before declaring completion, confirm that the scoped checklist is satisfied, identified defects affecting the assigned behavior are resolved, relevant wiring is verified, appropriate safeguards exist, and regression protection is retained.

Provide a concise completion record covering the scope, defects found, repairs made, safeguards added, verification performed, results, relevant commit or deployment references, and remaining limitations.

Record unrelated findings separately. They do not automatically become part of your assignment.

If an outside dependency prevents this change from working or being verified, report that specific blocker. Continue all other work that can be completed safely.

Once the agreed checks provide sufficient evidence, finish the task. Do not repeatedly re-audit verified work without a concrete reason.

Do not claim that future failures are impossible. State precisely what is hardened, what is verified, and what remains unverified.

## Apply This Standard To Every Assigned Change

Each agent owns the hardening and regression protection of their own work. Follow shared repository requirements, coordinate narrowly where dependencies require it, and keep the work within the assigned operational area and specific change.
