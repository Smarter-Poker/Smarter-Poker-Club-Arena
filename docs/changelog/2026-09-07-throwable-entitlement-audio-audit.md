# Throwable Entitlement, Audio, And Preview Audit

## Fixed

- Allowance display now matches the live database: active VIP gets 500 monthly uses measured in UTC, expired VIP gets no monthly allowance, and Lifetime VIP is unlimited. A failed usage-count request is explicitly unavailable instead of inventing 500 free throws.
- Positive, unexpired purchased credits remain usable before the one-diamond fallback. The server remains authoritative for all consumption.
- A successful throw no longer waits for another allowance network request before rendering. Insufficient-diamond errors match regardless of capitalization. The close button has an accessible name.
- Cancelling a throw prevents an outstanding fetch/decode from starting its sound later. A WebM decode failure tries the AAC file. Failed loads are evicted so a later throw can recover after a network outage; successful decodes remain cached.
- The darkroom accepts both documented item-list flags, rejects unknown IDs and invalid arguments, fails explicitly required screenshots on browser failure, closes the browser after capture errors, and uses independent temporary bundle directories.
- Preview tiles use unique SVG IDs, actual arrival duration variables, anchor offsets, and the payload/residue lifetime. Cut frames no longer show an object that production has unmounted.

## Verification

New behavioral tests cover five allowance scenarios, four audio lifecycle scenarios, and four preview command/lifecycle scenarios. Existing measured-grammar, spec and atomic-purchase failure suites remain part of the focused check. Scoped strict TypeScript verification covers services and new service tests. Browser capture produced 40 Beer/Trophy/Rocket beat and size frames; the beer cut frame was visually checked and contains only the seat.

Read-only production review on PokerIQ-Production confirmed:

- `fn_use_throwable` delegates to `fn_use_throwable_v2`, which checks authentication, locks per account, enforces a 1500 ms rate limit, consumes monthly allowance then unexpired packs then diamonds, and records usage atomically.
- V2 supports request receipts; the current client still uses the compatibility wrapper with a fresh server-generated request ID. Response-loss retries across new requests are not end-to-end idempotent.
- `feature_pricing.throwable` is one diamond per use. `fn_purchase_feature_v2` checks caller ownership and server pricing and records purchase receipts.
- Shop purchases produce inventory with a grant snapshot. Redemption of a throwable grant creates `feature_purchases` uses and marks inventory redeemed under a row lock.
- Anonymous execution is revoked for both throw functions, feature purchase and shop redemption. User inventory is select-own; throwable receipts deny browser access.
- Only two V2 usage receipts existed at review, both Lifetime VIP. Those receipts do not prove the monthly, paid, or pack paths have been exercised.

PR #3490 is merged and published. Production `build-info.json` returned `ca_sha=0fe610377420f789dd08776878b5efc897ca0d51`, matching main at that check. Publish run 34155019265 passed build, four test shards and origin verification.

## Remaining Gates And Work

This is not a declaration that the entire six-phase rebuild is finished.

- Automatic approval review rejected calling production throw functions because execution could spend diamonds or consume allowances. No live purchase or consumption was executed. Controlled positive-path transactional verification remains required.
- Full application compilation, repository-wide tests, and authenticated browser flows require the complete repository/CI environment; this local workspace is a partial API-materialized source snapshot.
- The selector and live server differ on response-loss retry identity. A future change must carry a stable request ID through the authenticated send and retry flow, not merely generate a new UUID each time.
- 29 legacy representations still need bespoke rigs; 15 previously built rigs still await the full material/art upgrade. Phase 4 legacy retirement, Phase 5 additional catalog/store work, and Phase 6 missing voice/sound/device verification remain unfinished.
- The reference trophy one-frame discrepancy is inherited, unchanged. The missing horseshoe voice clip has not been invented or replaced with an unlicensed recording.
