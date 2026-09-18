# Required agent references and evidence tools

Policy version: 2.9 — September 17, 2026. Read full applicable sources at start/resumption and before final validation. This map does not assign unrelated programmes or remove nested requirements.

## Authority and reference roles

| Role                            | Portable source under `docs/agent-policy/` | Canonical source in `/Users/smarter.poker/Documents` |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Active authorization and routes | `OWNER-POLICY.md`                          | `AGENTS.md`                                          |
| Active continuity and delivery  | `OPERATING-LAW.md`                         | `AGENT-OPERATING-LAW.md`                             |
| Active implementation standard  | `HARDENING.md`                             | `AGENT-HARDENING-STANDARD.md`                        |
| Active reference/tool map       | `REFERENCE-INDEX.md`                       | `AGENT-REFERENCE-INDEX.md`                           |

On this Mac read the canonical sources as well as applicable checkout instructions; elsewhere use portable files. Then read repository `AGENTS.md`, `CLAUDE.md` where present, `AGENT-PLAYBOOK.md`, vendor/nested instructions for affected paths, the existing checkpoint, and `PUBLISHING.md` for delivery. Add area/blocker references required by these sources. Later explicit owner directions govern an older mirror.

| Assigned component | Additional references                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| World Hub          | Affected route/API/product/financial laws; migration safety for database work                                                                                                        |
| Club Arena client  | `.agent/architecture/deploy-paths.md`, affected product laws and client checks                                                                                                       |
| Club Arena engine  | `CLAUDE.md` maintenance contract, deploy-paths, owning release/maintenance contracts; `docs/HANDOFF_CURRENT_STATE.md` and `docs/ENGINE-RESTART-PROGRAMME.md` only for that programme |
| Commander          | Applicable product laws, `docs/runbooks/` and actual provider configuration                                                                                                          |
| Shared Commander   | `README.md`, `PUBLISHING.md`, consumer vendoring and lockfile contracts                                                                                                              |

Historical handoffs, audits, changelogs and programme plans preserve dated evidence and dependency context. They are not current release authority or automatic assignments. The manifest marks historical prefixes for the reader; a relevant handoff may still be required. Preserve actual task holds and schema/financial safeguards. Do not delete history or execute retired procedures from it.

## Directly invoked tools

Run from the owned repository. These commands read evidence and validate policy; none publishes, waits on a schedule, repairs production or grants approval.

- `node docs/agent-policy/agent-policy.mjs read` verifies and emits the full four policies plus a version/hash receipt. Read all output before recording it in the existing checkpoint; read other required references separately.
- `node docs/agent-policy/agent-policy.mjs check` validates exact maintained files, tool/tests, version and reference roles against `policy-manifest.json`. On this Mac add `--canonical /Users/smarter.poker/Documents`; compare an explicitly owned portable copy with `--peer PATH_TO_POLICY_DIRECTORY`. A mismatch requires reconciliation, not overwriting another task.
- `node docs/agent-policy/agent-policy.mjs plan origin/main HEAD` records exact candidate/base/tree, deleted/renamed paths, clean tracked state and component classification. A third JSON-file argument may identify a new engine `dependency` and its `evidence`. Investigate unclassified paths and behavior dependencies; a path classifier is not proof of compatibility.
- `node docs/agent-policy/agent-policy.mjs report EVIDENCE_JSON` summarizes the existing checkpoint's evidence: schemaVersion 1, full `revision`, explicit `requiredEvidence` IDs, and `evidence` entries with id/revision/status/source/observedAt. Status is passed/failed/pending/unknown. Missing provenance, wrong revision, skips and cancellation cannot pass. Optional `state` supplies the observed outcome/access/checks/helper/engineActivationRequired/operation for the next-action decision; missing facts never authorize a retry. Optional `intervals` have phase/start/end/source; phases are preparation, runner-queue, execution, publication, activation, verification. Unknown time remains null.
- `node docs/agent-policy/agent-policy.mjs timing RUN_JSON COMPLETE_JOBS_JSON` reads saved Actions REST responses for the same run. Retrieve every jobs page first. It separates run-level queue and job execution; per-job queue remains unknown when the provider does not expose it. Do not add overlapping jobs or call dependency wait worker queue time.

The existing pre-push hook records its actual exit status, candidate/tree, policy hash and remaining hosted/publication/live evidence in the worktree's private Git metadata. Copy its concise result/link into the same checkpoint. The receipt cannot prove every check was applicable, every requirement was listed or any agent obeyed instructions. Existing required CI checks invoke the policy verification and scenarios; provider and behavior proof remain separate.

## Requirement traceability

| Requirement               | Maintained rule                 | Enforcement/evidence boundary                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detect policy drift       | Canonical reference maintenance | Manifest verification and negative corruption/missing-file tests; explicit peer comparison, no automatic sync                                                                                                                                                    |
| Classify delivery         | Operating law §3                | Exact Git diff and classifier scenarios; new contract review remains agent responsibility                                                                                                                                                                        |
| Know loaded version       | Operating law §2                | Full-content reader and hash receipt; emission is not comprehension                                                                                                                                                                                              |
| Remove repeated rules     | Each policy owns one topic      | Canonical mirrors/hash checks; prose review preserves requirements                                                                                                                                                                                               |
| Honest single report      | Operating law §6                | Report rejects missing/stale/unsourced evidence; actual check execution comes from hook/CI/provider                                                                                                                                                              |
| Explain delay             | Operating law §4–5              | Timestamp/provenance checks and provider timing; unavailable measurements remain unknown                                                                                                                                                                         |
| Exercise decisions        | Operating law §3–5              | Executable scenarios for non-engine, failed build, access/helper loss, unknown operation and missing live proof; no claim of an LLM obedience test                                                                                                               |
| Trace every requirement   | This table                      | Source/test/hook/CI references and retained final execution evidence                                                                                                                                                                                             |
| Separate history          | Reference roles above           | Manifest role tests; historical records retained, task-specific prerequisites still apply                                                                                                                                                                        |
| Faster instruction checks | Exact-candidate precheck rule   | CA's immutable-diff allowlist omits only isolated chip-journal replay for four policy Markdown files and their hash manifest; full client/source-contract tests, compiler and repository guards still run; uncertainty or any other path uses the existing route |

Use one existing checkpoint with authorization/scope, acceptance, checkout/branch/PR, operation owner, fresh reading receipt, tested inputs/commands/results, access prerequisites, run/component identity, real blocker/baseline, cutover eligibility, remaining verification and next action. Do not store secrets or duplicate the checkpoint. Policy changes update canonical sources and portable mirrors explicitly through protected review; no synchronization service is permitted.
