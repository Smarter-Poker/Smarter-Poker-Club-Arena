# Realtime Recovery And Hand Cadence, Continuing Audit

## Owner Policy

September 8 ruling supersedes format-specific reconnect recommendations:
all cash games, MTTs, Spins and Sit & Gos, including heads-up, use the same
disconnect protection. VIP members receive exactly 50 percent longer.
The implementation keeps the existing 30-second base, giving active VIPs
45 seconds. Ordinary paid decision time banks remain separately accounted.
Membership is read by the server; lifetime and unexpired memberships qualify.

## Current Changes

- Rabbit response ownership, PR #3613: merged and verified in the published
  static build. Delayed replies cannot paint an unrelated hand or live felt
  from a replayer purchase.
- Rabbit metadata latency, PR #3624: merged. Payment remains awaited; the
  supplemental metadata insert no longer delays cards after successful payment.
  Production engine inclusion still requires a version/ancestry check.
- Unified reconnect protection: implemented on this branch. One configuration
  across formats; 30/45-second absolute deadlines; repeated heartbeats do not
  refill the allowance; a voluntary action resets it. Mid-turn loss transfers
  the primary timer to the remaining allowance. An active paid bank completes
  its accounting before any remaining protection is enforced. Snapshot state
  carries the granted deadline through a restart.

## Official Benchmarks Reviewed September 8

These are public behavior descriptions, not evidence of competitors' internal
architecture. Owner policy above determines our timing in every format.

| Source                                                                                                   | Relevant documented behavior                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PokerStars cash time bank](https://www.pokerstars.com/help/articles/ring-time-ma/)                      | Disconnect protection is separate from decision time banks; its published reconnect allowance ranges from roughly 30 to 240 seconds by pot size.                                                                                        |
| [PokerStars tournament rules, section 4](https://www.pokerstars.com/poker/tournaments/rules/)            | Check/fold on timeout, continued tournament blinds while absent, extra protection at MTT final tables and throughout heads-up events. Published HU allowances are 120 then 60 seconds; MTT allowances decrease over successive actions. |
| [GGPoker house rules](https://ggpoker.net/house-rules/)                                                  | Distinguishes player connectivity problems from server crashes, offers extra reconnect time late in tournaments, and describes check/fold and continued blinds.                                                                         |
| [GGPoker Spin and Gold FAQ](https://help.ggpoker.com/article/Spin-and-Gold---Frequently-Asked-Questions) | Official search-index excerpt specifies two minutes of reconnect time. The full dynamically rendered article was unavailable to the text reader, so additional conditions are unverified.                                               |
| [MDN navigator.onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)                | Browser online status is an unreliable connectivity hint; it must not be treated as proof the engine can be reached.                                                                                                                    |
| [RFC 6455, section 7.2.3](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.2.3)                     | Reconnection after abnormal closure needs backoff to avoid a fleet of clients overwhelming recovery.                                                                                                                                    |

## Hand Delay Is Still Open

Earlier live observation remained approximately twelve seconds from winner
display to the next hand. Engine phases showed settlement, cleanup and
next-hand reads after presentation holds. Concurrent next-hand inputs reduced
one serial chain but did not resolve the whole gap.

A subsequent read-only probe from a separate process inside the engine
container measured twelve one-row database reads between 96 and 1054 ms.
This establishes variable service round-trip latency outside the browser;
it does not isolate network, pool queuing or query execution as the sole cause.
Statement-statistic samples identify hand-history insertion, cash cluster
sweeps, realtime decoding and analytics aggregation as active workload to
profile. Cumulative totals alone are not current incident evidence.

## Remaining Acceptance Work

- Attribute every settlement step and cleanup read, then remove redundant
  waits while preserving financial ordering and durable settlement.
- Verify Rabbit metadata fix on the running engine; test slow charge, lost
  payment acknowledgement and retry with durable purchase idempotency.
- Verify disconnect timing on seated clients for all formats, both membership
  classes, before a turn, mid-turn and during a paid bank.
- Audit all-in, voluntary sit-out, forced sit-out and seat recovery. Never
  confuse disconnect protection with forcing an all-in player to fold.
- Audit maintenance clock compensation, engine restarts and cross-table moves.
  Persisting a deadline alone does not prove the freeze duration is compensated.
- Exercise Wi-Fi loss, internet loss with a locally connected network, mobile
  background/resume, auth rotation and multiple mounted tables.
- Continue shared channel/session ownership audit and stale auth-probe review.
- Verify deployed versions, browser countdowns, private cards, action acceptance
  and live hand cadence before declaring any whole flow complete.

The wider realtime audit and the hand-delay issue are not complete.
