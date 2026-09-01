# Mobile Visual Lock

## NLH cash card — `spade-nlh-premium-v1`

Status: approved as the production mobile NLH default on 2026-09-01.

- Approved master: `729 × 945` pixels.
- Runtime review width: `430px` (`557.41px` proportional height).
- Static image-owned layers: chassis, live dot, running status, NLH type plaque, View Table face, Join Table face, permanent labels, frame ornaments, and spade emblem.
- Live text-owned fields: title, subtitle, stakes, players, and buy-in.
- Interaction-owned layers: transparent semantic View Table and Join Table buttons using the existing action callbacks.
- Coordinate source: `src/components/lobby/game-cards/nlhPremiumTemplate.ts`.
- Runtime renderer: `src/components/lobby/game-cards/NlhPremiumCard.tsx`.
- Asset package: `public/assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/`.

This is now the approved production layering contract. Other card families may
adopt it only with their own measured master, coordinate map, and side-by-side
visual approval; they must not reuse NLH coordinates or add opaque DOM fills
over image-owned wells.
