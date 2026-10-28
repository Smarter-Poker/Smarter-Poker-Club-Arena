# Delivery bottleneck repair

Owner request: remove unnecessary repeated checks and runner queues without weakening financial safeguards.

Task owner: chat 01a180e9-6246-7c10-b6f6-f98ba932579e; branch fix/delivery-bottlenecks-01a180e9; private SSD worktree delivery-bottlenecks-01a180e9/tree.

Scope: existing CI and local submission route. No application, financial SQL, engine activation, production writer lock, required-check names or financial test coverage changes.

Read current canonical policy 2.9 and repository AGENTS.md, CLAUDE.md, AGENT-PLAYBOOK.md, PUBLISHING.md. Canonical check passes; manifest SHA256 a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Full version/hash receipt retained at /Volumes/SmarterArchives/agent-evidence/delivery-bottlenecks-01a180e9/policy-read.txt.

Evidence: original tournament CI run 40631924465 waited from 04:22:07Z creation until 04:34:55Z for classification; compiler started at 04:41:40Z. Supersede workflow 40636192038 did cancel obsolete heavy jobs at 05:08Z. Existing supersession therefore stays intact. Current account is GitHub Pro, personal repository owner; larger organization runners are unavailable through that owner model.

Changes: source-window and matte checks share the existing compiler checkout/install on PRs, preserving their independent schedule route. No changed-file predicate may hide them. Local pre-push executes source-contract tests once, then excludes those exact files from its related-test pass. The same exact-file deduplication applies to server changed tests, source contracts and related tests. All other related tests and failures remain mandatory.

Acceptance: real-hook regression exercises selected contracts, exact exclusions, and failure propagation; affected workflow contracts pass; normal hooks; protected merge; new provider run proves the redundant PR runner/install is absent and required final-head checks still execute. Queue elimination or a universal delivery-time promise cannot be claimed from source changes alone.

Local validation: 854 affected workflow tests passed; 97 supersession/source/hook tests passed; 2 executable hook regressions passed, including failure propagation. Both client and Node TypeScript configurations pass. actionlint accepts the changed workflow. Matte scan and ordinary submission hooks pending. No merge or operational speed claim yet.
