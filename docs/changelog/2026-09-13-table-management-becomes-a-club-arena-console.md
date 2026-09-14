# Table Management Becomes A Club Arena Console

## What Changed

- Rebuilt the club and union Table Management shell on the approved `SpadeConsole` master.
- Replaced generic game rows with the bitmap-backed `ArenaGameCard` family used by the live lobby.
- Added a dedicated four-bay rendered command rail for Add Table, Event, Spins, and Sit N Go.
- Rebuilt the table selector, table configuration route, tournament creator, edit dialog, schedule-close dialog, and contract-history dialog to use approved Club Arena console chassis and print live content into them.
- Removed decorative CSS gradients, rounded pills, generic line icons, and faux card frames from the Table Management, Ticker Management, and Club Message Management surfaces.

## Behavior Preserved

- A club managed by a union still fails closed and cannot reach creation or management controls.
- Occupied cash tables still cannot close or schedule a close.
- Registered tournaments still cannot be changed, cancelled, or scheduled for cancellation.
- Realtime refresh, command receipts, contract history, ticker concurrency protection, message character limits, and announcement revision checks are unchanged.

## Verification

- ClubArenaConsole generic-surface scanner returns no Table Management findings.
- TypeScript application compiler passes.
- UI text, Title Case, painted text, navigation text, accessibility, no-hover, popup-system, and Table Management architecture tests pass.
- Production Vite build completes; final release provenance is checked again after the feature branch is synchronized with `origin/main`.
