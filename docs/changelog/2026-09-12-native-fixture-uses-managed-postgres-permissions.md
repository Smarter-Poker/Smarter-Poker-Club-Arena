# Native fixture uses managed PostgreSQL permissions

A current schema contains event triggers owned by NOSUPERUSER postgres. Vanilla
PostgreSQL refused that ownership, so a local restoration could not qualify the
current application permissions. The fixture now builds pinned official
Supautils in Linux CI and loads its managed privilege hooks. Application
postgres starts without SUPERUSER; only the separate initdb identity bootstraps
service roles and schemas.

A native transaction probes owned event-trigger creation, owner reassertion,
ordinary DDL execution, unprivileged creation refusal and complete rollback.
Actual Auth, PostgREST, Realtime and observer boundaries must still pass using
the restricted application identity. Full-schema, funded engine-route and
production binary-version parity remain separate requirements. No dependency
installation on the Mac, production SQL or production deployment is performed
by this fixture change.
