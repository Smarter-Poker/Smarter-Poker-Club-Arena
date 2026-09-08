# Valid JWT Claims Must Survive Session Restoration

The shared parseJwtPayload helper passed the JWT payload directly to atob.
JWTs use the Base64url alphabet: a valid payload containing '-' or '\_' throws
InvalidCharacterError in the old implementation, which then returns null.
readLocalSession consequently rejects that valid stored session. Expiry checks
and HTTP retry ownership use the same parser, so the defect reaches table
preloading, restoration, and reconnection rather than only display metadata.

Reproduced with a generated, non-production token containing ordinary string
claims and a note of three question marks. Its encoded payload contains '\_'.
A Unicode fixture also demonstrated corrupted UTF-8 text in the old decoder.
No production credentials were used or printed.

Normalize the URL-safe alphabet, decode bytes as UTF-8, and accept only a JSON
object as claims. Malformed Base64, invalid UTF-8, malformed JSON, primitives,
and arrays return null. Existing local-session expiry enforcement remains in
place. This remains parsing without signature verification; the engine still
verifies tokens authoritatively. It does not address the separate SDK account
switch side-effect race.

Twelve new cases exercise the URL-safe alphabet, Unicode, stored-session user
and login identity, expiry, and malformed claims. Together with the HTTP retry
suite, 24 tests passed. Client TypeScript completed cleanly. The production
build and normal push gates are required. Live impact cannot be inferred from
a generated-token test, so no claim is made about affected-user counts.
