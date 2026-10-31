# Public215 source metadata refusal diagnostics

Actual explicit Linux preflight run41022620404 stopped before SSH because one GitHub metadata command failed. Its log retained only exit1, which cannot distinguish an endpoint refusal, rate limit or timeout. The current source observer reads commit check runs and Actions metadata, never legacy commit statuses. Its existing read permissions are unchanged; the failed endpoint remains unknown until a real diagnostic run.

The dedicated source reader now reports only a whitelisted canonical repository API route, fixed failure category, parsed three-digit HTTP status when supplied by gh, and native exit status. It never prints raw stderr, response bodies, headers, redirects, token values or unknown arguments. Every original refusal,120-second/80-command bound, exact-source gate, reporter check and scientific/runtime prerequisite is preserved. No fallback, retry, permission expansion or new workflow was added.

Regression protection exercises actual reader failure propagation, redaction of hostile output and routes, typed API rate limit/timeout outcomes, and unchanged fail-closed source admission. The existing owning workflow executes these contracts before any SSH access. This is diagnostic source delivery only, not actual Linux model parity or R7 certification.
