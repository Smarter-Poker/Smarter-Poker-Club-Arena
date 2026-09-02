# Footer route, WebKit, and club resolution hardening

## User-visible change

- The approved six-control Club Arena footer now tops out at 84px on desktop,
  matching the compact global header ceiling while retaining 44px touch targets.
- A club route such as `/clubs/:clubId/cashier` supplies its club ID immediately;
  stale lobby cache or a later membership request can no longer send Settings,
  Players, Cashier, or Data to the wrong club.
- The Club Arena card lobby remains explicitly footerless.
- `/dev/footer` is a production-safe, data-free visual health surface for the
  post-deploy monitor.

## Regression coverage

- Chromium and real WebKit measure the exact artwork and all six hit regions at
  320, 390, 430, 768, 1100, 1366, and 1920px widths.
- A real route test proves the deployed component remains fixed to the viewport.
- The existing post-deploy E2E workflow now installs WebKit and runs the footer
  route contract after every successful Club Arena publish.
- Unit coverage pins route-club precedence, explicit overrides, compact chrome,
  one app-root mount, safe-area clearance, and the footerless lobby policy.

## Verification

- TypeScript and targeted footer tests pass.
- The complete Vitest suite passes: 624 files and 9,302 tests.
- Chromium/WebKit multi-viewport geometry passes.
- The production Vite build completes successfully.
