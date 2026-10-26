# Cashier history reads belong to the selected filters

Changing from All Club Transactions to My Transactions previously left the old book's receipts visible while the new read was pending. A rejected older-page request could also toast an error after another book was selected. A late incomplete summary scheduled another read after the player had left Transaction History. Null, blank or boolean summary figures were coerced into verified zeroes.

The filter transition now retires the previous rows, cursor, receipt and read generation before paint. Older-page completions can change only their original generation. Summary snapshots carry their filter identity; cleanup prevents late completions from scheduling further reads. Only finite numeric figures and recognized summary modes are accepted. Invalid totals retain the existing unavailable state and Retry control. Genuine zeroes and numeric strings remain supported.

The approval path was traced through the retained operation, verified receipt, actual approver's agent wallet, accounting transaction and invoice, event, queue and wallet refresh. No money-writing API, permission, financial rule, export format or approved artwork changes.

Verification: seven new mounted regressions reproduce the stale-book, malformed-total, closed-history and rejected older-page paths before the fix. The final focused run passes 218 tests across eight files, including the complete CashoutService and role-scoped agent queue suites. Application TypeScript compilation passes. Protected CI, normal publication and production browser proof are separate delivery gates.
