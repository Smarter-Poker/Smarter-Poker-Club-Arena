# Silent Revert Guard: preserved source and rejected detector proposal

At ef30edaef3019ab9525706ec175e4fa03a6ff4ba, CI34487566001 passed. Silent Revert Guard34487566013 flagged two historical branch commits against accepted main work.

- Registration funding probe: head and base010183495722982bfa2f1c14a8bb6e6fa358d9b1 have identical blob00545d206eb4c67e3353e497c7a5a24f3ccfde77. Later main Heads-Up edits changed the context of an older reverse patch.
- Migration changelog: the exact Diamond block from85da6479d survives. All350 base sections survive unchanged, including duplicate headings; the base-to-head diff has no removed lines.

The original detector reproduced these two stale-context false positives in real temporary Git repositories. Four unsafe cases remained rejected: content removal, a full old-state overwrite, a prior absent from the base, and reintroducing deleted unsafe code alongside additions. The preserved reproduction and original output are adjacent `.txt` files. The two positive fixtures intentionally fail against the unchanged detector; these are negative reproduction evidence, not passing CI tests.

Automatic approval review rejected editing the persistent detector, judging the exact security-control change insufficiently authorized by the general audit instruction. No detector or workflow modification was applied, retried or substituted. No approval label or approval environment value was set.

The release continuation uses a fresh forward application from current main with a normal three-way squash operation. The old branch and its history are retained. Newer main content and the unchanged guard must be verified before normal push and all required CI; this document does not predeclare that outcome.

The published log removes only ANSI color escapes and trailing whitespace. Original raw log SHA-256: 3b75025c9b34e168723d880c31f68f78c57af1c2cdabaebe88161b5fbf7ce6b7.
