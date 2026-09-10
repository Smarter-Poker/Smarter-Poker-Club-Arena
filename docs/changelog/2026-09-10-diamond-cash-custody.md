# Diamond Cash Custody Settlement

Phase 6 remains in progress. Public Diamond admission remains closed.

The existing accepted-hand stack writer now dispatches authoritative Diamond cash tables to a private custody transaction. It requires exact seat ID, join instant and occupancy binding, whole amounts, matching funded balances and zero-sum player deltas. The transaction updates custody and seats together, consumes purchased liability only for actual losses, and retains an immutable hand receipt. Shared lease and history callers remain unchanged.

Custody releases accept a settled closed occupancy, including a busted zero balance. Zero releases retain a receipt with no wallet journal; positive releases retain the existing atomic wallet/debt journal contract. The server adapter validates this distinction.

Verification: 37 isolated PostgreSQL assertions passed, including the 10 retained Phase 3 fixture assertions. Two concurrent hand deliveries produce one settlement and one replay. A forced second-player write failure rolls back all earlier balance, seat and purchase-lot writes. Stale generations, nonconservation, changed retry payloads, direct primitive access and malformed zero movements are refused. The server custody suite passed 26 tests and server TypeScript passed.

These are custody-boundary checks. Seat admission, complete accepted-hand obligations, client integration, full gameplay certification and live adoption remain tracked in the Phase 6 audit. No production player was seated or funded by this test.
