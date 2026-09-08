# Initial engine HTTP requests retain their login

The 401 retry already checked login ownership, but the initial token lookup
could resolve after an account switch and send the previous player's intent
with the replacement login's token. The action spacing and 429 backoff also
allowed a queued action to outlive logout.

GameServerAPI now captures the stored JWT subject and session ID before its
first await, checks them after token lookup and fallback refresh, and checks
again immediately before each authenticated fetch. Missing or malformed
identity fails closed. The ownership read deliberately ignores token expiry:
a suspended device can refresh an expired token within the same login. It
never treats a new login for the same account as the original session.

The existing 15-second auth deadline, server authentication, idempotency key,
rate-limit backoff and 401 ownership checks remain in effect. Public health
reads do not require a login. Auth failures return the existing caller error;
no action is assumed to have reached the engine.

Behavioral coverage includes account replacement, same-account re-login,
logout, foreign cached token, fallback refresh, expired-session recovery,
missing initial identity, lazy import, spacing and rate-limit retries. The
ordinary HTTP tests now use authenticated JWT fixtures rather than a dummy
non-JWT token or no session.

This does not solve auth-js mutations inside a previously started SDK call,
or the shared session-revocation handler's identity ownership. Physical
mobile/offline testing across every game format remains outstanding.
