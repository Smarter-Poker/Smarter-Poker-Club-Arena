# Release Fixtures Own Their Git Configuration

## Demonstrated Defect

The real Git fixture in engine-release-seal.law.test.ts removed seven repository environment variables but retained GIT_CONFIG and injected Git configuration. A reproduction using two new disposable repositories showed that the retained GIT_CONFIG redirected the fixture's Release Law identity writes into the sentinel repository's config, leaving the intended fixture without its identity. This establishes an isolation defect, not attribution of the separate reported shared-repository bare or identity changes.

## Change

Fixture Git subprocesses now discard inherited GIT\_\* settings, disable system configuration, and use an empty global configuration inside their disposable sandbox. The image-builder fixture uses this environment for both setup commands and its builder subprocess.

Three behavioral cases supply hostile repository pointers, an explicit sentinel configuration file, and injected configuration. Each must initialize, configure and commit only in the disposable fixture while leaving the sentinel configuration, HEAD, index and unresolved HEAD unchanged. No shared Git configuration or production release code is changed.

## Verification

All 30 engine release-seal law tests passed, including the three new adversarial Git environment cases and the existing image-builder fixture (Vitest 4.1.11; 11.39 seconds). The run used the coordinator worktree's existing Vitest dependency read-only with a temporary Node-environment configuration, without installing or copying dependencies. The original reproduction is recorded at /tmp/codex-chip-entry-git-isolation-repro.json and the passing run at /tmp/codex-chip-entry-seal-shared-tests.log. git diff --check passed.
