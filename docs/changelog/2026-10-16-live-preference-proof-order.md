# Keep The Live Preference Proof In Order

The production lobby persistence and scroll checks use the same isolated certificate account. The persistence case saves PLO or NLH, while the scroll case selects ALL. With the repository's fully parallel Playwright configuration, those writes could race and invalidate a cold-return assertion.

The lobby group now uses Playwright's default sequential mode. Other files retain their existing parallelism, every case still runs after an earlier failure, and the assertions and timeouts are unchanged. This follows PR #7043 without changing the published client.
