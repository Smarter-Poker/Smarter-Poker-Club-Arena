# Private human-result report refusals retain bounded diagnostics

The first protected-main private report run (40416425073) failed with exit3,
but its generic catch message could not distinguish a query failure from an
invalid response or a rejected partition receipt. The underlying production
cause remains unknown until a qualified run emits the new diagnostics.

The existing CLI now returns a finite failure stage, partition number and
completed partition count. A PostgreSQL error may add one allowlisted SQLSTATE.
Raw exception text, query stderr, database URLs, identities and report rows never
enter the failure diagnostic. Successful reports and all existing deadlines,
read-only transactions, attribution rules and receipt predicates are unchanged.

The retained native PostgreSQL regression removes its own fixture relation and
verifies a real CLI failure reports query_failed/42P01 without leaking relation
or connection details. Invalid timestamps retain their separate input refusal.
No new schedule, retry loop or engine activation is introduced.
