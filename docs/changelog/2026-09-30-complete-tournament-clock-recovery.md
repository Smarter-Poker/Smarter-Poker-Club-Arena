# Complete tournament clock recovery

PR #5494 restores a full current blind level when a resumed tournament has not dealt for an entire level or five minutes, whichever is longer. Ordinary restarts retain the remaining level time, and scheduled break overlap is excluded from the outage calculation. Only an overdue level reads its latest persisted hand witness.

Escalation beyond the published blind structure now requires a proven chip supply before inventing the next blind level. A pending blind transition keeps its existing replay path. Tournament adoption also includes decision queue age and newly expired jobs in its existing bounded admission budget.

The original PR passed its server and accounting shards, but client validation found three missing law registrations. This continuation integrates current main and registers those existing regressions without changing their assertions or adding a separate recovery process. Source validation and production delivery are recorded separately in the owning task evidence.
