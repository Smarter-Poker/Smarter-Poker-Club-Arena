# Required agent references

Revision: 2026-09-17. Paths below are required according to task scope, not an instruction to run unrelated programmes.

## Read on every start and resumption

On the owner's Mac, read the full current files in `/Users/smarter.poker/Documents`: `AGENTS.md`, `AGENT-OPERATING-LAW.md`, `AGENT-HARDENING-STANDARD.md`, and this `AGENT-REFERENCE-INDEX.md`. Elsewhere read the portable counterparts in the actual checkout's `docs/agent-policy/`: `OWNER-POLICY.md`, `OPERATING-LAW.md`, `HARDENING.md`, and `REFERENCE-INDEX.md`.

Then read repository `AGENTS.md`, `CLAUDE.md` where present, `AGENT-PLAYBOOK.md`, applicable vendor and nested path instructions, and the current task checkpoint. Read `PUBLISHING.md` when delivery is assigned. Add references explicitly required by the affected area or current blocker; this index cannot remove those requirements.

## Component map

| Assigned component | Repository | Additional applicable references |
| --- | --- | --- |
| World Hub / smarter.poker | Smarter-Poker-World-Hub | Relevant route, API, database and feature laws; migration safety for database changes |
| Club Arena client | Smarter-Poker-Club-Arena | `.agent/architecture/deploy-paths.md`, relevant product laws and client checks |
| Club Arena engine | Smarter-Poker-Club-Arena | `CLAUDE.md` maintenance rules, `.agent/architecture/deploy-paths.md`, owning release/maintenance contracts; `docs/HANDOFF_CURRENT_STATE.md` and `docs/ENGINE-RESTART-PROGRAMME.md` only for that assigned programme |
| Club Commander | smarter-poker-commander | Applicable `docs/runbooks/`, Commander product laws and verified provider configuration |
| Shared Commander package | commander-shared | `README.md`, `PUBLISHING.md`, consumer vendoring and lockfile contracts when assigned |

## Keep one checkpoint per task

Use the existing handoff, adding only missing fields: scope and authorization; acceptance criteria; owned checkout/branch/PR; operation owner; fresh reference reading time and versions; successful checks and input identities; blocker and comparable successful baseline; pending provider run and component revision; actual cutover eligibility; remaining verification; and next action. Record diagnosis/fix-ready/submission/verification times for failed deployments. Never put credentials or environment-file values in the checkpoint. A receipt cannot grant authority.

Historical handoffs, audits and programme plans remain dated records. Do not execute their retired release instructions. Preserve actual schema dependencies, product/financial rules and task-specific holds; use the current owner policy and maintained publishing procedure for execution.
