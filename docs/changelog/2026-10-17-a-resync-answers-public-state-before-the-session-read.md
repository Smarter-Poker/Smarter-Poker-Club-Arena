# A resync answers public state before the session read

Production runs 39069889524 and 39073463654 both stopped on a mobile observer
showing "Reconnecting To The Table" moments after it opened. Each time the page
had its first SUBSCRIBED and SNAPSHOT, then re-sent SUBSCRIBE and RESYNC on the
same socket about four seconds later; the engine answered neither, and after
the client's 5-second state probe (`WARM_STATE_PROBE_MS`) the page retired the
socket and showed the banner. The same pattern stopped the 11:13 UTC attempt.

Cause: an explicit RESYNC (single-table and multiplexed) and an idempotent mux
SUBSCRIBE on a table the socket already holds waited for
`sessionCanReceive` - the durable `fn_ca_player_session_live` read - before
sending anything, including the public snapshot and the re-ack. That read is
usually sub-millisecond in the database (mean 0.39 ms over 339,259 calls) but
has taken 3.8 s, and an Unknown verdict sent nothing at all. A real player
switching back to the app hits the same path.

The 2026-10-10 change that introduced the read
(`2026-10-10-missed-player-revocations-reconcile-on-channel-recovery.md`)
states the rule: Unknown retains the socket and refuses **private**
re-delivery; public subscription is preserved. The resync paths withheld the
public half too.

Now the public half answers at once: the re-ack, the latest public snapshot
and its retained public replay (`TableStateHub.resync`, scrubbed public state
the socket already receives as broadcast), and presence. Private state
(`resyncPlayer`: hole cards) still waits for a definite Alive, Unknown still
refuses it without signing out, and Revoked still closes with 4401
`auth:session_not_found`. A new table subscription is unchanged and still
reads durable authority first.

Tests: `PlayerSessionRevocation.test.ts` - the four verdict cases now expect
the public resync for every verdict and private state only for Alive; new
cases prove the public answer is sent while the session read is still pending
(single-table and mux RESYNC, and idempotent mux SUBSCRIBE for Alive, Unknown
and Revoked). All nine fail on the previous code. 340 transport tests pass.
