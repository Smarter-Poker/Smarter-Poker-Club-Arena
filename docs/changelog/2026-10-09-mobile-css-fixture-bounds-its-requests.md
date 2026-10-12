# The mobile CSS fixture bounds its requests

The card-squeeze mobile fixture opened every discovered lazy stylesheet at once. The current served entry names 175 stylesheets, while the shared live-CSS fixture already limits reads to four. The mobile fixture now uses the same bound, including response bodies, without dropping any stylesheet or changing cascade order. A refused response names its exact HTTP status; request and body failures still fail the test before any CSS installation, with no retry or skipped assertion.

The earlier browser run recorded one non-success UnionGames stylesheet response, but omitted its status and was superseded from c1deef to 0160 during certification. Its historical cause remains unknown. Subsequent read-only checks found that exact asset HTTP 200 on both public route and static origin with identical 6584-byte content. This change hardens a demonstrated request-burst gap; it does not claim to prove that gap caused the historical refusal or that a production asset was missing.

Focused regression tests cover the four-request bound, out-of-order responses retaining complete discovery order, HTTP 503 diagnostics, request/body failure without retries or later batches, and actual mobile caller wiring. Product CSS, animation assertions, time budgets and release provenance gates remain unchanged.
