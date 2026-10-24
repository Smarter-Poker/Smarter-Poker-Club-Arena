# Cashouts proceed during settlement

Cashout requests and agent approval/rejection no longer consult the browser's general settlement lock. A historical club investigation lock ending in2099 was blocking valid pending cashouts before their authoritative transaction could run, even with the club settlement flag off.

Both request surfaces and the pending cashout panel now go directly through the existing v2 cashout operation after receipt recovery and account checks. Escrow verification, balance validation, current cashier authority, atomic ledger/invoice persistence, durable operation identity and duplicate protection remain in the existing transaction. Other cashier actions retain their existing settlement admission. No database flags, wallet balances, engine behavior or external-money payments were changed.

Mounted tests cover funded requests and agent decisions despite a settlement lock, same-frame duplicate clicks, account/club/input changes during receipt lookup and recovery after an unknown response. A source law retains the cashout-specific boundary. Delivery and actual verification evidence are in CHECKPOINT-realtime-cashouts.md.
