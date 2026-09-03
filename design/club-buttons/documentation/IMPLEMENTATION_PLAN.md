# #ClubButtons Implementation Plan

## Repository audit summary

The ecosystem is split across four repositories:

- Club Arena: Vite, React 19, React Router, Zustand, Supabase, and discrete table WebSocket events.
- World Hub: Next.js and React 18. It serves the Club Arena build and currently has unrelated unresolved merge conflicts in three poker-training files.
- Club Commander: Next.js and React 18 with an existing vendored `commander-shared` package and unrelated local changes.
- commander-shared: the existing reusable package seam for Hub and Commander, with a pre-existing local layout edit.

Club Arena currently contains multiple button systems (`components/buttons`, `components/common/Button`, and `components/metal-ui`) plus page-local buttons and modals. The audit found hundreds of native buttons across hundreds of UI files. A blind global replacement would break size, event, form, and gameplay assumptions.

## Phase plan

1. Preserve all seven visual references and establish this specification.
2. Prove the primary action, stackable row, hero plaque, tokens, states, data states, and accessibility in Club Arena's `/dev/club-ui` route.
3. Add focused component tests and complete build/type verification.
4. Migrate Club Arena in controlled slices: table utility controls, primary actions, wallets/BBJ, navigation, tournament controls, modals, financial UI, stats/history, settings.
5. Move the proven source into `commander-shared` without overwriting its existing local change. Add Hub and Commander adapters with product-mode defaults.
6. Resolve or work around the unrelated World Hub conflicts before changing any overlapping file. Never resolve those conflicts automatically.
7. Capture production screenshots at 320, 375, 390, 430, 768, 1024, and 1440px after each integration slice.
8. Run each repository's complete tests and build before proposing its branch.

## First migration candidates

- `BadBeatJackpotPage.tsx`: replace the visual jackpot display only; retain its Supabase/MasterBus refresh behavior and its distinct load-failed state.
- `PlayerWalletPage.tsx`: replace wallet presentation only; retain the Zustand source, current balance event refresh, and non-finite guards.
- Table join/register entry points: wrap existing click handlers in `ArenaActionButton`; do not touch the server-authoritative game engine.

## Stop conditions

Stop a migration slice if it requires rewriting business logic, introduces snapshot-driven gameplay UX, truncates critical values, causes horizontal scrolling, downgrades master artwork, or overlaps unresolved user work.
