# 2026-08-31 - New Clubs Only Contain Joined Members

## Shipped

- Club membership inserts now require an explicit `Join A Club` or atomic club-owner creation source. Wallet lookup and seat resolution can no longer create membership rows as a side effect.
- Automated Spin, Heads Up, And MTT liquidity is limited to the platform house club. User-owned clubs are populated only by players who joined that club.
- Club cards read current membership and current-club active-seat counts from real-time RPCs. They never hydrate these facts from browser cache or stale denormalized columns, and unavailable data is identified instead of simulated.
- Player Command financial fields are authorized within the selected club. Owners, Club Admins, Union Overseers, And Agents can see only the hierarchy allowed by their current-club role; ordinary members and outsiders cannot see another player's sensitive financial data.
- Player Command fees, hands, wallets, transactions, statistics, and downlines are sourced from the selected club instead of account-lifetime aggregates across every club.
- The New Club Opening Checklist remains present until every launch step is complete.
- Table configuration help controls are keyboard- and pointer-accessible popovers, `Every N Hands` is now `Every Set Number Of Hands`, and binary options use conventional On/Off switches.

## Production Repair

- Disabled the accidentally activated Deep Stack Society Spin pool before cleanup.
- Closed 15 empty automated Spin boards through the sanctioned atomic cancellation function.
- Removed the unauthorized Deep Stack Society memberships through the ledger-safe leave function only after all live tournament seats had settled. Member balances were returned to the club treasury and the owner membership was preserved.
- Reversed the untouched legacy 100,000-chip owner-wallet grant to `system_burn` through the append-only ledger. The corrected creation path grants 100,000 only to the Club Bank; the owner's player wallet starts at zero.
- Retired leaked production certification clubs from the public Club Arena and hardened the certification cleanup so append-only financial history cannot leave a public fixture behind.
- Verified Deep Stack Society reports one member, no bots, no active automated seats, a zero owner player wallet, and zero current-club fees for KingFish.

## Verification

- The migration was executed in a forced rollback first, then applied to production as one transaction.
- A rollback-only production create-club probe verified a 100,000-chip bank, one membership, and one owner.
- Direct membership insertion was rejected with `MEMBERSHIP_REQUIRES_JOIN`.
- Client: 776 files and 10,782 tests passed.
- Engine: 298 files and 3,361 tests passed.
- Client And Engine TypeScript builds passed; the production frontend build passed.

## Deliberately Not Changed

- Legitimate horse accounts are not filtered from counts, games, reports, payouts, or access rules. Horses remain players. Only the unauthorized Deep Stack incident rows were repaired.
- The owner-created Deep Stack cash table and its settings were not deleted or altered.
