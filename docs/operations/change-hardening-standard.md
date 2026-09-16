# Change hardening standard

Implementation supplement to the standing owner instruction, September 15, 2026. Read the actual current `/Users/smarter.poker/Documents/AGENT-HARDENING-STANDARD.md` and `/Users/smarter.poker/Documents/AGENTS.md` at task start, after resuming/context loss and before final validation/completion. Those files are authoritative; this document records application to Club Arena and does not replace them, certify another area's catalog or broaden this assignment.

Hardening belongs in the change itself, not in a final optional cleanup pass. It reduces known failure classes; it cannot guarantee that future failures are impossible. Apply checks according to impact: a wording change needs appropriate review, while a financial or distributed lifecycle change needs the actual authority, failure and recovery cases below.

## Finite scope and direct execution

Each change needs a finite scope, preserved business rules and a completion checklist. For the current MTT change, use the [R46 completion checklist](../audits/2026-09-15-r46-hardening-checklist.md). Keep unrelated findings separate and coordinate only the specific dependency with its owner. Do not restart accepted work or launch retrospective audits merely to apply this standard.

Do not add watchers, cron jobs, background reconcilers, polling repair loops, recurring cleanup, scheduled agent tasks or equivalent repair/release mechanisms. Correctness belongs in the original request, transaction, state transition or explicit event, with bounded execution and an authoritative outcome. Existing scheduled tournament business behavior remains in place; R46 changes its creation transaction and does not add a repair scheduler. Observation-only monitoring is not completion evidence.

Retain regressions in the existing directly triggered verification path and establish that they actually execute for affected changes. Do not conceal failures, use broad operational lockouts as a shortcut, or repeat flaky tests until one run passes. If execution or enforcement is unavailable, state the exact gap and keep the affected acceptance item open.

## What every behavioral change must establish

1. **Failure and invariant.** State the concrete old trigger, expected behavior and shared rule that was violated. Create a regression that exercises the failure through the relevant production entry point. Reproduce the old failure where the environment permits; when it does not, record that missing evidence explicitly.
2. **All writers and readers.** Trace manual creation, scheduled creation, restart/recovery, APIs, background workers, storage constraints and UI projections as applicable. Put a shared rule in its authoritative layer. A UI guard or one service helper cannot protect an alternate database writer by itself.
3. **Durable identity and recovery.** For effects that must happen once, enforce identity atomically in the authoritative store. Cover overlapping workers, partial progress, lost responses, process restart and old-owner fencing. Specify and enforce the admitted transaction isolation model; a row lock alone is not proof that a cross-row decision uses fresh data. An unknown response must preserve uncertainty until durable evidence resolves it; a retry must not create a new economic intent.
4. **Compatibility.** Cover old stored rows, current rows, upgraded writers/readers and failed or partial installation. Preserve accepted contracts and historical receipts. Define the coordinated transition when mixed versions are unsafe, and prove old writer retirement before claiming enforcement.
5. **Meaningful regression catalog.** Test behavior and invariants, including adverse cases appropriate to the change. Source-string guards can protect deliberate structural boundaries, but cannot replace actual nested calls, database transactions, triggers, concurrency or served UI checks. Run both focused regressions and the full required affected catalog on the final source.
6. **Independent review.** Review causes, changes, call sites, omitted paths, assumptions and test quality. Resolve concrete findings, then bind review and execution receipts to the final bytes. A review of an earlier revision does not qualify later edits.
7. **Operational acceptance.** Separate source, checks, installation, deployed identity and live behavior. Confirm real progress and accounting outcomes. Include bounded failure reporting and a reviewed rollback/roll-forward path. “Running,” a healthy heartbeat or transport acknowledgment is not proof that the user operation succeeded.

## Area-specific required evidence

| Area | Additional invariants |
| --- | --- |
| Wallets, prizes, rake, bounty, refunds and tickets | Integer-unit conservation; exact funding source/destination; one effect per intent; durable replay; cancellation/settlement races; outstanding liabilities remain visible. |
| Game and tournament lifecycle | Correct ownership and clocks; admitted hand completion; acknowledged level changes; physical seating and chip conservation; break drain/thaw; legal elimination; winner/qualifier and terminal closeout. |
| Authentication, roles and settings | Actual caller roles and session expiry; denied cross-owner access; persistence and reconnect behavior; privileged workers do not bypass product constraints. |
| Realtime and UI | Server-authoritative state; reconnect and out-of-order update handling; no stale success, silent error, lost preference or unsupported action; meaningful phone/browser coverage. |
| Background jobs and automation | Durable work identity, bounded attempts/concurrency, recoverable progress and actual terminal evidence; multiple workers cannot duplicate effects or starve later work. |
| Data/schema changes | Fresh body/schema/ACL pins; complete dependency and trigger graph; lock/time bounds; atomic refusal on drift; data compatibility and recovery after successful installation. |
| Release and infrastructure | Qualified providers and actual runtime composition; exact revision/catalog/operation binding; resource admission; independently observed completion and durable artifacts; deployment and live verification. |

## Current implementation status

The owner policy already requires mandatory pre-submission checks, full catalogs, independent review and source-bound receipts. It is not currently valid to say this standard is operational across every area: the replacement protected pipeline is installed but source jobs and complete catalogs remain unqualified. No additional execution or publication authority is created here.

R46 applies this approach to MTT capacity and satellite creation: shared type rules; database enforcement across writers; durable restart-source identity; serialized recurring feeder creation; explicit target checks; behavioral regression sources and native authority probes. Those new sources are unexecuted. The [MTT qualification supplement](../audits/2026-09-15-mtt-unlimited-qualification.md) lists missing execution, concurrency, financial and release evidence.

The source audit found fragmented enforcement: old capacity rules survived in nested entry authorities; a restart copier dropped a legacy target field; name/time-based restart checks lacked a durable identity; and individually plausible creator/reader assumptions disagreed. Independent review also found that validating a target at feeder creation did not prevent a later unsupported label change on that target; both directions of the relationship now have source guards and regression cases. Those are demonstrated coverage gaps. They do not establish why every earlier production incident occurred or prove that every previous test was inadequate.

Cross-area adoption belongs to each assigned area owner; the mandate is not permission for this MTT task to take over those assignments. Each owner must map the affected real entry points and invariants to the protected required catalog, implement missing checks, and return independently verified receipts. A document, a test file or a local source patch is not an enforced release gate. Once the scoped checks supply sufficient evidence, close that change without repeated re-audit absent a concrete reason.
