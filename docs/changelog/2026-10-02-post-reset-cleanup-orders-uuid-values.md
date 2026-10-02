# Post-Reset Cleanup Orders UUID Values

## What Existed

The private post-reset Create Club certification helper used `min(uuid)` to select the one reset operation after proving that all ten welcome-package items shared it. PostgreSQL does not provide that aggregate in the production catalog, so the first post-install certificate stopped with `42883` before it could create or retire a new fixture.

## What Changed

- A forward-only migration replaces exactly that expression with the first value of a deterministically ordered UUID array.
- The rewrite accepts only the exact known preimage or exact postimage and verifies the helper remains private, security-definer-owned by PostgreSQL, and protected by its package-lineage guards.
- The native PostgreSQL fixture no longer creates a test-only `min(uuid)` aggregate and installs the forward migration before exercising state-B success and refusal cases.

## Verification

- Isolated PostgreSQL 17 welcome-package and post-reset cleanup harness.
- Focused source contract and policy checks.
- Protected CI, exact migration installation, publication provenance, and post-install production Create Club certification.

Owner policy receipt: version `2.9`, manifest SHA-256 `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
