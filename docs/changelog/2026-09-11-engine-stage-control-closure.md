# Engine staging includes the controls that execute a release

A main commit that changed only the engine workflow did not trigger the stage
signal. The receiver still required the earlier runtime component SHA, and the
door-check job checked out that runtime SHA for its checker and allowlist too.
That could omit the new control repair even after it reached protected main.

The stage workflow now calls one importable Git classifier. The accepted runtime
paths remain `server/**`, excluding `server/**/*.test.ts` and `server/sim/**`.
Only those paths determine the target component SHA. A release is also required
when any of these exact control files changes:

- `.github/workflows/stage-engine-release.yml`
- `.github/workflows/auto-deploy-hetzner.yml`
- `scripts/ci/check-engine-doors-exist.mjs`
- `scripts/ci/engine-doors.allowlist.json`
- `scripts/ci/record-engine-deploy-attempt.mjs`
- `scripts/ci/classify-engine-release.mjs`

The classifier reads Git history and complete tree differences, independent of
GitHub's truncated push-file lists. A missing or non-ancestor previous commit
requires staging. A runtime change followed by its revert still requires the
new runtime component SHA expected by the receiver.

The door job checks out the exact workflow `CONTROL_SHA` and a separate exact
`TARGET_SHA` source tree. It verifies both commit identities before asking the
database. The checker loads the allowlist beside its own module and scans only
the separate target's `server/src`. Dependency installation disables lifecycle
scripts. A missing target source fails the job; the existing database-unavailable
and rollback policies are unchanged. The CLI also executes through a symlink,
instead of silently treating that invocation as an import.

Validation:

- Six focused test files: 113 tests passed, including temporary Git histories,
  control-only and mixed pushes, multi-commit runtime changes, runtime reverts,
  removed controls, missing previous commits, and invalid target commits.
- Separate temporary SOURCE and CONTROL Git repositories: either wrong SHA is
  refused; the target's stale checker and allowlist cannot replace the control
  policy. Only target source calls are checked, including a symlink invocation.
- Existing engine release seal and absolute deadline tests passed.
- TypeScript `tsc --noEmit` passed.
- Actionlint 1.7.12 passed both changed workflows.
- The actual `07f20782b4c88c0d12a23318d82ba0537aeb4495` control-only regression
  requires a release while retaining runtime component
  `bc525463996c65be3a89a7fe0cb35cd601a0d5e3`.

This is a local repair for review. No production dispatch, deployment, restart,
database mutation, merge, or World Hub change was performed by this task.
