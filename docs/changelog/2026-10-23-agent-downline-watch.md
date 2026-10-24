# Agents can watch their downlines on every table

An active agent, super-agent or sub-agent may observe a live direct or recursive downline on cash, union and tournament tables, including other clubs, restricted-observer tables and Diamond Arena. The relationship must remain active; a removed relationship or departed player cannot grant new observation access. The exception changes neither playing/buy-in rights nor spectator private-card visibility.

The database owns the cycle-safe relationship/current-seat decision. Search cards, click-time validation, table metadata RLS, engine HTTP state and both WebSocket entry paths share that exception. The complete search definition retains privacy, fuzzy matching, stable pages, live tournament association and the October 11 currency-label correction.

The existing required native PostgreSQL fixture proves the original refusal and then tests the migration, RLS, indirect/deep/cyclic hierarchies, all three agent roles, spoofing, inactive/removed relationships, departed seats and stale targets. Engine regression tests cover other-club restricted access, revocation, lookup errors, Diamond and existing seated reconnect behavior; card projection remains separately tested.

Delivery status is recorded in CHECKPOINT-agent-downline-watch.md. The metadata policy requires a hot-table DDL lock, so this migration declares daily maintenance and must use the existing 04:00 Chicago installer. The engine change also requires normal daily activation. This source change is not a claim of live installation.

The existing engine-door preparation check treats the new RPC as optional before its declared daily-maintenance installation. This reflects tested compatibility: missing RPC responses never grant the new exception, existing permitted spectators and seated reconnects retain their access, and restrictions/outsiders remain refused. The real door-check regression failed before this declaration and passes after it; unrelated required doors still fail when absent. Installation, containing runtime and live behavior are separate required evidence.
