# Current agent push and publication path

Read `/Users/smarter.poker/Documents/AGENTS.md` before older repository playbooks.
This applies equally to Claude, Codex and Antigravity, including host-terminal
sessions from Cowork. Use an owned `.agent-trees` feature branch and ordinary
Git/gh host authentication. Project `.env` files and inert CA_ALLOW_* switches
are not the delivery interface. Preserve existing credentials in place.

Commit explicit files with normal hooks and push your owned feature branch.
The existing Agent Branch Proposal signal, Agent Open PR consumer and Agent
Autopilot perform the event-driven PR and protected auto-merge operations when
they are enabled. The signal runs on local untrusted CI; credential-bearing
consumers execute default-branch code on the trusted local publisher. No hosted
fallback, schedule, administrative merge or new worker is involved.

If an existing workflow is disabled, producers can perform those same approved
operations from the authenticated host without a new credential or owner-only
merge power. Create the PR with `gh pr create`, then run the existing maintained
queue helper on that specific PR:

```sh
bash .github/scripts/queue-pr.sh Smarter-Poker/Smarter-Poker-Club-Arena PR_NUMBER
```

That helper preserves holds/drafts, binds the head, and respects GitHub's
required checks. Do not enable a workflow whose source still selects hosted
compute. A submitted PR, an auto-merge request, a successful check and a merged
revision are different evidence. Failed or cancelled current-head checks
remain failures. After diagnosing a cancellation, use one bounded failed-only
replay on the unchanged head; never manufacture commits merely to trigger CI.

The host gh CLI's GraphQL statusCheckRollup can fail with `Resource not
accessible by personal access token`. That is an observation failure, not a
pending check. Existing Actions REST reads provide run/job state:

```sh
gh api 'repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs?head_sha=FULL_HEAD_SHA&per_page=100'
gh api 'repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/RUN_ID/jobs?per_page=100'
```

Read all pages when needed. Likewise paginate runner inventories; the first
page can contain only retired offline workers. Do not alter or extract tokens
to work around a status-display failure. Existing branch rules remain the
merge authority; a run list alone is not a replacement check verdict.

A protected merge triggers the existing client publisher and, for relevant
changes, the existing engine staging/release path. Preserve its maintenance
window and database requirements. Check the exact served build-info identity
and affected behavior; do not assume a merged engine revision has activated.
No dependency install or build belongs in an agent worktree.

September 16 baseline: successful client publisher35127044547 serves ba4c666b9f
and includes PR4681/4685. Engine release35127285883 was still in progress at
inspection. Read current evidence for later releases.
