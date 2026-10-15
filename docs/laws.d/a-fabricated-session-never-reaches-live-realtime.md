# tests/a-fabricated-session-never-reaches-live-realtime.law.test.ts

Every browser spec under tests/e2e or e2e-live that writes a made-up access_token into storage installs `installRealtimeSessionGuard(context)`, which refuses any Realtime join whose token is not an asymmetric, key-identified JWT before a server socket opens. Without it, fixture sessions joined production Realtime on every run and their rejections (JwtSignerError, JwtSignatureError, MalformedJWT) were mistaken for a project signer fault (Supabase ticket SU-505102, October 2026).
