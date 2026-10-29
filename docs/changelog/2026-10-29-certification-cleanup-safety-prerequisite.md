# Certification waits for installed scoped cleanup

Production verification could prepare or retire fixtures while the old cleanup functions still held the global maintenance lock, even when the release itself passed. All five fixture-bearing post-deploy jobs now require one read-only dependency before any step can run, including always-cleanup steps.

The dependency waits at most twelve minutes for migration 20261029193107, then requires its exact history name/version, all five installed function hashes and an owner-only admission helper ACL. Wrong installed state or unreadable evidence refuses immediately. PostgreSQL reads use verified TLS, a read-only session and one read-only transaction per catalog answer. The dependency never installs, starts a release, or invokes a fixture RPC. Its failure remains a failed workflow job and an explicit lane in the existing terminal verdict.

The initial six workflow regression cases failed before wiring. Targeted behavior and workflow tests cover missing/incorrect history, function drift, permissions, query failures, bounded waiting, deadline overrun, safe transport and all five job dependencies. No production calls were used to test this change. SQL migration timing and engine activation remain unchanged.

The existing isolated PostgreSQL concurrency fixture also executes the actual readiness reader against the exact installed migration. It proves read-only enforcement, missing/wrong history, each function drift, all four forbidden ACL grants, and restored readiness. No separate production fixture or migration route was added. Read failures use a safe message allowlist; query failure rolls back, and connection shutdown has a two-second bound.
