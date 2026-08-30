# 2026-08-30 — Sunday $200 Deep Stack ($20K GTD) stall: root cause and recovery

Agent: Claude (Cowork, local). Session picked up after an Antigravity agent's
PRs (#1931, #1938) did not resolve the outage.

## Symptom

All 12 running tables of "Sunday $200 Deep Stack" (dfae9288) stopped dealing at
18:30–18:32 UTC. By 19:5x the entire platform was at zero hands/minute. Dan's
client at table 8c0e6345 showed a stale spectating view.

## Root causes (three, stacked)

1. UPSTREAM: Supabase ongoing major incident "Increased response times"
   (status.supabase.com, since Aug 27, Partially Degraded on Aug 30). Edge logs
   showed tens of thousands of Cloudflare 520/521/522/525 per 10 minutes at the
   peak, plus retry-storm amplification from World Hub API clients.

2. CONTAINER DNS: Node fetch in the engine container resolved the Supabase
   host to AAAA first with no working IPv6 route on the Hetzner box. A fresh
   connection burned ~40s before IPv4 fallback — longer than the client's 15s
   `supabase_timeout` deadline, so every request on a fresh socket aborted.
   Measured in-container: default order 43,121ms; `--dns-result-order=ipv4first`
   82ms for the same query.

3. LIVELOCK: with boot-time claims failing, every boot took the standby path,
   later won the leadership lease, then exited by design ("restarts as a real
   leader") — and the next boot found the fresh lease its predecessor wrote.
   Combined with repeated CI deploys landing mid-boot (image tags at 19:36,
   19:39, 19:54 UTC), the engine never finished a boot for ~90 minutes.

## Fixes applied (operational, on the Hetzner host)

Appended to `/opt/club-arena/server/.env` (read by `engine-up.sh` on every
deploy, so both survive container replacement):

    NODE_OPTIONS=--dns-result-order=ipv4first
    SUPABASE_TIMEOUT_MS=60000

The 60s deadline is a temporary widening for the Supabase incident; consider
returning it to default (15s) once status.supabase.com resolves.

## Outcome

- 20:04 UTC: hands dealing again; 20:07 UTC: 105 tables / 24 tournaments
  adopted, leader stable, zero supabase_timeouts.
- The Sunday $200 Deep Stack could not be resumed in place: during the outage
  a bust sweep had recorded 21 bogus eliminations (places 1–21 assigned while
  the field was still 100+ deep), so `recoverStuckCompleting` correctly
  refused to pay. The engine's reset path re-opened the event: status
  REGISTERING, 112 entrants preserved, prize pool 20,880 preserved,
  start_time rescheduled to 21:00 UTC, tables rebuilt on start.

## Follow-ups

- Add `ENV NODE_OPTIONS=--dns-result-order=ipv4first` to `server/Dockerfile`
  so the fix is in-repo, not only in the host .env. (Not pushed today to avoid
  triggering yet another engine restart during recovery.)
- The 21 bogus eliminations from the outage window were cleared by the reset
  (positions NULL, players back to `registered`). If any wrongly-recorded
  payouts/eliminations surface in ledgers, audit window is 18:30–20:05 UTC.
- Boot-time leadership claim should retry with backoff before settling on
  standby; the standby-promote-exit path livelocks when the DB is degraded at
  boot (fix candidates: retry loop in the one-shot `renewLeadership()` call,
  or in-place leader boot instead of exit).
