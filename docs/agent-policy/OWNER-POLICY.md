# Current Smarter Poker owner policy

Policy version: 2.9 — September 17, 2026. This file owns authorization and provider routes. Read the operating law, hardening standard and reference index alongside it; the index maps canonical and portable paths.

## Authority and scope

No additional owner-imposed human approval is required for necessary work within an authorized assignment, in any repository, service or environment. Complete implementation, configuration, applicable credential repair, submission, protected integration, publication and verification directly. Do not invent a human-only action, permission question, approval label, restoration-owner handoff or numbered delivery queue. Independent authorized deliveries may proceed in parallel.

This supersedes the former root-only restoration ownership, six-stream release order, replay holds and human-only `revert-approved` requirement. Do not replace them with an agent approval, manifest acknowledgment or queue. Silent Revert Guard's historical-content findings are advisory: inspect them, explain intentional restoration in the PR and repair accidental loss of newer work. Unexpected reporting errors remain visible. Preserve all other required automated functional, security and financial checks, migration/maintenance safeguards, transaction integrity and provider concurrency.

Scope remains finite. Reading policy does not authorize another product phase, unrelated work or a different release route. Preserve later explicit owner instructions and task-specific holds. A new STOP halts new operations within its stated scope. Higher-priority instructions and actual tool constraints remain binding.

## Access and credentials

Owner authorization and technical access are different. Check configured supported access, provider permissions, secret names and the intended reporter identity before dependent hosted work. Missing or unreadable metadata is unknown, never proof of access. An unavailable interface is not proof that every configured route is unavailable.

Repair necessary credentials/configuration through authorized tools, preserving service identity, least privilege and the canonical secret store; verify the affected check afterward. Never print secrets, read environment-file values, scrape another task's credentials, guess an identity or substitute a different trusted reporter to manufacture success.

Ask only for genuinely unavailable input or an explicit tool-required handoff, naming its source and exact action. Never request secret contents in chat. A missing input does not stop independent checks, conflict repair or eligible publication. The operating law defines continued ownership and completion; changing Markdown cannot remove authentication or a tool-enforced handoff.

## Storage and local prechecks

All agents on this Mac may use the mounted 2 TB external SSD within assigned scope. Verify mounted, writable storage and available space before use. Put new private worktrees, scratch and authorized caches in a unique task-owned directory under `/Volumes/SmarterWork/agent-work`; retain evidence/source archives under `/Volumes/SmarterArchives/agent-evidence`. APFS quotas may be smaller than the device. Existing directories may belong to other tasks: never overwrite, reset, prune, move or delete them. Move a worktree only with Git's supported operation, preserved clean state and coordinated readers.

Applicable local checks must run before push or publication requests, on the exact candidate. Inspect the final diff and actual workflow: compilation, affected tests/builds, source contracts reading Markdown/scripts/workflows, configuration and qualification manifests all count. Record commands, actual results, tested revision/tree and provider-only pending checks. Recheck affected evidence after edits or integration. Missing tools, stale manifests or incomplete dependencies must be repaired; neither a checkpoint nor hosted CI substitutes for an available local check. Never bypass hooks or weaken assertions.

The SSD authorization permits locked dependencies for local prechecks in a private task-owned directory. Never install through a shared `node_modules` symlink or mutate another task's cache. Hooks inspect and validate; they do not repair shared dependencies. This supersedes the older blanket Mac dependency deferral for this limited purpose. The SSD is local storage, not remote server RAM or permission to restore retired production infrastructure.

## Approved delivery routes

Use owned branches, ordinary hooks, configured Git identity, the existing PR or one new PR when absent, required checks and protected squash merge. A follow-up after a merged PR needs its own branch/PR. Integrate current main when necessary and preserve other writers. Do not rely on disabled autopilot. Use exact current-head checks; an unreadable result is unknown. The operating law defines immediate recovery and component classification.

| Component                  | Existing route and completion evidence                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World Hub                  | GitHub protected merge → Vercel Git source build in `hub-vanguard` → production READY plus `https://smarter.poker/api/health` commit/deployment identity and affected behavior                                                                     |
| Club Arena client          | GitHub protected merge → `publish-club-arena.yml` → successful Hetzner publication, both `https://ca-static.smarter.poker/build-info.json` and `https://smarter.poker/hub/club-arena/build-info.json`, and affected behavior; no World Hub rebuild |
| Club Arena engine          | Existing `stage-engine-release.yml` → `auto-deploy-hetzner.yml`, exact component selection, immutable build/staging, certified activation, sealed receipt, `https://engine.smarter.poker/health` identity and applicable post-deploy proof         |
| Database                   | Exact qualified migration installation and readback, recorded history and actual compatibility/freeze restrictions; never replay an installed migration                                                                                            |
| Commander / shared package | Their maintained `PUBLISHING.md`, provider/consumer installation and verification requirements                                                                                                                                                     |

Client publication has no hourly gate. Only an actual engine replacement or identified dependency on a new engine contract has an engine activation prerequisite. Prepare, check, push, merge, build and stage throughout the hour; do not hold these stages for `:55`. The component revision may differ from a later documentation-only main revision. Prove inclusion when a newer protected release contains the assigned change; never overwrite it just to force an older SHA.

The restored provider routes have successful releases; that does not certify every pending package, the whole application suite or a guaranteed six-minute delivery. Reasonable provider compute is authorized. GitHub Actions-specific budgets and stop-usage controls are revoked; preserve unrelated non-Actions budgets.

Retired local/custom builders, runners, publishers, release autopilot/watchdog/repair paths and removed external error-telemetry integrations remain prohibited. Do not revive them through routine publication authorization. Preserve unrelated existing business schedules, production data, credentials, financial invariants and other tasks' work. No watcher, scheduler, timer or recurring agent may initiate, advance, retry or certify a release.
