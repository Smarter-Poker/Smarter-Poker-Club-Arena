# Cache-busted gateway health reaches the health handler

The first hosted gateway activation reached source-ready health, but its live
canary failed before creating the reserved account: `/health` returned 200 while
`/health?proof=…` returned 404. The standalone HTTP handler compared the entire
request target with `/health`.

The standalone entry now uses the shared runtime health handler, which compares
the exact path before the query string. Unrelated paths retain their 404 response,
health remains `no-store`, and process reachability never substitutes for current
source readiness. The existing runtime test, already invoked by required server
CI and the gateway publisher, exercises the real HTTP handler with bare and
cache-busted paths, source loss and unrelated paths. The cache-busted regression
failed against the original comparison before the correction.

This change requires protected delivery and a new attested gateway release.
Keep the client fallback URL unexposed and paid Realtime enabled while the real
authenticated canary and older-client safety remain unqualified. No game-engine
replacement or database migration is required.
