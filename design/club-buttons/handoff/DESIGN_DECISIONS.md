# Design Decisions

## Club Arena scope only

The work is isolated to Club Arena. Earlier global styling caused unintended product-wide changes. This boundary is reversible only through an explicitly approved future migration.

## Artwork is hardware; live DOM is data

Frames and decorative icons may be images. Names, values, statuses, filters, and actions remain semantic DOM. This supports realtime data, localization, accessibility, and interaction.

## One canonical component source

Shared component behavior lives in `src/components/club-buttons/`; visual masters live under `design/club-buttons/`; runtime copies live under `public/assets/club-buttons/`. Club Arena, World Hub, and Club Commander must consume the same components rather than fork them. Actual rollout outside Club Arena is not authorized yet.

## Long wallets in live lobby

Square wallets were superseded by long single-line wallets. On mobile they stack vertically under BBJ. This is an approved, locked decision.

## Cards/BBJ/wallets locked; command center below

The premium command-center design applies below the identity/BBJ/wallet area. It must not restyle or replace those locked elements.

## Mobile game cards, desktop table

Desktop may retain a dense table-like display. Mobile must use purpose-built cards for MTT, NLH, PLO, Spins, and Heads Up. This is necessary for legibility and touch behavior.
