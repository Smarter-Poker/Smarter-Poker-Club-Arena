# Auth after role alignment

The native fixture now attaches real GoTrue user creation, sign-in and TOTP enrollment to the same database after its positive role alignment and genuine provider qualification. It reopens the application connection after the installer and observers close, verifies service-owned helpers and the exact migration set, then checks the three persisted sessions and the verified factor. No authenticated session is synthesized.

The phase has a 30-second cap and propagates its parent cancellation to every Auth HTTP request. Existing 150-second role, 180-second preimage and 420-second shell limits are unchanged. Success is emitted only after actual fixture resource closure; the outer controller additionally requires container, network and image cleanup and matching role/provider hashes.

The new qualify-auth entrypoint establishes positive alignment/providers and runs only the attached Auth phase without the role fault/access matrix. The existing mandatory CI baseline remains in its usual single invocation, with Auth added to that same aligned estate rather than a second bootstrap.

This proof covers Auth only. PostgREST still requires the approved production pre-request definition and dependencies; attached REST/Realtime, full schema, funding and production parity remain unqualified.
