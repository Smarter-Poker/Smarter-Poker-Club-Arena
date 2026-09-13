# Stale Source Fails The CI Build Again

The provenance stamp wrote the correct behind-main count but returned success in GitHub Actions and with STRICT_PROVENANCE=1. That let the existing build:ci command continue to its next stage despite a stale source tree. Commit 8febb9e63a01defa5acf6b3e70ec8469afb048e5 (#166, August 21) replaced the original process.exit(1) with a bypass log; its message records no exception to the stale-source contract. Later edits only renamed the publisher comment and added the native output directory.

The stamp now restores its original nonzero exit for a known behind-main checkout in either strict mode. It still writes the diagnostic provenance artifact first. Local warning-only builds, current or ahead-only source, custom CA_DIST, and the existing unknown-provenance behavior retain their contracts.

The current publisher separately compares the incoming build-info source SHA with the origin's already-served SHA and stands down when the incoming one is behind. That downstream race check is not a replacement for rejecting a source tree behind the fetched canonical main during its build. No workflow or hook was changed.

Nine subprocess cases execute the actual script in temporary real Git repositories. Before the correction, all three strict stale cases failed because the script exited 0; the six compatibility cases passed. The corrected script passes all nine. Fixtures include one-commit-behind CI and strict-local builds, divergent history, local diagnostics, exact current source/run identity, ahead-only native output, an unavailable remote ref and a non-git diagnostic run. Fixture Git configuration and references are isolated from the working repository.

This verifies the build boundary locally. TypeScript, JavaScript syntax and whitespace checks passed. Integration and subsequent release-run verification remain open.
