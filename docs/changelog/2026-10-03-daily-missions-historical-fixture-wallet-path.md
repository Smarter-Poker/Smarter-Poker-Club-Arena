# Daily Missions Settlement Fixture Uses Its Wallet Credit Path

The production settlement certification's historical boosted-milestone fixture no longer seeds its 15-Diamond historical balance through `fn_ca_mint`. That Mint has a rolling issuance ceiling unrelated to the milestone wallet credit, so a harmless 15-Diamond fixture could fail before the settlement behavior ran.

The fixture now sets the reserved certification profile's 1.5 multiplier, credits the raw 10 Diamonds through `add_diamonds_to_balance` as a `bonus` using the established `daily-missions-historical-multiplier:` reference family, and asserts the journaled 15-Diamond result and resulting balance. It keeps the synthetic milestone-history marker under its own `daily_mission_milestones:` reference with `source: 'the_mint'`, so the register trigger does not issue the same value twice. No payout logic, Mint ceiling, or production data is changed.

The certification source-contract test pins this funding path, the independent references, the exact value, and the non-registering history marker.
