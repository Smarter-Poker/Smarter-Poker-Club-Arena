# Daily Missions Phase 6: Feedback, Alerts, And Observability

## Player Experience

- Added an explicit opt-in Daily Reset Alerts console to Daily Missions.
- Kept mission reminders separate from device-wide push controls, so turning
  them off never silences seat, message, tournament, or club alerts.
- Preserved the direct user-gesture path required by iOS web push and added
  honest install, blocked-permission, disconnected-device, busy, and failure
  states.
- Gave opted-in players with a disconnected device separate reconnect and
  opt-out actions, including when browser permission prevents reconnection.
- Upgraded the claim celebration into a settlement receipt that confirms the
  chips and diamonds were deposited securely.
- Added product analytics for page views, mission-directed navigation,
  claims, rerolls, streak freezes, and alert preference changes.

## Reliability And Operations

- Added an opt-in-only reset-notification RPC that writes through the existing
  notification center and push-outbox bridge.
- Added a per-user/per-cycle uniqueness contract so scheduler retries cannot
  create duplicate Daily Mission alerts.
- Added a forward-only contract correction after the live rollback probe found
  the production notification copy column is `message`, not `body`; the failed
  probe committed no preference, notification, or outbox rows.
- Rewired the canonical workers `daily-challenges` job to drain those reset
  alerts even when its training challenge was already created by a partial run.
- Removed the worker's old best-effort broadcast to every profile.
- Added privacy-safe operational telemetry for dashboard latency, mutation
  failures, realtime degradation/recovery, navigation, and alert enrollment,
  with sampled routine traffic, private aggregate views, and bounded retention.
- Fixed the reroll handler's missing rejection recovery path so a network/RPC
  exception now reports, restores authoritative state, and never escapes as an
  unhandled promise rejection.

## Verification

- Focused lint, TypeScript, Daily Missions tests, worker route tests, and both
  production builds are required before publication.
- The production migration is verified for opt-in default, RLS, RPC grants,
  unique delivery contract, notification-to-outbox trigger integration, and
  operational-health views.
