# Wait for the union access decision during certification

The route sweep could see the requested union URL while the asynchronous access check was still pending, report access as allowed, and fail after the page correctly redirected to Community Center. Run 34611012800 captured exactly that refusal destination.

The helper now waits for either the requested page and its allowed content or the Community Center refusal destination. An unresolved decision still fails after fifteen seconds. No product permissions, route behavior, stalled-table checks or unchanged-release checks change.

Validation: a local Chromium probe executes the actual helper and route assertions against delayed allow, delayed deny and unresolved responses. The original helper incorrectly reports the delayed denial as allowed; the revised helper handles both outcomes and fails closed on an unresolved decision. The isolated route TypeScript check passes. The full application typecheck is unavailable in this worktree because its shared dependency snapshot lacks the native Capacitor packages; this is not a full application build certificate. No production E2E account was created by this probe.
