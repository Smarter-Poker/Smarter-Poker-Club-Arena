# Mandatory source fixes, hardening and regression protection

Policy version: 2.9 — September 17, 2026. Standing owner standard effective September 15, for every agent, vendor, project, repository, alias, worktree and projectless task. Read at task start/resumption and before final validation/completion. Authorization and release routes are in the owner policy; continuity is in the operating law. Later explicit owner directions and higher-priority instructions take precedence.

## Durable correctness at its owner

Every assigned build, fix, improvement, enhancement, upgrade, refactor or optimization must repair the authoritative source, validate actual behavior, harden identified failure modes and retain proportionate regression protection. This includes code, UI, schema, configuration, infrastructure, tooling and instructions.

“Hard coded” means a maintained source fix in the owning code/schema/constraint/configuration. It does not mean embedded secrets, arbitrary constants, demo data, temporary runtime edits or one-time cleanup presented as a permanent fix.

Do not add watchers, cron jobs, background reconcilers, polling repair loops, recurring cleanup, scheduled agents or renamed equivalents to implement, finish or harden a change. They must not supply correctness, repair state repeatedly or initiate, advance, retry or certify releases. Put correctness in the original request, transaction, state transition or explicit event, with bounded execution and an authoritative result.

Preserve unrelated scheduled business behavior and existing observation-only reporting. New scheduled functionality needs explicit task-specific instruction. If an existing repair loop is involved, replace its correctness dependency within scope before retiring it and preserve necessary business behavior. An observer may report failure; it cannot qualify a broken implementation as fixed.

## Finite acceptance and connected implementation

1. Define assigned area, intended behavior, affected components/user flows, invariants, acceptance criteria and exclusions in the existing checkpoint. Necessary dependencies are part of the inspection, not permission for a product-wide audit or unrelated cleanup. Record outside findings separately. Preserve approved business behavior, designs, financial rules, ownership, credentials and other agents' work.
2. Inspect the whole directly affected implementation and callers for unfinished branches, placeholders, fake success, no-op handlers, swallowed errors, wrong imports/parameters, missing return paths, unhandled promises and code never invoked. Read TODOs/disabled paths in context; their existence alone is not a defect.
3. Trace trigger → wiring → authorization → persistence/transaction → events → consumers → observable result. Verify producer/consumer agreement on names, identifiers, types, units, permissions and events. Confirm the runtime actually invokes the repair and its result reaches the consumer; include refresh/reconnect/persistence where relevant.
4. Reproduce the defect safely when feasible. Compare the last successful equivalent using actual source/input/environment and retained evidence, or state that no baseline exists. Fix the cause, including directly affected alternate paths, with the smallest supported correction. Do not hide it with arbitrary delays, repeated refreshes, silent defaults or a replacement pipeline. Never claim reproduction that did not occur.

## Hardening and verification

5. For persisted state and transactions, verify validation, authorization, atomicity, concurrent updates, legal transitions and duplicate requests. Retain operation identity and authoritative pending/unknown outcomes through interruption. A timeout does not establish failure/cancellation. Before retrying a possible side effect, read its durable outcome; recovery belongs to the original owner and needs duplicate-effect protection. Do not assume reverting code reverses committed data.
6. For interfaces, handle relevant loading, empty, error, stale and repeated-action states. Add safeguards only for demonstrated realistic risks. Do not introduce blanket player/table/club/account lockouts. Preserve required transaction-level checks, notifications, traceable financial history and existing logging. Never conceal errors or silently alter records to manufacture success.
7. Run meaningful, proportionate verification: focused unit/integration/browser/contract checks as appropriate. Critical connected behavior needs real components in isolation; mocks alone do not prove database, permissions, worker or event delivery. Derive expected results independently where practical. For a safely reproducible defect, show the regression fails before and passes after; otherwise report the limit.
8. Test relevant boundaries: invalid input, permission failure, duplicates/concurrency, disconnect/reconnect, delayed events, partial completion/restart, rounding, timing and dependency failures. Preserve reproducible inputs for nondeterministic failures. Keep destructive/fault/synthetic financial tests away from active production players and games. Do not turn small work into unrelated stress testing or create tests for trivial cosmetics.
9. Retain regression protection in the same maintained change and existing directly triggered verification workflow. Run it for every relevant shared input. Required checks must actually execute; test-file existence is not enforcement. Never weaken assertions, silently skip, suppress failures or substitute repeated reruns for fixing flakiness. If enforcement/execution access is unavailable, finish eligible source/review work and name the exact gap.
10. Follow the owner policy's exact-candidate local prechecks, private dependency rules and protected provider route. Check the final changed version after fixes/integration. For compatibility, migrations or persistent state, validate transition and recovery. When deployment is assigned, verify actual installed/live identity and affected behavior through authorized access.

## Completion

Close only when the finite acceptance checklist is satisfied, connected wiring is verified, identified in-scope defects are resolved, safeguards exist and appropriate regression checks ran. Record scope, cause/repair, validation, safeguards, retained tests, revision/deployment evidence and remaining limitations concisely. Keep implemented/tested/merged/installed/deployed/live-verified states separate.

Continue independent useful authorized work around a genuine outside dependency and report the precise blocker. Do not expand access/scope or invent passing results. Once sufficient evidence exists, finish rather than repeat audits. No statement can promise that future failures are impossible.

When delegation is already authorized, include the exact scope and this standard, then verify returned evidence yourself. This standard does not authorize spawning agents or unsolicited messages. Policy belongs in Markdown entrypoints, never credential files or an environment flag claiming agent compliance.
