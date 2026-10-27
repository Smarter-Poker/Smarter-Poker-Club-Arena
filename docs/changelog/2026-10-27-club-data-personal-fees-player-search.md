# Club Data personal fees and direct player lookup

Club Data showed gross downline game fees where an agent expected their own earned fees. Its headline now reads the same `ca_club_member_fee_totals` calculation as Player Management, including standing rake shares and declared adjustments. This reporting-only change preserves the existing financial records and rules. Personal fees use the selected UTC ledger dates across all games; game activity remains Chicago-based and game rows retain generated fees.

Fees display in full with grouping and exactly two decimal places, including large Club Data totals and Player Management amounts. The fee headline fits its available space without abbreviating the amount.

The search field also searches the server-paged roster by player name. Matching permitted players open their Player Management record directly. Server authorization remains authoritative, and the client rejects stale results on account, club or query changes and unmount.

Validation: 70 focused client tests, application TypeScript, native PostgreSQL fail-before/pass-after reporting qualification including actual standing-share/redemption reader, date boundaries, filtered/empty games, operator scope, player denial, rollback/replay refusal and ACL preservation. Protected integration, installation and live publication are tracked separately in the task checkpoint.
