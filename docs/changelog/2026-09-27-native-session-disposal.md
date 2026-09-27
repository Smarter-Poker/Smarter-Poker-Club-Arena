# Archived Spin qualification waits for its original database session

The native PG17 shard in run 36324316448 observed one extra backend immediately
after the preceding psql client had exited successfully. Client exit does not
establish that PostgreSQL has finished disposing of that same session.

The archived image now reads each one-shot psql session's own backend PID before
its original SQL, then requires that exact local process to be absent within
the original command deadline. It starts no observer session, signals no backend,
and preserves the strict zero-extra-session requirement and all financial SQL.
Non-archived images retain their existing command path.

The original framed output, unframed SQL bytes, nonce, PID, actual invocation and
observed exit are retained and checked together. Missing, repeated, malformed,
changed or late evidence fails. Source controls cover delayed disposal, unchanged
arguments/output, exhausted budgets and retained evidence; the existing native
Spin workflow remains the connected qualification owner. This is local/hosted
test lifecycle work, not a production financial repair or engine restart.
