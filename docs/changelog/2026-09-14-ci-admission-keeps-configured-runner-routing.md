# CI Admission Keeps Configured Runner Routing

Two main-branch changes disagreed: the admission regression test required every heavy job to run on `ubuntu-latest`, while the approved runner routing uses `vars.CI_RUNNER` with a hosted fallback for credential-free jobs. This stopped repository checks before TypeScript compilation.

The regression now asserts the exact configured route for those five jobs and retains `ubuntu-latest` for the isolated PostgreSQL accounting fixture. Admission ordering, read-only permissions, refusal propagation and the prohibition on bypasses remain checked. No workflow or runner setting changes.

Validation: all 49 Node admission and aggregate-result tests passed. Separate hosted jobs on the Diamond Spins release failed before starting because GitHub reports an account billing lock; this source correction does not resolve that external condition.
