# Presence changes with the player

The club/union presence service sent `track()` every minute even when nothing
changed. Each update fans out to the channel's subscribers. The captured
initial state also reset Away to Online after a minute and after reconnect.

Presence now tracks on subscribe/reconnect and explicit status changes. The
Supabase SDK retains its normal connection heartbeats and disconnect detection.
Each channel keeps its own current user, scope, and status, so changing status
keeps the club/union/table identity and reconnect restores the latest choice.
A late subscription callback after leave cannot publish presence again.

The club and union page consumers count presence keys; neither uses `lastSeen`
as a liveness timeout. That value now marks the last presence state change.
No table gameplay transport or database publication membership changes.

Validation: five new regressions fail against the original implementation and
pass after the fix. They exercise six quiet hours, Away persistence, reconnect,
separate channel identities, and late callbacks after leave. All 13 service
tests and 15 related tests pass, as do TypeScript compilation and focused lint.
Provider publication and current invoice savings require separate verification.

Supabase describes Presence as slow-changing connection state and separates
transport heartbeats from Presence updates:
https://supabase.com/docs/guides/realtime/presence
https://supabase.com/docs/guides/troubleshooting/realtime-heartbeat-messages
