# Balance Sync Is Never A Notification (2026-10-21)

Dan sent a lock-screen screenshot: "Balance Updated from Smarter.Poker / Source: postgres_sync_connected" and said it has to stop.

Cause: `PostgresSyncHooks` emits `BALANCE_UPDATED` (source `postgres_sync_connected`) every time the realtime channel connects, so pages reload balances. `MasterBus` listed `BALANCE_UPDATED` in `CRITICAL_EVENTS`, which forwards to `public/sw-bus.js`, and the worker showed a notification whenever no tab was visible. A phone waking or switching networks reconnects realtime while the PWA is in the background, so the banner fired repeatedly with an internal debug string as its body.

Fix at the root:
- `src/core/MasterBus.ts`: `BALANCE_UPDATED` removed from `CRITICAL_EVENTS`. Pages still subscribe to it.
- `public/sw-bus.js`: `NEVER_NOTIFY` refuses it before `showNotification`, covering tabs still running an older bundle; the "Source:" body is gone.
- `src/lib/native/localNotifications.ts`: returns early for it; title and body rules removed.
- Pinned by `tests/balance-sync-is-never-a-notification.law.test.ts`.
