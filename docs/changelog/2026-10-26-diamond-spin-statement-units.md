# Diamond Spins Statements Show Explicit Asset Units

The daily statement's `Entries` amount was diamonds collected, but the copy did not say so and omitted chips paid from the host's Promo/Main Bank. The notification now labels collected diamonds, actual chip payouts, diamond prizes, inventory diamond costs, net diamonds before burn, the platform burn, and the owner's net diamond credit. Chip payouts are explicitly paid separately and never subtracted from the diamond credit. Negative diamond settlements say Net Debit.

Chip payouts come from posted, recipient-directed `chip_ledger` paying legs for all five Diamond Spins categories. Promo and bank split funding sum once, bonus and welcome prizes count when actually paid, and the business day uses Chicago midnight boundaries. Recorded day ownership takes precedence over current host ownership; ambiguous same-day ownership renders the chip total Unavailable. Hosts with no diamond movements use their current owner when the statement snapshot is generated.

The source settlement retains its existing service-only authority, wallet writer, burn, replay and quiet-delivery behavior. The migration also corrects the original linked notification display copies without changing settled receipts, paying again, changing read state, or sending a new notification. Installation is from protected main through Apply Merged Migration, with history and exact live readback required.

Regression coverage runs in the existing required accounting PostgreSQL job through `scripts/dev/test-accounting-delivery.sh`: the original burn/settlement probes run before the new migration, and `tests/sql/diamond-spin-statement-units.sql` exercises actual custody, funded chip payer, split funding, Chicago boundary, owner isolation, labels, wallet/burn arithmetic and replay.

Concurrent protected PR #8245 delivered the overlapping receipt-validation baseline repair before this notification branch integrated main. The two engine files are preserved byte-identical to inherited main, so the final notification diff contains no engine behavior change or activation dependency. The corrected upstream receipt tests pass all 116 cases.
