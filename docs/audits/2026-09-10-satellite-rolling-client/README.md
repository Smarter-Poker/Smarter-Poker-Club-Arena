# Satellite rolling-client activation boundary

The witnessed legacy client cannot automatically finish an equal qualifier with a null finishing position. Publishing a new bundle does not establish that already-open pages have adopted it. Exact-K activation remains held with its core and UI commits until the external Stage-B prerequisite and the acceptance path below are satisfied.

## Reproduced legacy behavior

Run `node scripts/dev/probe-satellite-rolling-client.mjs` from this repository. The runner extracts and executes the actual TypeScript callbacks from witnessed deployed commit `bb7a6ba30639fdfc5ae81df52d4e9f0b7c6afa9a`; it supplies mocked read transport and records source/callback hashes in `legacy-behavior-proof.json`. It does not rewrite the behavior being tested.

| Actual callback or mechanism                                                   | Observed result                                                                           | Implication                                                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TablePage.exitFromDurableCompletion`, winner with null position and prize 200 | One retry, no exit, no winner overlay                                                     | Durable completion alone cannot carry a placeless qualifier in this legacy client.   |
| Same callback, ranked winner position 1                                        | One first-place exit with the existing seven-second delay                                 | Ranked positive control passes.                                                      |
| Same callback, eliminated position 2                                           | One second-place exit with the existing 2.5-second delay                                  | Ranked negative control passes.                                                      |
| `TablePage.applySeatRemoved` for a tournament seat                             | Hero seat becomes zero and own player row is cleared; no navigation or table-close signal | Truthful `SEAT_LEFT` is not a terminal handoff.                                      |
| `MultiTablePage` server-seat rebuild, successful empty array                   | No tab update and no readiness callback                                                   | Its early return prevents stale seated tabs from reaching the existing prune helper. |
| Existing shell reload predicate                                                | Table routes refuse reload; a visible lobby permits reload                                | The existing update gate cannot itself move an old table page to a safe route.       |

Source inspection also finds no TablePage terminal `table_closed` event handler. The existing `tournament_winner` handler forces first place, so it must never be repurposed for equal qualifiers. Adding delivery fields or an unknown qualification event does not teach that handler a placeless outcome. Local `TABLE_LEFT` does remove a named MultiTable tab, but the legacy remote seat event does not emit it. A table-purchase `table_closed` exception is an unrelated interactive join path, not durable terminal recovery.

The separate MultiTable fix owned by the acceptance lane addresses successful zero-seat reads prospectively. Its existing policy prunes only non-lobby tabs with `seated === true`; deliberate observers and pending joins leave that field false or undefined. Successful empty reads must remain distinct from errors or malformed data, and a stale request must not remove a newly seated table. That fix still cannot update JavaScript already running in an old tab.

## Public asset witness

`asset-proof.json` records a stable read of Club Arena's own `https://ca-static.smarter.poker` build-info, entry and TablePage asset on 2026-09-10 at 14:37:58 UTC. Both surrounding build/entry reads agreed: commit `cb11503fd0d6bf45433ef0a364361652b8ce0170`, built at 14:29:04 UTC by publication run `34489048445`. The captured TablePage asset contains the winner event and lacks the qualification event and qualification RPC strings. SHA-256 values identify the actual assets read. This later asset witness and the earlier executable source witness are separate evidence, not an assertion that all active pages run either version.

An old browser context can retain any earlier loaded bundle, including an offline/PWA page. Existing shell telemetry is best-effort, rate-limited event reporting, not authoritative membership or per-page capability registration. A successful publication, one capability acknowledgement, or one browser reload cannot certify every open context. No blanket reload, cancellation event, fabricated place or forced hand disconnection is proposed.

## Prospective durable handoff already implemented in the held UI

The held qualification UI commit `9bb88f1e0` adds the actor/tournament-scoped DTO reader and a truthful seat, ticket or cash result. `TablePage.exitFromDurableCompletion` reads that DTO for a placeless winner. Initial completion verification, the completed tournament update and bounded durable polling recover when the qualification broadcast is lost. Missing or unreadable receipts keep retrying; they do not manufacture a rank or turn entry value into a wallet credit.

The new exit publishes the result first and signals only the source table's existing `TABLE_LEFT` and `CLOSE_TABLE_TAB` paths. Embedded tables leave navigation to MultiTablePage so unrelated source/target/cash tables remain mounted. Effect teardown cancels delayed exits; post-await mount checks refuse results from a removed table instance. Existing tests execute the actual callback declarations and render the app-root result host, including seat/ticket/cash delivery, replay, missing/stalled receipts, lost broadcasts, source-only close, teardown during reads and ranked completion controls. Those are component/callback tests, not an authenticated browser acceptance claim.

## Required acceptance before exact-K activation

1. Verify the independently owned Stage-B final-seat wrapper/private core and the exact-K RPC catalog, ACLs and immutable receipt contracts. Native source-seat closure must commit atomically with all qualifier awards; force deferred constraints. Preserve the separate disabled-financial-guard limitation.
2. Integrate the held UI/core with current main and rerun the native and component proof on that exact build. Installing schema does not by itself authorize enabling exact-K for a running legacy cohort.
3. In authenticated browser contexts, retain the witnessed old client as a negative control, then run the prospective build through native seat, ticket and cash completions. Confirm null finishing place, truthful delivery, source seat exit and one durable result card.
4. Drop the terminal broadcast and completed-row notification, then test bounded polling, reconnect, reload and offline/PWA resume. Delay a result read across account/session change and source-table teardown; it must not close a newer or unrelated table.
5. Test source-only tabs, deliberate spectators and pending joins, plus a running target table and another cash table with an active hand. Closing the terminal source must preserve all live target/other-table instances and hands. An obsolete successful zero-seat response must not prune a newly admitted seat.
6. Observe a safe off-table route and actual running/deployed entry hashes before and after the existing update gate adopts the new bundle. A forced route change or reload during a hand is not acceptance.
7. Define and verify which existing browser contexts/cohorts may enter the new exact-K path. Do not infer universal adoption from publication or telemetry; retain the activation hold for unsupported legacy contexts until a compatible durable handoff or an explicitly bounded adoption process is proven.

No production mutation, activation, manager restart or authenticated browser settlement was performed by this proof. The absent live Stage-B owner, rolling adoption boundary, running-target physical assignment and process-level recovery remain explicit dependencies.
