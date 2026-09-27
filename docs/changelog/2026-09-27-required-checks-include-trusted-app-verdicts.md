# Required check observation includes the trusted App verdict

`pr-status.mjs` reported PR5400 at `a9870df8dec5900206662c62102c85b04a2b0948` red because its Actions job list omitted the successful standalone Money trigger check. The exact check-run108633229233 was completed successfully at13:54:49 UTC by App4962039, the reporter named in the protected ruleset.

The read-only helper now reads counted, paginated Actions and Checks inventories for the exact commit. Required contexts retain the ruleset's integration identity; wrong heads/reporters, incomplete inventories, API failures and unreadable rules cannot produce green. A newer matching attempt supersedes an older success. For an unbound context, conflicting latest reporters remain non-green. Workflow job/step diagnostics remain available separately. A PR moving heads during the observation is unknown.

Historical instructions to stop for disabled autopilot were replaced with the current task-owned protected delivery procedure. This does not change required checks, trusted reporters, merge protection, release scheduling or any publication path.

Regression coverage exercises standalone success, missing/foreign reporters, stale success versus queued/failed attempts, malformed or changing pages, second-page checks and actual CLI handling of403/429/503 responses without network or production writes. The original false-red output is retained in task evidence. Local checks, hosted checks, protected merge and any publication are recorded separately by the owning task.

Source admission also associates GitHub Actions check suites with their exact workflow run event: manual, workflow-completion and scheduled jobs cannot satisfy PR requirements. External App checks keep their distinct source contract. Nonpositive or missing check/App identities remain unknown.
