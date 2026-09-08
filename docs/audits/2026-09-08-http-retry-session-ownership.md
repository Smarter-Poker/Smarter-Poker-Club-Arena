# Engine HTTP retries belong to their original login

## Finding

GameServerAPI.engineFetch retried every 401 with whatever token the shared
Supabase refresh returned. The engine identifies the actor from the JWT, not
the deprecated userId argument. If account A sent a raise and account B signed
in while the request or refresh was pending, that old intent could be replayed
as B. An idempotency key does not establish which login owns an intent.

## Change

The retry captures the original Authorization token's subject and session_id.
The locally stored session must still match before refresh, after refresh, and
before a deferred revocation probe starts. The returned refresh token must also
match before a second engine request can be sent. A normal token rotation in
the same login remains eligible; a new login, even for the same account, is not.
Unknown or absent ownership returns the original 401 without an automatic retry.
The server remains responsible for JWT verification and authorization; parsed
claims here only restrict a client retry and never grant access.

The caller is engineFetch, shared by the HTTP action endpoints. The original
request body and its existing idempotency key are retained on an eligible retry.
There are no database changes, new refresh loops, or new network calls.

## Verification

The new seven behavioral tests exercise real submitAction with mocked network
and auth boundaries: same-login refresh, late 401 after account switch, switch
during refresh, a new login for the same account, mismatched SDK token with
unchanged storage, logout during refresh, and an ambiguous 503. Together with
the 11 existing GameServerAPI unit tests, 18 tests passed. Client TypeScript and
production build are required before push; deployment is through the existing
Hetzner static publisher. No live chip-moving action was used for testing.

## Remaining scope

This prevents a 401 retry from adopting a different login. It does not make the
shared SDK's internal refresh/sign-out operations identity-atomic. The separate
sessionRevoked module's network waits and internal side effects still need their
own coordinated auth audit. If storage is absent or expired, this path declines
to replay automatically; normal auth recovery and the original HTTP failure
remain responsible for the next user interaction. A successful push or merge
alone is not evidence that this code is serving in production.
