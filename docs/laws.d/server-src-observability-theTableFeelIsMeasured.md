# server/src/observability/theTableFeelIsMeasured.law.test.ts

The table's feel is measured (Realtime programme Phase 1): poker_act_to_broadcast_ms{audience=human|horse} and poker_actions_fleet_total ride the always-on /metrics (the per-table registry is gated off in production); the ActionLatencyDegraded / ActionLatencyCritical rules read the human series only and carry the maintenance-break guard; never a table_id label
