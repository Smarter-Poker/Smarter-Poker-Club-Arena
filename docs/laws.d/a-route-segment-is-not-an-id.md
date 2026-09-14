# tests/a-route-segment-is-not-an-id.law.test.ts

A value taken from the URL is not an id until `isUUID` says so: no path-match
subscript may reach `.eq('id'|'table_id'|'club_id'|'union_id'|'tournament_id',
...)` without a guard dominating the query, a resolver's ANSWER is checked
rather than the resolver merely being called (`resolveClubUUID` returns its own
input when it cannot resolve one), a scope that cannot be resolved is reported
once per mount instead of silently serving platform defaults, and the eleven
inherited `useParams()` call sites are frozen by a one-way ratchet.
