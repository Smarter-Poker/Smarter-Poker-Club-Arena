# tests/the-second-writer-is-audited.law.test.ts

Phase 5 registered every money door in the database. The World Hub, in another
repository, calls those doors by name over PostgREST, and nothing had ever
compared the two: the first comparison (2026-09-07) found two routes calling
doors closed four days earlier and three calls whose parameter names matched no
live signature, so a JS-arithmetic fallback was the only path that had ever run.
`fn_ca_second_writer_check` names every finding kind, counts what it could not
check, and `scripts/ci/audit-second-writer.mjs` refuses an empty directory or an
unreadable answer rather than calling either one clean. Extended 2026-09-19: the
EXECUTE verdict used to be asked of `service_role` for every call, because
almost every World Hub route holds the service key. Five do not; they build a
client from the anon key and forward the caller's Authorization header, so the
RPC runs as `authenticated` and the door reads `auth.uid()`. Measured over 1,159
files and 332 calls, 41 are service-role, 5 user-scoped and 286 unresolvable
from the call site, and the wrong role was wrong in both directions:
`send_wallet_diamond_transfer` is granted to `authenticated` and deliberately
not to `service_role`, so a working money route was reported as "permission
denied on every call" and was the only error keeping Schema Integrity Audit red;
and `fn_mint_chips_from_diamonds` and `send_stream_gift`, approved money doors
on user-scoped routes, were never asked about the grant they actually depend on,
so revoking it would have broken the mint with the audit green. The call now
carries the role it runs as and the check asks about that role, naming it in the
finding. An unknown role is `service_role`, which is what all 332 calls were
before, so the change narrows nothing; the migration proves both directions
against the real call before it commits.
