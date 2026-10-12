# Cashier failure network evidence

Production certificate 37385321271 reported seven `TypeError: Failed to fetch`
console errors in the Cashier route check on October 5 at 23:35 UTC. The retained
screenshot showed loading content, but no network trace was available: the general
Playwright configuration records traces on retry while this certificate runs
with retries disabled. Supabase recorded successful requests for the same reserved
account during that interval. Neither a provider outage nor a navigation race
was established.

The existing Cashier console check now observes failed requests, HTTP error
responses and main-frame navigations. On failure only, it attaches the most recent
64 events with relative timing, method, sanitized origin/path, HTTP status or a
fixed failure code. Queries, fragments, URL credentials, headers, bodies and
arbitrary failure text are excluded. Listeners are removed when the check ends.

This is diagnostic instrumentation, not a transport fix or a passing production
certificate. The zero-console-error assertion, existing filters and retry policy
are unchanged. No additional production suite or data mutation was performed.

Validation: two focused sanitization/bounds regressions, application and helper
TypeScript checks, collection of all eight financial-route checks, and ordinary
pre-push guards passed. Hosted checks and the next applicable production
certificate remain separate evidence.
