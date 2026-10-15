# Fabricated Test Sessions Stay Off Live Realtime

Date: 2026-10-15

## What Was Wrong

Every JWT error in the PokerIQ-Production Realtime logs that we sampled
(JwtSignerError, JwtSignatureError, MalformedJWT) came from our own browser
tests, not from players:

| Realtime error | Token subject | Source |
| --- | --- | --- |
| JwtSignatureError | 11111111-2222-4333-8444-555555555555 | Club Arena `tests/e2e/financial-decision-human-path.spec.ts` (HS256, no kid, `test-signature`, 24 hour expiry) |
| JwtSignerError | 00000000-0000-4000-8000-000000000909 | World Hub `e2e/025-horses-console-phase9.spec.ts` (empty header `e30`, 24 hour expiry) |
| JwtSignatureError | 00000000-0000-4000-8000-000000000022 | World Hub `e2e/05-diamond-store.spec.ts` (HS256, no kid, expiry 2100-01-01) |
| MalformedJWT | n/a | World Hub video library and footer specs (`local-browser-fixture-only`, `footer-visual-boundary-token`) |

Each spec plants a fabricated session in `smarter-poker-auth` and mocks REST
and Auth. The Realtime WebSocket is not REST, so it was never mocked: the page
joined production Realtime channels with the made-up token and was refused.
Supabase support (ticket SU-505102) read the refusals as a signer fault on the
project.

## The Fix

`tests/e2e/support/realtimeSessionGuard.ts` (World Hub:
`e2e/fixtures/realtimeSessionGuard.ts`) routes a context's Realtime sockets
through a check. A join whose `access_token` is not an asymmetric,
key-identified JWT (what Supabase Auth issues for this project: ES256 with a
`kid`) is closed with 4403 before any server socket opens. Real sessions and
the publishable key pass through unchanged, so specs that sign in for real
still exercise live Realtime.

Proven in Chromium against a stand-in Realtime server: the three fixture token
shapes were refused with 4403 and the server saw zero connections; an ES256
session opened one connection and delivered its heartbeat and join in order.

## The Law

`tests/a-fabricated-session-never-reaches-live-realtime.law.test.ts` fails if
any file under `tests/e2e` or `e2e-live` writes its own access_token into
storage without installing the guard, and pins which token shapes the guard
accepts and refuses. The World Hub carries the same law in
`__tests__/a-fabricated-session-never-reaches-live-realtime.law.test.mjs`.
