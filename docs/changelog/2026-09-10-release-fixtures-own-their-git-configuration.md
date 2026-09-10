# Release Fixtures Own Their Git Configuration

## Demonstrated Defect

The real Git fixture in engine-release-seal.law.test.ts removed seven repository environment variables but retained GIT_CONFIG and injected Git configuration. A reproduction using two new disposable repositories showed that the retained GIT_CONFIG redirected the fixture's Release Law identity writes into the sentinel repository's config, leaving the intended fixture without its identity. This establishes an isolation defect, not attribution of the separate reported shared-repository bare or identity changes.

## Change

Fixture Git subprocesses now discard inherited GIT\_\* settings, disable system configuration, and use an empty global configuration inside their disposable sandbox. The image-builder fixture uses this environment for both setup commands and its builder subprocess.

Three behavioral cases supply hostile repository pointers, an explicit sentinel configuration file, and injected configuration. Each must initialize, configure and commit only in the disposable fixture while leaving the sentinel configuration, HEAD, index and unresolved HEAD unchanged. No shared Git configuration or production release code is changed.

## Verification

All 30 engine release-seal law tests passed, including the three new adversarial Git environment cases and the existing image-builder fixture (Vitest 4.1.11; 11.39 seconds). The run used the coordinator worktree's existing Vitest dependency read-only with a temporary Node-environment configuration, without installing or copying dependencies. The original reproduction is recorded at /tmp/codex-chip-entry-git-isolation-repro.json and the passing run at /tmp/codex-chip-entry-seal-shared-tests.log. git diff --check passed.

## Archive Producer Completion

The normal pre-push run exposed a separate exit-141 failure in the real image-builder fixture. The builder piped Git archive into BSD tar with pipefail enabled; tar could finish at the end markers before the producer completed tar block padding. A deterministic regression delegates to real Git and appends one MiB of valid zero padding, reproducing the broken pipe before Docker runs. The builder now asks tar to consume through EOF with --ignore-zeros. Pipefail is retained, and an injected archive exit 47 after successful extraction must still block Docker and remove the temporary build context.

Before correction the targeted regression failed with BrokenPipeError. After correction all 30 release-seal law tests passed in 10.49 seconds, including successful clean build, proven image reuse, injected producer failure, staging cleanup and inherited Git configuration isolation. Logs: /tmp/codex-chip-entry-seal-pipe-before.log and /tmp/codex-chip-entry-seal-pipe-after.log. This is isolated source and fixture verification only; no live engine image, tag, host checkout or deployment was mutated.
