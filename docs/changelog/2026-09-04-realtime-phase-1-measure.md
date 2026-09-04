# 2026-09-04: Realtime programme, Phase 1 of 7 - Measure

The number that defines how a table feels - action accepted to every seat
seeing it - had been recorded for months and scraped never. It is on the
always-on `/metrics` now as `poker_act_to_broadcast_ms{audience=human|horse}`
with `poker_actions_fleet_total`, two series instead of ~3,000, and two
alert rules read the human series: p95 > 500 ms warns, > 1.5 s is critical,
both quiet during the hourly break.

Full programme and the reasoning: `docs/REALTIME-CONNECTIONS-PROGRAMME.md`.
Law: `server/src/observability/theTableFeelIsMeasured.law.test.ts`.
