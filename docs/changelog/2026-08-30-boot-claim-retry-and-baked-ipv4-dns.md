# 2026-08-30 — Boot claim retries through the staleness window; IPv4-first DNS baked into the image

Agent: Claude (Cowork, local). Hardening pass from the Sunday $200 Deep Stack
outage audit (see 2026-08-30-sunday-200-deepstack-stall-ipv6-supabase-outage.md).

## Boot-claim livelock

One boot-time `renewLeadership()` call decided leader-or-standby. During the
2026-08-30 Supabase degradation that single answer was wrong five containers
in a row: the claim timed out, or lost to the fresh lease the process's own
dead predecessor wrote seconds before exiting. Standby boot → promoted one
window later → exit-to-restart → the next boot met the lease ITS predecessor
just wrote. One full container restart per ~30s window, dealing nothing.

GameServer.start() now retries the boot claim for one staleness window plus
margin (45s, 5s cadence). A dead predecessor's lease goes stale inside that
window and the claim is granted IN-BOOT; a real live leader stays fresh
throughout and this process stands down exactly as before.

## IPv4-first DNS

`NODE_OPTIONS=--dns-result-order=ipv4first` moves from the host .env into the
Dockerfile. Node tried IPv6 first to Supabase on a host with no IPv6 route
(43,121ms vs 82ms per fresh connection, against a 15s client deadline), and a
fix that lives only in a hand-edited .env dies with the next .env rewrite.

The host .env also carries `SUPABASE_TIMEOUT_MS=60000`, widened during the
Supabase incident (status.supabase.com, ongoing). Return it to default once
that resolves.
