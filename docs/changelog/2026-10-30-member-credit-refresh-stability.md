# Keep member credit tracking stable during refresh

The player-management Credit Tracking card replaced itself with a loading paragraph after every record revision or Agent Wallet balance change. The agreement had not changed, but its rendering key included those refresh inputs, so ordinary live activity repeatedly removed and recreated the card.

Separate the verified club/member/role scope from the read revision. Keep the same verified card mounted during a pending same-scope refresh, apply fresh authoritative terms in place, and immediately withdraw prior figures on scope changes or failed reads. Wallet balance changes no longer independently invalidate the credit agreement; existing record and agent update events still refresh it. Abort fencing prevents an obsolete response from overwriting a newer scope/read.

The focused delayed-response regression fails before this correction and passes afterward. Existing prepaid, refusal/retry and wrong-member protections remain. Credit remains tracking only; this changes no wallets, invoices, rakeback or database state.
