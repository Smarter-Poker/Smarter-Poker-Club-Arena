# Approved Club Arena Footer Is Global

The approved Club Arena footer artwork is now the single global application footer on every applicable Club Arena route.

## What changed

- Preserved the supplied approved source artwork and added a lossless production WebP crop.
- Rebuilt `ClubBottomNav` as six semantic navigation links over the exact artwork: Settings, Players, Cashier, Market, Data, and Stats.
- Mounted the footer once at the application root and removed all page-local mounts.
- Added central route visibility policy for public and immersive footerless surfaces.
- Scaled the complete footer proportionally at narrow widths so all six icons and labels remain visible at once with no horizontal scrolling.
- Added safe-area-aware, artwork-derived content clearance.
- Removed the unused generic fixed-bottom navigation `TabBar` implementation.
- Excluded the approved lossless footer asset from destructive production recompression.

## Verification

- All 118 declared routes were audited: 108 receive the footer and 10 documented public or immersive routes remain footerless.
- The complete footer was measured with all six controls visible and zero page/footer overflow from 320px through 1920px.
- The built footer asset is byte-identical to the public asset and has zero absolute pixel error.
- Client TypeScript, the full Vitest suite, and the production build pass locally.
