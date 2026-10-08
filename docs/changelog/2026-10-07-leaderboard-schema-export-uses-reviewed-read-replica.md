# Leaderboard Schema Export Uses A Reviewed Read Replica

Qualification tooling only. No production financial behavior or client change.

The primary's five-minute snapshot safeguard correctly terminated the long
schema export. Keep that safeguard intact. Route only the bounded schema-only
dump through an explicitly reviewed dedicated read replica; all primary metadata,
roles, security inputs and source-drift checks remain on the primary.

Require provider metadata with no connection string, independently validate the
primary and replica endpoints, preserve credentials in memory and enforce TLS.
Before and after export, require actual recovery/read-only state, exact version,
no upstream hot-standby feedback, replay beyond the primary WAL fence, exact full
catalog equality and the existing numeric startup settings. Refuse omitted
metadata rather than silently retrying the long primary export.

All four maintained manual qualification workflows enforce helper regressions
and carry the reviewed metadata explicitly. Generated Auth and financial modes
retain their original isolation, cleanup and normative failure semantics.

Source tests are not actual faithful restore, Auth, financial or publication
evidence. The owned temporary replica must be removed and absence verified after
qualification or abandonment. Never promote it or redirect player traffic.
