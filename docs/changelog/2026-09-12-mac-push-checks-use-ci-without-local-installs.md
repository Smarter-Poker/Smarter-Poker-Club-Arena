# Mac Dependency Checks Use CI

The user removed worktree dependencies and requires installation in CI. A shared Mac installation could still contain TypeScript and Vitest while missing the phone packages declared by the repository. The local push hook consequently reported missing-package errors as source failures and blocked a branch before CI could install its dependencies.

The hook now inspects declared required packages without writing to the dependency tree. On a Mac with missing or damaged package metadata, client or server dependency checks explicitly defer to required CI. Complete Mac installations and non-Mac hosts retain the existing local checks. Source, SQL, branch, rewind, and other dependency-free guards still run; required CI and publication workflows are unchanged apart from adding the policy's executable tests. No dependency installation, copy, environment override, or hook bypass is introduced.

Ten dependency-policy cases cover Linux enforcement, bare and partial Mac installations, complete installations, damaged metadata, optional packages, malformed source metadata, shared-link preservation, and the command interface. The protected-main ruleset still requires TypeScript, client tests, server tests, production build, CSS browser tests, and the silent-revert guard. A branch push remains unqualified until its exact CI and served-release evidence pass.
