# Private listener admission and unused HTTP extension

The dedicated private-record listener is still disabled. Production's unused
pg_net extension gives every database LOGIN role write access to its HTTP queue
through PUBLIC. Supabase explicitly does not support per-project grant changes;
its documented removal route is DROP EXTENSION when queues, webhooks and callers
are absent. A new exact migration refuses extension/member drift, queued data,
consumers, active listener sessions, a freeze, replay or a changed paid source.
It takes only idle extension-table locks with NOWAIT and uses RESTRICT, never
CASCADE. It neither enables the role nor changes the source transport switch.

The credential admission also treated a grant on a schema the listener cannot
access as a reachable write. The corrected query requires schema USAGE for
relation/column privileges, retaining inaccessible grants in the audit output.
It has no schema-name exemption. Eight real PostgreSQL permission-denial cases
cover table/column writes, REFERENCES and a privileged routine. Granting USAGE
makes admission refuse both initial and already-owned credentials. Existing
financial-write, membership, TLS/SCRAM, notification and ownership tests remain.
This is fresh-session qualification: revoking USAGE does not invalidate already
resolved statements, so catalog reads cannot certify arbitrary session history.

The actual extension removal is qualified with PostgreSQL 17.6 and pg_net 0.19.5
built from pinned official sources into disposable private directories. That
qualifies extension behavior and the migration, not Supabase's privileged
extension-management layer; exact protected-main installation and readback must
prove production authority separately.

Gateway hosting, authenticated failover, returning-client compatibility and
billing reduction remain separate delivery gates. Paid Realtime stays enabled
until the replacement is fully verified. No native distribution account checks,
engine replacement or bulk financial/history deletion is part of this change.

Provider references:

- https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect
- https://www.postgresql.org/docs/17/ddl-schemas.html#DDL-SCHEMAS-PRIV

The gateway entry also imported the engine's privileged Supabase singleton.
It now uses a gateway-only public-key client and the requesting player's JWT.
One actor-bound session RPC and a dedicated-session grant on the existing
readiness verifier preserve both authorities without exposing the service-role
credential or anonymous operator telemetry. The native
fixture loads the real maintained source functions and runs the production
preimage guards unchanged. Bootstrap refuses a service-role key and installs
only the dedicated listener URL, pinned API URL and publishable key. The engine's
client, session helpers and APIs are unchanged.

The gateway artifact builder still named the repository's previous owner while
the activator required its current protected workflow. Both now import one
canonical workflow identity; foreign-workflow artifacts remain refused.

Permission claims are bounded to reachable application/financial relation writes
and reviewed privileged routines. This is not a claim that PostgreSQL prevents
all writes to temporary objects or a role's own large objects. No global system
function grants were changed.
