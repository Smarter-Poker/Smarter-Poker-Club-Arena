# Daily Mission Private Broadcast

Daily Missions now receives its immediate refresh signal on an authenticated,
private per-player Broadcast topic. The existing revision cursor remains the
durable repair path when a WebSocket message is missed, while its high-volume
updates no longer compete with every other Club Arena table in the shared
Postgres Changes replication stream.

The production certification recognizes the Broadcast frame, proves that it
crosses the live socket, deliberately blocks it, and then verifies that the
revision cursor opens the reward vault without a page reload.

This release does not change Club Bank funds, Deep Stack Society balances,
horse funding, player chips, wallets, or club membership.
