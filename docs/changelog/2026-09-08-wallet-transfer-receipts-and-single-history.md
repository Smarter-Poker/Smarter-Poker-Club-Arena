# Wallet transfers require matching receipts and one history

Both transfer methods now reject nonfinite amounts and require literal success=true. Internal transfers match the returned source, destination and amount and validate both balances before success. The legacy unkeyed user transfer no longer retries automatically after a thrown network error.

Live fn_wallet_type_transfer already writes both wallet_transactions entries in its database transaction. Removed the two subsequent browser history inserts, which duplicated those records and could fail after money committed. No historical records or balances were changed.

Five initial tests reproduced unsafe amount, confirmation and retry behavior. Six more reproduced duplicate history and mismatched internal receipts. All 30 wallet/store tests now pass, as does TypeScript. The network test uses the actual retry helper rather than a no-op mock.

Active callers include AgentFinancialPortal, AgentPortalPage and useWalletStore. No current src caller of transferToUser was found. Live wallet_user_transfer is retired and raises WALLET_POOL_RETIRED; no permission or database definition was changed. Internal transfers still target the legacy global wallets pool. Rewiring those features to explicit club-scoped wallets remains open and is not certified by this change.

Push destination verified: private repository Smarter-Poker/Smarter-Poker-Club-Arena, ID 1132369872, matching origin. The documented path is agent branch, normal checks, autopilot merge, then publish-club-arena.yml to Hetzner. No gate bypass is used.
