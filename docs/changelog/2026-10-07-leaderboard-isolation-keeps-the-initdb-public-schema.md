# Leaderboard Isolation Keeps The Initdb Public Schema

Actual current-schema restore failed with SQLSTATE 3F000 at generated extension line 7. Read-only source metadata identifies that line as `pg_trgm` in `public`, whose source owner is `pg_database_owner`.

PostgreSQL 17's dump implementation deliberately does not recreate the initdb-provided `public` schema and omits its definition when ownership is the default. The qualification harness incorrectly dropped this schema before restoring the archive, so the first extension using it failed.

The isolated preparation now retains `public`, while still removing the default `plpgsql` extension for exact original-owner recreation. The archive restores source namespace ownership, comments and ACLs through the existing paths. Exact final catalog comparison remains mandatory; keeping the namespace is not permission to accept mismatched grants, owners or extra objects. Source exports, exact extension versions, read-only access, bounds, drift checks and verified cleanup are unchanged.

Focused regression protection pins the actual isolated preparation command and inherited Auth materialization. Source checks alone do not prove full restoration or financial qualification; those require the protected current-schema runtime result.
