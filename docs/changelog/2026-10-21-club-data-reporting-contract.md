# Exact MTT and union reporting contract

MTT result fields and filters include MTT events only. Explicit all-tournament subtotals retain SNG/Spin contributions to overall winnings and fees. The advanced v2 contract reconciles against those subtotals; the old contract remains compatible with already-open clients.

An authorized union identity expands to each member club plus its direct account. Financial values aggregate at full precision; shared games and physical hand totals are counted once. Initial, paged and exported games include the same cash stacks. Player breakdowns use each contributing club's own launch cutoff and fee source. Member-club ownership and agent access do not grant union-wide access.

The migration writes no money. It checks every replaced function against its observed preimage, preserves existing execution grants, refuses replay, and introduces only private scope/count helpers plus an authenticated, permission-checked v2 snapshot. Native qualification proves the original failures, corrected union/type totals, rollback/replay refusal, exact fees, pages/export and authorization. It runs in the existing required Data Console PostgreSQL suite.

The dedicated Union Data page uses a second endpoint. Its new compatible v2 snapshot, series, per-club list and immutable CSV preparation now use the same money-flow facts and cash stacks. All linked clubs appear even with zero activity; fees retain their source precision in breakdown/export rows and round only after aggregation. Existing endpoints remain available to open clients. Native PostgreSQL qualification exercises the actual union snapshot and immutable export transaction, including replay, empty clubs and fractional fees.
