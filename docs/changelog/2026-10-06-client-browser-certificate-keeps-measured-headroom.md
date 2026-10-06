# Client Browser Certificate Keeps Measured Headroom

Production job `112087516486` started at 03:10:21 UTC, entered the deployed-page
suite at 03:13:50, and was cancelled at 04:17:35 after 67 minutes. The 65-minute
job bound therefore expired before the mandatory honesty, isolated-account
cleanup, release-window, and reporting steps could run.

The client browser job now has a bounded 80-minute envelope, and its source
contract requires that minimum. The suite, first-attempt behavior, assertions,
honesty checks, and cleanup remain unchanged. No application, database, engine,
permission, financial, or player behavior changes in this correction.
