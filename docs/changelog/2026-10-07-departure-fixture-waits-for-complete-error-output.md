# Departure Fixture Waits For Complete Error Output

The required accounting job `112777196900` failed its cash-debit rollback assertion because the holding PostgreSQL client returned a nonzero exit with an empty captured error. Its helper resolved at process exit, which may precede the final stderr data. The helper now waits for process and stream closure, including early readiness failure. The concurrent-client helper already used that correct boundary and remains unchanged.

The retained regression extracts the actual helper and exercises exit, trailing stderr and close in deterministic order. The original completion mechanism loses the refusal; the corrected mechanism preserves it. Spawn failure and early-close diagnostics remain distinct. The actual native PostgreSQL 17 reclassification test passes with its original cash-purchase refusal and complete rollback assertions unchanged. The whole native suite still must pass in hosted CI.

The deterministic regression executes beside the unchanged departure invocation in the existing mandatory accounting lane. No financial SQL, production engine behavior, assertion, transaction barrier or retry policy changes. The workflow fingerprint is refreshed with its original pin retained in the qualification manifest. This fixes a demonstrated release-check blocker, not a payout or production qualification result.

The first hosted regression invocation exposed a dependency-resolution gap: that accounting job installs the server lockfile but no client dependency tree. The helper now loads TypeScript from that existing server installation explicitly. It requires no additional installation or workflow change and retains the same actual-helper extraction and event-order assertions.
