# Disposable Git fixtures isolate repository and configuration context

The revert-approval test removed a fixed list of Git repository selectors but
retained arbitrary Git configuration injection variables. Two other real Git
fixtures removed inherited `GIT_*` variables while still loading normal global
and system configuration. Those settings can redirect fixture behavior or invoke
workstation hooks during a test commit.

`tests/helpers/gitFixtureEnvironment.ts` now provides one environment boundary
for these three fixtures. Every invocation removes the entire inherited `GIT_*`
namespace and disables global and system configuration using the platform's null
device. Ordinary test variables remain available. The existing real Git actions,
revert-approval rules, orphaned-work detection, and stale-provenance refusals are
preserved. Actual repository commit and push hooks are unchanged.

Validation:

- Four focused files pass 16 tests. The new tests cover repository selectors,
  direct config files, injected config count/key/value settings, template paths,
  real init/config/commit/ref writes, and an executable injected hook.
- An isolated positive control proves the synthetic hook is executable; the
  protected fixture then commits without invoking it.
- A child process runs all three real guard suites under combined outside Git
  repository, config, and hook injection. The outside repository's configuration
  bytes, all refs, HEAD, worktree status, and injected config file remain exact.
- ESLint and TypeScript checks pass.

This change affects disposable tests only. It adds no release authority or
workflow changes and performs no production action.
