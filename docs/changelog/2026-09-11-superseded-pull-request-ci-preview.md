# Preview only superseded Club Arena pull-request CI

CI's existing concurrency group includes the PR head SHA. It preserves each
head's required checks but also lets superseded heads continue consuming runners.
Observed run 34628991899 overlapped its exact-head successor 34630011883 for
163 seconds in the server job. The existing CI concurrency keys remain unchanged.

The new workflow is triggered by CI run events and checks out the exact
default-branch control SHA. It reads no PR source, artifacts, or cache, and
installs no branch dependencies. Its default preview token has read-only Actions
permissions. A separate apply job requires the explicit repository variable
`CI_PR_SUPERSESSION_APPLY=true`; no variable is created or modified by this change.
The variable was absent during preparation.

The helper pins Club Arena repository ID 1132369872 and CI workflow ID 247739539
at `.github/workflows/ci.yml`. Every candidate must belong to the same open PR,
repository, and branch, have `event=pull_request`, and have a head different from
the freshly read PR head. The replacement must be the exact current head and
either in progress or successfully completed. Merely queued replacements are
insufficient. Dispatch, push, scheduled, publisher, and native engine-operation
runs are excluded. No required check is removed or weakened.

An old run's PR association already reports the newer PR head in the GitHub API:
run 34630082688 retained `head_sha=2395820fe0c9a078569ccd85ece83ca251677c80`
while its association reported PR 4333's newer head
`8c556505bf306aadfe1cd8052675954b18b2fe05`. The helper therefore uses
`run.head_sha` for run source and the freshly read PR for current-head authority.
PR association data establishes identity and repository/ref linkage only.

Discovery reads both bounded active-run inventories before any mutation. A
truncated, contradictory, or oversized inventory fails closed. Immediately before
each individual cancellation request, the helper re-fetches the workflow, old
run, replacement run, and PR, with the PR read last. A changed run attempt,
identity, PR head, workflow, or successful-replacement status refuses the target.
It never applies a previously prepared list and never force-cancels or retries a
failed cancel request. Receipts distinguish `would-cancel` from `cancel-requested`;
a request is not a claim that cancellation has completed.

GitHub's cancellation endpoint has no condition tied atomically to the PR head.
A PR may change after the last read and before GitHub accepts the cancellation.
The repeated reads bound that race but cannot remove it. Activation remains an
explicit owner decision; this proposal is inactive and performs no cancellation.

Validation passes 256 tests across eleven files, including 91 focused tests for
real API-shaped identities, every excluded operation type,
current-head protection, API errors and malformed JSON, duplicate/overflowed/
truncated inventories, changed attempts, concurrent pushes between candidates,
failed replacements, dry-run defaults, and the separate workflow permissions.
A live read-only run against source 34630735384 succeeded and refused to target
the current successor. Existing authentication was used without reading or
creating credentials. ESLint, TypeScript, Node syntax, and Actionlint pass.

Reference: GitHub documents default-branch execution for
[workflow-run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
and the specific
[workflow-run cancellation endpoint](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run).
