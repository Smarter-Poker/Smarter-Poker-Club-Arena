# Customization Studios now behave like one product

**Date:** 2026-08-29

## What changed

The Avatar Gallery and Table Studio were audited as live player workflows,
not isolated pickers. Both now use mobile-first full-screen workspaces with
contained catalog scrolling, touch-safe controls, keyboard navigation, focus
traps, Escape dismissal, honest save states, light/dark presentation, and
responsive desktop layouts.

Table Studio is now the one customization surface for themes, tables, dealer
buttons, backgrounds, and card backs. The obsolete duplicate card-back picker
was removed. The studio uses the production table/background/card components
for its previews, keeps the gameplay preview above the catalog on a phone, and
provides search, free/VIP/favorite/recent filters, three loadouts, and safe
randomization. Saved loadouts are checked against the current catalog and the
player's current entitlements before they can be applied.

The existing 97-avatar library remains the only avatar source. No replacement
or preview-only avatar set was introduced.

## Checkout and realtime delivery

Every premium Table Studio asset now has a server-authoritative permanent SKU.
Checkout continues through `fn_purchase_feature`; the new purchase trigger
delivers the exact category entitlement in the same transaction as the diamond
charge. Theme purchases grant their complete linked preset. A successful buy
unlocks and applies the original selection immediately, broadcasts ownership to
other open surfaces, and forces the displayed diamond balance to refresh.

Favorites and loadouts now have an owner-only cloud row and a realtime channel.
Existing device-local collections seed that row on first open, subsequent
changes are coalesced in order, and queued writes carry their explicit owner so
an account switch cannot cross-wire two players' collections. Recent choices
remain deliberately device-local.

`user_theme_settings` also gained a ref-counted client realtime subscription:
all persistent tables for one player share one database channel and repaint
when another device inserts, updates, or deletes that player's table design.

## Media

Dense picker grids no longer decode the full gameplay artwork for every tile.
The build creates 45 WebP derivatives for table and background thumbnails:
19.34 MB of source artwork becomes roughly 0.57 MB for the catalog path, while
the actual table continues to render the full-quality originals.

## Verification

- Full Vitest suite: 596 files, 9,042 passing, 1 intentional skip.
- Production build: passed; 425 distribution images optimized with 0 failures.
- ESLint: 0 errors. The repository still reports its existing warning backlog.
- Mobile Chromium coverage at 390 × 844: Avatar Gallery and Table Studio stay
  viewport-contained; catalogs scroll internally; controls meet the 44px touch
  target; the table preview remains visible; category labels remain complete in
  a horizontal rail; and the document has no horizontal overflow.
- Existing ten-button-theme Chromium contract: passed.

## Release gate

The migration must be applied through the authenticated Supabase release path,
then the schema manifest and deployed build provenance must be verified before
this work is described as published. Local validation cannot substitute for
that production evidence.
