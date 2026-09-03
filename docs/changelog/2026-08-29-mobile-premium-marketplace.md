# 2026-08-29 — mobile-first premium marketplace

## Shipped

- Rebuilt the Club Marketplace as a cohesive Smarter Casino Realism experience with an obsidian, steel, brass, and electric-blue visual system.
- Added responsive one-, two-, and three-column layouts while keeping artwork uncropped and controls touch-first on mobile.
- Unified store, Diamond Vault, membership, inventory, administration, statistics, forms, and purchase flows across light and dark modes.
- Reworked product badges so category, sale, stock, and purchase-limit states no longer overlap.
- Upgraded purchase confirmation into an accessible mobile bottom sheet and desktop dialog with focus containment, focus restoration, safe disabled-state focus, and reduced-motion support.
- Clarified Diamond purchasing language and kept internal destinations inside the SPA instead of forcing a full reload.
- Added UI contract and interaction tests covering responsive layout, artwork containment, touch targets, links, dialog accessibility, and keyboard behavior.

## Verification

- `npm run lint` — passed with no errors (existing warnings remain).
- `npm run typecheck` — passed.
- `npm run test` — 592 files passed; 9,023 tests passed and 1 skipped.
- `npm run build` — passed with production bundle and media optimization complete.
- Mobile store and purchase-sheet renders were reviewed at 390 × 844.

## Deliberately not changed

- No game-engine, operations API, checkout contract, database, or migration changes were required for this visual and interaction pass.
- Existing hover effects were not added because Club Arena's interaction law requires touch-first behavior.
