# tests/balance-sync-is-never-a-notification.law.test.ts

BALANCE_UPDATED (internal balance refresh, e.g. source postgres_sync_connected on every realtime reconnect) is never shown as a service-worker or native notification; MasterBus does not forward it, sw-bus.js refuses it, and the native path returns early (Dan, 2026-10-21).
