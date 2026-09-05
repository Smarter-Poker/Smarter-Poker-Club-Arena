# server/src/observability/theClientIsHeard.law.test.ts

The client is heard (Realtime Phase 2): what a player's browser sees reaches the server - per-user reconnect counting stays off Prometheus (bounded gauges only, never a user id), the rolling hour really ages out, memory is bounded by eviction, auto_reload is counted but never inflates the per-user number, and the ingest route takes the user from the verified token and never the body
