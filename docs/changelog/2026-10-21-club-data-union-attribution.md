# Club Data scope and exact tournament types

MTT winnings and MTT filtering now include only actual MTT events. SNG and Diamond Spin results remain in the overall total and an explicit tournament subtotal, which the client uses for reconciliation. MTT results remain UTC prize/refund credits minus entry/rebuy/add-on debits; unfinished entries are included and the page says so.

An authorized union identity reads all member clubs and its direct account. Shared games, players and hands are deduplicated across clubs, while money and unrounded fee shares aggregate before final rounding. A member-club owner or agent cannot gain union access. Club scope and agent downlines remain private.

The simple screen and advanced game summary share their authoritative total. Paged games, export and initial report rows include the same cash stacks. Union player breakdowns and pages expand to the same member scope with each club's accounting cutoff and fee source.

Game attribution names the hosting union instead of an individual creator. The live count uses the full server total rather than the 200 displayed rows.

Native PostgreSQL qualification reproduces the old MTT contamination and missing union scope, then verifies corrected totals, filters/search, fractional fees, shared games, cash stacks, paging/export, player scope, unauthorized callers, rollback and replay refusal. Focused client/validation tests and the app compiler pass. Protected merge, migration installation, publication and live verification are tracked separately in the task checkpoint.
