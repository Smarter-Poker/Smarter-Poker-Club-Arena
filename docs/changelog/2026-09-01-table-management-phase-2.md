# 2026-09-01 - Table management Phase 2

## Shipped

- Rebuilt the management console around the `#SmarterCasinoRealism` visual language: black-first surfaces, precision gunmetal framing, restrained electric-blue telemetry, angular controls, and an original photorealistic poker operations render.
- Split the console into Game Board, Ticker Management, and Club Messages work surfaces while preserving the existing create-table and create-tournament builders.
- Added event-driven Game Board refreshes for table creation, game changes, registrations, closures, and tournament changes.
- Made maintenance/service ticker notices real. Operators can now author a separate five-message service rotation, save it with ticker settings, display it with a dedicated label, and dismiss it independently from promotions.
- Added explicit server and client lifecycle locks: an occupied cash table cannot be closed, and a tournament cannot be changed or cancelled after the first real player registration.
- Removed the management force-close/refund path. Seat exits remain owned by the canonical player/engine cash-out transaction, and registered tournament contracts remain immutable.
- Added readable operator notifications for occupied/registered locks and invalid management actions.
- Wrapped the consolidated DDL migration in one transaction to coalesce PostgREST schema-cache reloads.
- Compressed the generated command-console artwork from 1.7 MB PNG to a 112 KB WebP without changing its display dimensions.

## Deliberately not changed

- Existing create-table, MTT, Spin, and Sit-N-Go forms and their service wiring remain the canonical creation experience.
- No production migration was applied and no deployment was performed in this session.
- Running-game engine state and seat settlement code were not modified; management now refuses actions that would cross those boundaries.
