# Explicit recipient wallet database contract

This database-first delivery implements the October 15 owner direction replacing forced agent-wallet credits. The retained agent send core and its phase-two wrapper now honor the requested eligible wallet, and exact retry fingerprints bind to that choice. Admins still have no player wallet; plain players cannot hold agent wallets. Existing authorization, row locks, credit handling, journal writes and claim-back metadata remain intact.

The public Club Bank wrapper now acquires agreement authority before the retained core locks the club. Previously bank-to-agent sends could hold the club while waiting on the agreement mutex, opposite the lock order used by agent money operations. The native regression reproduces that ordering defect and verifies the repair.

The migration asserts exact installed preimages and declares exact postimage proofs. The maintained agent-wallet PostgreSQL CI entry point now executes the new isolated PG17 qualification. It covers both agent routing layers, role/wallet balances, one journal and transaction per movement, replay/conflict, ineligible wallet/downline/self refusals, bank self funding, concurrency and migration replay refusal. Native baseline failures and candidate passes are retained in the task evidence archive.

A missing declaration for an existing Messenger request import was a base-revision TypeScript blocker; its accurate declaration is included without runtime changes. The companion client delivery will expose the new wallet choice only after this migration is installed. No engine replacement is required.
