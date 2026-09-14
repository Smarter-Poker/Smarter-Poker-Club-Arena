# Inactive original-launch database transport

The host-only Python adapter implements Accounting's seven broker operations:
registration/readback, launch binding, attempt append/readback, and termination
record/readback. It has no import-time connection or engine/broker activation.
The recovery-manager cold-disposition endpoint is outside this principal.

Each explicit call uses one bounded psql process and read-committed transaction.
A function result becomes commit evidence only after successful COMMIT, its
following completion marker, and a successful client exit. Timeouts, missing
markers, changed evidence, output overflow and client failures remain unknown.
There is no automatic write retry. Pure immutable readers use READ ONLY;
missing rows remain unknown. Historical attempts retain their no-start flag.
The adapter itself grants no start, no-start or financial authority.

The fixed Linux PostgreSQL 16 client matches the observed production client
installation. Root-only database.json holds exactly host, port and dbname.
database.pass and database-ca.pem stay in the private broker directory, mode
0600, passed through open descriptors. The authenticated user is fixed to
f06_original_launch_broker; TLS hostname verification and channel binding are
required, GSS encryption is disabled, inherited environment and psql startup
files are excluded. No credential, grant, role or image qualification is created.

Twenty component tests exercise actual controlled child processes, the real
three-second deadline, output caps, malformed/ambiguous responses, seven
signatures, immutable readers, input injection refusal and credential refusals.
They do not execute PostgreSQL or claim authenticated native qualification.
Accounting0087 remains uninstalled and under correction after independent
review. Its ALWAYS writer guards would activate enrollment immediately;
closed new EXECUTE grants do not make those guards inactive.

The existing broker still returns unknown and is not wired to this adapter.
Required next proofs include corrected SQL acceptance, a qualified distinct
principal and marker-before-actuation image, actual transaction/readback faults,
the full engine peer/restart boundary, and host credential lifecycle.
