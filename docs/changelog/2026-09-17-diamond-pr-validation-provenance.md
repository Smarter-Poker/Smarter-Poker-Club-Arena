# Diamond Game Validation During Concurrent Publication

PR4779 repeatedly completed compilation but its browser checks never started when unrelated protected merges advanced main during the build. CI35271141786 records a one-commit advance, while the same candidate's production-build check passed earlier. No game assertion failed in this attempt.

The provenance stamp now recognizes only the exact complete-history, two-parent merge candidate named by a pull-request event. It retains the real main distance and marks the artifact as pull-request-validation. Production builds retain the existing zero-distance gate; the publisher explicitly refuses validation artifacts before transfer and on the host. Existing retained production releases without the new purpose field remain verifiable through their original exact-source, run and ancestry checks.

The existing subprocess suite reproduces the old refusal, verifies the repair, and rejects mismatched event/head/base/ref/source and strict release contexts. It also executes the actual publisher gate, proving a validation artifact is rejected even with zero main distance. No required test or production freshness safeguard was removed.
