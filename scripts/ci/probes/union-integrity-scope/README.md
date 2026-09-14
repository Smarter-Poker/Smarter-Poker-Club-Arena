# Union integrity event scope

The native PostgreSQL 17 runner loads the captured live integrity function and its actual `auth.uid`, `auth.role`, engine-caller and union-overseer helpers. The fixture uses the relevant live column types and isolated database roles. It creates no production connection and has no external delivery triggers.

The original function returns a transfer from Union B to an authorized Union A owner, creates an incident for A, and then suppresses B's legitimate incident through its global 20-hour window. The candidate uses event table, tournament or club identity for each observation and keeps the incident window per union. A shared player or an agent's membership elsewhere cannot import outside activity or hide an in-scope transfer.

Run `python3 scripts/ci/test-union-integrity-scope.py --output <new-directory>`. Set `PG_BIN` to the PostgreSQL 17 executable directory when needed. Required accounting CI invokes the same runner. Its 43 checks cover scoped results, legitimate own-union activity, malformed outside rake data, real concurrent transactions, independent unions, rollback, an actual insert-trigger refusal, anonymous/unauthorized callers, migration replay and definition/authorization drift refusal.

The preserved JSON strings contain exact captured function text, including whitespace used by the installation fingerprint. The fixture does not certify financial providers, production notification fanout or historical financial reconciliation.
