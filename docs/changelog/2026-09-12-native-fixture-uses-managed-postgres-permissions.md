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

Auth-owned tables also receive the captured managed default grants, allowing
the application owner to create real foreign keys to Auth users without a
superuser bypass. After genuine Auth migrations run, their ledger retains only
the captured read grant for postgres; it cannot insert or alter migration rows.
Connection ownership and rollback on privilege failure are checked separately.

Realtime's private migration and tenant catalogs are read through a separately
owned bootstrap connection, which closes before application work resumes.
Permission and connection errors retain their cause instead of being reported
as a generic readiness timeout. No application privilege is added for this check.
