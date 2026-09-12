# The fixture checks unfiltered database writes

The isolated component fixture now builds the real safeupdate 1.4 PostgreSQL hook in CI and configures it before the API opens database connections. Native checks require unfiltered updates and deletes to fail through a fresh database session and the actual authenticated API, while filtered writes succeed. Probe rows are restored and probe objects removed; complete fixture cleanup remains mandatory.

This prerequisite does not certify the full application role graph, production pre-request function, funded accounting, or production binary equivalence. It adds no production migration and installs no Mac dependencies.
