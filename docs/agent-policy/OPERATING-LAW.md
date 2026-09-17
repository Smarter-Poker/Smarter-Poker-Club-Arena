# Smarter Poker Agent Operating Law

Version 2.3 — adopted operating instruction, September 17, 2026.

Owner authorized installation and instruction alignment on September 17, 2026. This consolidates the four rules described in the supplied conversation; the earlier full 2.2 document was not supplied.

## Purpose and authority

This addendum applies to agents working on smarter.poker / World Hub, Club Arena, Club Commander, and the Club Arena engine. It adds precise continuity and cutover behavior to existing instructions. It does not replace the hardening standard, authorize a release, expand an assignment, or change application behavior.

Follow applicable higher-priority instructions and the latest explicit owner directions. On the owner's Mac, the current shared owner policy is `/Users/smarter.poker/Documents/AGENTS.md`; the implementation standard is `/Users/smarter.poker/Documents/AGENT-HARDENING-STANDARD.md`. Club Arena and World Hub use their current `AGENTS.md` and `PUBLISHING.md`. Older playbooks are subordinate where those owner instructions expressly supersede them.

The four rules below are cumulative. Blocker recovery takes priority over optional improvements; useful work during a wait never overrides scope, release readiness, maintenance, ownership, or required checks. A checkpoint records authority already granted; editing it cannot create authority. A one-time exception ends at its stated limit and is not a standing exemption.

## 1. Stay within the assigned operation

Keep a finite assignment, expected behavior, acceptance criteria, and explicit exclusions in the existing task checkpoint or handoff. Apply the hardening standard's scope and connected-flow requirements instead of creating a second implementation checklist.

Scope includes behavior, operational actions, schemas, configuration, dependencies, and affected user flows—not just filenames. Necessary supporting changes may proceed under existing authorization when they directly repair the assigned behavior or a demonstrated delivery blocker. Record why they are necessary. An unrelated discovery, possible optimization, shared directory, or spare time is not authorization for another project. Record unrelated findings for follow-up.

Do not repeat a permission request for work already authorized. Do not use this law to infer permission for destructive actions, new product phases, a different publication route, or changes owned by another task.

## 2. Re-read the required references whenever work resumes

At task start and every resumption after a pause, handoff, restart, crash, reconnection, context reset, or compaction, freshly read the full current required Markdown references and the task's current checkpoint **before making changes or retrying an interrupted action**. Memory, cached excerpts, an old conversation summary, or an earlier reading receipt does not replace those reads. Routine sequential tool calls within uninterrupted work are not separate task restarts.

The required set is:

1. Current shared owner instructions and the hardening standard, where applicable and accessible.
2. Current repository instructions and instruction files applying to the actual paths being worked on, including relevant nested or override files and vendor-specific entry points.
3. The active publishing procedure when delivery is assigned.
4. References explicitly required for the assigned area, relevant phase, and current blocker, plus the task's existing checkpoint or handoff.

Use the reference index to name those exact files. “All references” means this complete required set; it does not authorize an unrelated scan of every Markdown file in every repository. An agent cannot omit a required document by leaving it out of the index. Add newly required references when scope or an affected dependency changes, without expanding the assignment.

Verify the actual checkout, branch, PR, provider run, selected component revision, and installed migration state as relevant. Determine whether interrupted actions already completed before retrying them. Preserve operation identity and pending/unknown outcomes under the existing hardening standard.

Record a concise reading receipt in the existing checkpoint: time, actual file paths, and available policy version or Git revision. This is a handoff record, not a new approval label, release gate, or proof that the agent obeyed the policy. If a required reference is unavailable, try its verified canonical source; report the precise gap and do not proceed with actions whose authority or correctness depends on it. Do not claim a file was read when it was not.

## 3. Resolve a failed delivery before optional work

For an assigned deployment that fails or becomes blocked, enter blocker recovery. Work on the demonstrated blocker, its smallest correct source/configuration repair, directly necessary validation, protected integration, the existing publication route, and final verification. Do not start unrelated work or optional improvements as a substitute for resolving it.

Follow the existing hardening standard and publishing procedure: first find the last successful comparable check or deployment and its evidence; compare source, inputs, configuration, and environment. Reuse the proven mechanism. State when no successful baseline is available. A repeated failure with unchanged evidence requires diagnosis, not another blind attempt or a replacement pipeline.

Retain successful evidence for unchanged inputs. Re-run checks affected by the repair and all checks required for the final candidate. Do not weaken checks, lower acceptance criteria, bypass protection, replay installed migrations, or manufacture readiness. A timeout or disconnected tool is not proof that a remote operation failed; establish its authoritative outcome before an action that could duplicate a side effect.

An authorized delivery remains unfinished until its applicable acceptance criteria are met, including publication, actual component identity, installation readback where relevant, and the affected behavior. Source, checks, merge, installation, publication, and live verification remain separate evidence states. A green engine job that deferred or skipped cutover is not a completed engine release.

When an external constraint prevents further progress, retain the exact pending operation, blocker evidence, attempted remedies, and next action. Continue eligible work under existing authorization; do not claim completion. Work awaiting a provider does not become abandoned, and its outstanding verification remains owned. Do not create a watcher, recurring agent, scheduler, or repair loop to finish it.

One writer owns a particular deployment operation or task record at a time. A replacement must verify current ownership and actual remote state before taking over. A returning agent must not compete with its replacement. This rule does not create one global deployment owner or an agent-managed queue: independent authorized workstreams remain independent, subject to real dependencies and existing provider concurrency controls.

### Failed deployment: immediate recovery, no invented hourly cooldown

A failed attempt must not automatically become “try again next hour.” Diagnose and repair the failure immediately, revalidate the affected inputs, and submit the corrected attempt through the owning protected route as soon as it is eligible. Do not wait for `:55` to investigate, fix, build, test, stage, or recover missing verification.

Classify the authoritative state before deciding what to repeat:

- **Build, test, configuration, or preflight failure:** repair the actual blocker and promptly rerun the necessary failed or invalidated stages. Reuse successful stages only where the existing workflow supports that reuse for the same inputs. Do not impose a maintenance wait on work that cannot change the running engine.
- **Transport or acknowledgment failure:** establish the durable remote outcome and reattach to the existing operation. Do not launch a competing release merely because the local connection failed.
- **Cutover failure:** use the existing owning transaction's recovery behavior, establish the serving version and active-operation state, then prepare the corrected release. Reassess the current certified window immediately. A new cutover may proceed only with sufficient proof/recovery time and all required safeguards.
- **Publication succeeded but verification failed or is missing:** check the exact installed/live state and repair or rerun the failed verification when appropriate. Do not restart a healthy, already-published engine simply to regenerate evidence.

Record failure time, diagnosis, fix-ready time, corrected submission, cutover eligibility, and final verification. Separate time spent doing the repair from time blocked by the release mechanism. “Waiting for next hour” is incomplete: identify the actual failed gate, remaining safety budget, and earliest permitted continuation.

**Engine recovery requirement and implementation boundary:** remove the avoidable hourly retry delay in the owning release and maintenance transaction. The required design is an additional bounded, certified recovery opportunity after a corrected failed release, with the same draining, durable freeze, ownership, proof, rollback and thaw guarantees. The reviewed implementation requires 285 seconds remaining in a 300-second hourly window; this instruction alone does not change that guard. Until the connected implementation and relevant installed database contract are verified, use the existing certified window and report the exact admission gap. Never reduce the recovery reserve, extend a live freeze, or restart active games to satisfy a speed target.

## 4. Be ready for cutover and use waiting time productively

Apply this timing rule only to a delivery with an actual maintenance cutover. `:55` refers to the engine's applicable existing route; it is not a new schedule for World Hub, Commander, or client publication. Use the current authorized workflow and readiness evidence to establish the next eligible window. Record its absolute time and time zone; wall-clock time alone does not authorize a restart.

Prepare the required source, checks, build, sealed release evidence, compatibility prerequisites, and verification steps before the window. Preserve maintenance and database safeguards, active games, the sealed candidate, and existing provider concurrency.

- **Five minutes or more remain:** do useful, finite work within the authorized scope that leaves the prepared release intact. Examples are finishing missing release evidence, reviewing an unresolved risk, preparing the exact post-deployment verification, improving the handoff, or preparing a next phase already authorized by the owner. Keep candidate-changing work separate and do not silently alter the release being published.
- **Fewer than five minutes remain:** brief standby is permitted when the release is ready and switching work would risk missing the window. Standby is not permission to bypass readiness or force cutover.
- **A blocker exists:** Rule 3 governs; optional improvements do not displace blocker repair.

The existing owner policy permits separately authorized work while provider jobs run. Record the pending run and remaining verification before switching, and retain responsibility for the result. Do not create a new assignment merely to appear busy.

If no useful authorized work remains, record that fact and the exact external dependency rather than inventing changes, repeating passed tests, or entering an indefinite audit. This reconciles the productivity rule with the existing finite-scope and no-duplicate-work requirements; it does not turn an incomplete deployment into success. Do not install a timer, polling repair loop, recurring task, or release watcher to enforce this rule.

## Existing protections remain authoritative

Keep the current approved publication routes and required automated functional, security, financial, migration, and maintenance checks. Follow the latest owner treatment of historical-reversion reporting; do not recreate `revert-approved`, a replacement approval label, or a separate acknowledgment gate.

Do not restore revoked restoration-owner waits, numbered delivery queues, GitHub Actions spending controls, retired local/custom publishers, release autopilot/watchdogs/repair paths, or removed external error telemetry. Preserve unrelated non-Actions budgets, unrelated existing business schedules, credentials, other agents' work, and production records.

A newer protected release can contain several agents' changes. Record the actual selected component revisions and prove inclusion and preserved behavior; do not replace a newer valid release merely to match an older SHA. Evidence must match the actual relevant source, configuration, migrations, and environment. A changed relevant input invalidates affected evidence.

Do not add blanket player, table, club, or account lockouts to enforce agent compliance. Preserve the existing transaction safeguards and authorized maintenance behavior.

## Canonical references and maintenance

The shared Mac sources are `AGENTS.md`, `AGENT-OPERATING-LAW.md`, `AGENT-HARDENING-STANDARD.md` and `AGENT-REFERENCE-INDEX.md` in `/Users/smarter.poker/Documents`. Their portable repository mirrors are `docs/agent-policy/OWNER-POLICY.md`, `OPERATING-LAW.md`, `HARDENING.md` and `REFERENCE-INDEX.md`. Entry points link to these sources instead of maintaining competing rules. Update the affected sources and mirrors explicitly when policy changes; do not install a synchronization service.

Use the latest applicable explicit owner instruction if a mirror is older. Repository `PUBLISHING.md` supplies the component-specific release procedure; product and financial laws in `CLAUDE.md` and area references still apply. Historical handoffs and programme plans supply evidence and dependency context, not standing release authority or automatic scope expansion.

Markdown specifies expected behavior. Keep installed instructions, a session's fresh reading, executed checks, and verified delivery separate. A file or reading receipt cannot prove that every running agent loaded or obeyed the policy.
