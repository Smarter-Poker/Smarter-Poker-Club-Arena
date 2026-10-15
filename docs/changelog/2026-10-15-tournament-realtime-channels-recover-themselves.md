# Tournament Realtime Channels Recover Themselves

Date: 2026-10-15

## What Happened

`TournamentBountyRealtimeDisconnected` and `TournamentManagerWakeRealtimeDisconnected` fired every hour from 2026-10-13 19:27 (bounty) and 20:29 (manager wake) until 2026-10-14 23:53 UTC: each fired at :08, when the break guard let go, and "resolved" at :53, when the break guard took over again. The two process-wide channels were never subscribed for 27 hours. Supabase Realtime restarted at 20:26:59 on 2026-10-13 and refused joins with `ChannelRateLimitReached` until 20:42; after that no join was refused server-side, yet neither channel came back. The engine release at 23:57 on 2026-10-14 restarted the process and both channels subscribed at once.

## Root Cause

`GameServer` recreated a channel only on `CLOSED`. On `CHANNEL_ERROR` and `TIMED_OUT` it trusted "Realtime will rejoin this channel". realtime-js 2.98 rejoins only while its socket is connected and never reopens one (`RealtimeChannel._rejoinUntilConnected`), and it keys its channel registry by topic (`channel(topic)` reuses, `_remove()` drops every channel of a topic, replies route by topic), so a channel its registry no longer holds times out and rejoins for ever with no reply routed to it. The process had no path back except a restart.

## Fix

- `CHANNEL_ERROR` and `TIMED_OUT` now retire the channel (`removeChannel`) and schedule its recreation through the same capped backoff as `CLOSED`. Recreation goes through `subscribe()`, which also reopens the socket. The direct durable drain on each status is unchanged.
- Every recreated channel gets its own topic (`...:<pid>:<generation>`), so nothing the old channel does can touch its replacement.
- A SUBSCRIBED channel is never polled or recreated.

## Tests

`server/src/GameServerRealtimeOwnership.test.ts`: each channel retires and recreates on `CHANNEL_ERROR` and on `TIMED_OUT`, ignores the retired channel's later statuses, and every recreated channel has a distinct topic. These fail against the previous code (the error branches neither removed nor rescheduled, and the topic was fixed per process).
