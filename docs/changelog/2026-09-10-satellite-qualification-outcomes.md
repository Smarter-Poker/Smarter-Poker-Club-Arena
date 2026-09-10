# Equal Satellite Qualifiers Keep Their Actual Award

The equal-qualifier satellite completion contract has no finishing rank or single champion. The former table exit only understood a ranked winner or an eliminated player, so an unranked committed qualifier could remain on a closed table or have target-entry value presented as cash winnings.

This UI consumes the committed `tournament_qualified` event and the authenticated `fn_get_my_satellite_qualification(p_tournament_id)` receipt. Both parsers require the current tournament and viewer, a target, a supported delivery kind, and a positive finite cent amount. TablePage exits through the existing session and table-tab close sequence. The app-root host renders **Qualified** with **Seat Registered**, **Tournament Ticket Issued**, or **Cash Credited**. Only cash delivery contributes to cash winnings. The target button opens the existing tournament-detail route.

The durable fallback uses the existing bounded retry after a missing event or unavailable result. Late responses and old callbacks cannot act after their table owner is disposed. An embedded table closes its own tab and leaves destination ownership with MultiTablePage. Ordinary single-winner exits retain the seven-second celebration and ranking card.

Final review also reproduced three existing summary-ownership defects: a late partial publish erased qualification, upgrading an early result retained its invented first place, and a same-name second tournament replaced a queued result. The summary now preserves committed qualification facts, keeps its rank absent and non-cash value out of cash totals, and identifies queued tournaments by ID. A repeated queued result enriches its own position.

Validation: **151 tests passed across 11 files**, including **36 qualification outcome tests**. The original summary merge/queue failed all three new negative-control cases. `npx tsc --noEmit` and `npm run build` both exited 0 on the final source. Vite, fonts, media processing, and provenance completed; the build retained existing bundle-size warnings. The pre-existing session-summary compatibility tests emitted React act warnings while passing.

The behavior tests execute actual TablePage declarations and its registered callback with supplied external dependencies, then render the real result host and card in a DOM harness. They are not evidence of an authenticated browser/network production flow. Source evidence, command receipts, file hashes, and open acceptance items are recorded in `docs/audits/2026-09-10-satellite-qualification-ui-evidence.json`.

Release dependency: the root owner must integrate and verify the version 3 equal-qualifier core contract and reserved migration `20260910054035`, then publish and verify live behavior. This lane performs no production mutation and does not claim B11 or the overall audit complete. Threshold-crossing tie allocation remains outside this exact-K qualification subset.
