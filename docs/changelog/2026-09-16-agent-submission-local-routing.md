# Restore the existing local agent submission route

Owner handoffs for Bomb Pots Chips Display Issues and Cash Games Cards Mobile
Fixes reported missing automatic PR creation/merge. The three responsible
workflows are disabled and their main-branch source still selected ubuntu-latest,
which violates current local-only compute policy. They must not be enabled with
that source. Last successful same-category autopilot run34850003255 at ffa814b6
on September14 used hosted compute; no successful local autopilot baseline is
available. Existing local client publisher35127044547 succeeded today and
already owns the trusted publisher lane.

Change only the existing runner selection: unprivileged branch proposal uses
smarter-local-linux-arm64; default-branch PR creation and merge consumers use
smarter-local-publish. Events, same-repository checks, App authentication,
permissions, head binding, hold handling and required merge checks remain.
The maintained queue-pr regression file verifies these boundaries and already
runs in required CI. No scheduler, new worker, new job or fallback was added.

Instructions now document the existing authenticated producer-controlled queue
helper and distinguish status-query permission errors from pending checks.
Workflow source qualification, protected merge, enablement and an actual local
workflow result remain separate release steps; this source does not claim them.
