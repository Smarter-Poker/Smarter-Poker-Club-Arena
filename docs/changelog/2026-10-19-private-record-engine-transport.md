# Targeted member and roster invalidations can use the existing engine

The two private `record_changed` topic families account for the observed high broadcast volume. Their original source publishers now enqueue a PostgreSQL `NOTIFY ca_private_record_changes` payload containing only `{topic,event}` through a private dispatcher. The existing per-transaction topic and roster dedup stays in the original source transactions.

Paid Supabase delivery remains enabled by default. A postgres-owned singleton setting permits an explicit verified cutover or reversal; no browser or service-role writer can change it. The service-only readiness RPC checks the five exact connected definitions captured at installation. A changed definition refuses readiness rather than claiming that the bridge is available.

The companion engine listener and browser transport use their existing session JWT and the original `ca_member_record_can_subscribe(topic)` / `ca_club_roster_can_subscribe(topic)` authorization RPCs. This migration introduces no impersonation or wider subscription authority. It does not move gameplay, money, other notifications or retention behavior.

The existing native PostgreSQL qualification verifies actual committed LISTEN notifications, no rollback notification, two topic families, default dual delivery, source transaction dedup, explicit paid disable/re-enable, private configuration, source-bound readiness and replay refusal. Hosted engine/client publication, serving identities, reconnect/ACL behavior and the previous-client transition must be verified before the owner disables paid delivery. A merge or installation alone does not establish cost savings.
