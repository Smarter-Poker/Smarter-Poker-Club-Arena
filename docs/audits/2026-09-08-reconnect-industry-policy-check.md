# Reconnect policy benchmark, September 8

Reviewed official operator documentation on 2026-09-08. Operator policies vary;
there is no single exact industry timeout to clone. Daniel's later instruction
for identical protection in every format, plus 50 percent for active VIP,
is the controlling Club Arena product rule.

| Topic               | Official benchmark                                                                                                                                                          | Club Arena rule and verification                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reconnect allowance | PokerStars varies DET by tournament stage and format. Its listed first allowance is 60-240 seconds for MTT final tables and 120 seconds in the specified SNG/HU situations. | One 30-second allowance for cash, MTT, Spin, SNG and heads-up; active VIP gets 45 seconds. These shorter values are the existing Arena policy, not a claim to exceed every competitor allowance. |
| Decision bank       | PokerStars explicitly separates thinking time from disconnect protection.                                                                                                   | reconnectProtection.ts computes membership-based allowance independently of purchased time banks.                                                                                                |
| Expiry              | The operator pages do not define Arena VIP entitlement.                                                                                                                     | is_vip must be true. A future expiry or explicit null expiry earns 45 seconds; expired, invalid or unverified expiry earns 30. A lifetime label cannot override an actual expired timestamp.     |
| No response         | PokerStars and GGPoker describe checking when no action is faced, otherwise folding when time expires.                                                                      | DisconnectEngine uses the server's legal auto-action and persists its absolute deadline.                                                                                                         |
| Repeated outages    | PokerStars resets its tournament DET when a player reconnects.                                                                                                              | Arena retains the consumed allowance through heartbeat flapping; a voluntary action can renew it. This limits delay abuse.                                                                       |
| Platform outage     | Both distinguish user connectivity from server failure; PokerStars pauses tournament blind clocks during DET.                                                               | Arena maintenance compensation and resume-wave clock are separate from player disconnect allowance. Second-crash durability and physical mobile network switches remain open verification items. |

Code witnesses: server/src/engine/reconnectProtection.test.ts,
UnifiedReconnectProtection.test.ts, TransportDisconnectGrace.test.ts,
DisconnectMidTurnTimeBank.test.ts, and maintenance/reconnectFreeze.test.ts.
The uniformity suite explicitly exercises cash, mtt, spin, sng and heads_up
with per-table overrides that must not change the allowance. This review does
not assert that a synthetic label test proves every production seating path.

Sources (paraphrased; retrieved 2026-09-08):

- https://www.pokerstars.com/poker/tournaments/rules/ (Disconnects and Sitting Out)
- https://www.pokerstars.com/help/articles/trn-time-bank/172551/
- https://ggpoker.com/house-rules/ (Tournament Disconnects and Sitting Out)
