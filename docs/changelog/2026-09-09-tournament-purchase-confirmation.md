# Tournament Purchase Confirmation

Phase 3 of the 109-item Club Arena audit is in progress. The user authorized development while Phase 2 publication continues in the background. The source plan puts tournaments, SNGs, Spins, bounties and satellites in Phase 3. Interrupted cash-hand durability belongs to Phase 7 of that plan, not Phase 3.

## Confirmed Defect And Correction

TournamentService.processRebuy and processAddOn previously treated a transport response without an error as a successful purchase. Missing, malformed and negative/NaN stack responses could emit BALANCE_UPDATED and close the purchase flow. Rebuy also replaced an exact zero stack with configured starting chips.

Both methods now validate an object with success:true, the requested rebuy/reentry/addon kind, and a finite nonnegative numeric new_stack before announcing success. They return the exact confirmed value, including zero. The shared service covers TournamentPage, TablePage and the tournament purchase modals. Transport error reporting no longer asserts that no chips were deducted when the outcome is unknown.

## Verification

Read-only production inspection confirmed the installed process_tournament_rebuy wrapper retains a shared receipt and its core emits success, new_stack and rebuy_type for both fresh and replay results. Wrapper definition MD5: 8a3a28a2ca0c3dae61713d3a6803875f. No database migration or financial probe was performed.

The new real-service tests reproduced 35 failures with 44 passing tests before correction. After correction, 79 service tests and 10 existing modal tests passed (89 total). They cover all three purchase kinds, malformed/refused responses, wrong kind, invalid stack values, exact zero and positive replay results, and transport errors. Client TypeScript and the local production build passed. The existing configured Sentry source-map upload succeeded; this is not proof of publication.

## Open Work

This closes the malformed-response handling defect only, not the complete entry accounting requirement. Durable prompt identity across reloads and all callers, exact original request payload reuse, replay before eligibility/window gates, database rollback/concurrency proof, and deployed acceptance remain open. The twelve original Phase 3 IDs are preserved in docs/audits/2026-09-09-accounting-phase-three-progress.json. Existing concurrent tournament funding, bounty, cancellation and lifecycle work must be checked before further changes.

No balances, game prices, rake policy, purchase eligibility, engine strategy or deployment gates changed. No watcher or reconciler was added.
