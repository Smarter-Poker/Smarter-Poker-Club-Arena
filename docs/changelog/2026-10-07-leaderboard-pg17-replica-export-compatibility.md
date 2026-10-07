# PG17 Replica Schema Export Compatibility

The actual isolated Auth run 37692075738 refused the replica solely because
its PostgreSQL version differed from the primary. Its private minor version
was erased during cleanup and remains unknown. No Auth or financial proof ran.

PostgreSQL 17 pg_dump supports same-major minor-version export compatibility:
https://www.postgresql.org/docs/17/app-pgdump.html

The export admission now requires strictly typed six-character PG17 versions
and an unchanged replica version before and after export. The disposable
database still uses the original primary-matched image. Recovery, read-only,
feedback-off, WAL fencing, full catalogue/security/startup equivalence and
verified cleanup remain mandatory. Any restore difference still fails.

Regression coverage admits a stable PG17 minor difference and refuses other
majors, malformed versions, version changes during export, lag, promotion,
feedback and catalogue/startup drift. Generated Auth input and the prospective
financial preflight fingerprint are updated together. This is qualification
tooling only, not a production database upgrade or financial qualification.
