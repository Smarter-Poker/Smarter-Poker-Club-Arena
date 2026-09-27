# Catalog proof waits for the route permission

The production catalog check started its five-second MTT-control assertion at DOMContentLoaded, before GameCreationGuard's caller-bound permission read had finished. It now observes that exact request and validates its successful standalone-club authorization before starting the unchanged control assertion. It issues no extra RPC and does not change application authorization or rendering.

The existing 150-second whole-test and 90-second read budgets, authoritative template requests, unsaved draft check and scheduled visible refresh remain unchanged. Denied permission, non-success HTTP, unreadable JSON and malformed or union-only answers fail explicitly. Foreign-club reads and different request methods do not satisfy readiness.

A maintained local test mounts the real guard and TableConfigPage against the actual Supabase SDK and an HTTP peer. Holding its first permission response beyond 5,000ms reproduces the missing control under the former assertion order; releasing the same response exposes the real MTT tab. The test selects it without any game creation or financial request. Negative response and exact-request matching cases run in the existing client unit suite; the actual production spec remains in the existing routes directory sweep.

This establishes the structural readiness race. The September 27 17:19 failure artifact shows MTT in the post-failure screenshot and accessibility snapshot, but contains no request timings, so that individual production delay is not attributed to a specific request. The next containing published-client run still owns live acceptance.
