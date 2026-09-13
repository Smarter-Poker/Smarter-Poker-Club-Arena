# Cashier Club Arena Console Compliance

## Scope

The Cashier route, its trade workspace, and every Cashier-owned dialog now use the approved Club Arena Console master artwork and interaction grammar. The release preserves the existing wallet, transfer, cashout, mint, ledger, authorization, realtime, club-switching, right-click, and mobile long-press behavior.

## Surfaces

- Club Cashier and no-club state
- Cashier Trade workspace and its receipt, chip request, transfer, and claim-back dialogs
- Club wallet Cashier
- Player wallet details
- Cashout request
- Chip mint
- In-table Cashier
- Union wallet Cashier
- Cashier club and union switcher

## Visual Contract

- One continuous approved console master per Cashier surface
- Black glass content wells with machined metal framing
- Approved club, diamond, and VIP crests
- Painted dual-action plates where two actions are available
- Word controls for single-action close states
- Frameless numeric entry fields without browser spinner controls
- No generic close glyphs, fallback image boxes, rounded cards, synthetic gradients, or CSS-drawn hardware
- 44-pixel minimum interactive targets and no hover-only behavior

## Verification

- Cashier console law suite
- Cashier, wallet, union, ledger, authorization, realtime, and club-switcher regression suites
- UI copy, Title Case, painted-text, and navigation gates
- TypeScript and changed-file lint checks
- 393-pixel rendered review of all Cashier surfaces and dialogs
- Production build, deployment provenance, and authenticated live-route checks are required before release certification
