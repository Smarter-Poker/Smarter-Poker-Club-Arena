# Production Asset Manifest

## Runtime files

| File                                                   | Role                       | Scaling                     |
| ------------------------------------------------------ | -------------------------- | --------------------------- |
| `public/assets/club-buttons/action-primary-shell.webp` | Wide primary action shell  | Fixed 4.06:1 aspect ratio   |
| `public/assets/club-buttons/club-utility-shell.webp`   | Square utility shell       | Fixed near-square ratio     |
| `public/assets/club-buttons/club-nav-shell.webp`       | Connected navigation shell | Stretch-safe center         |
| `public/assets/club-buttons/wallet-row-shell.png`      | Stack-safe row shell       | CSS border-image cap insets |
| `public/assets/club-buttons/jackpot-hero-shell.webp`   | Live BBJ hero shell        | Fixed 1.726:1 aspect ratio  |

Lossless PNG masters are stored beside the runtime files and copied into `production-shells/desktop/`.

## Premium game-card runtime families

Each family has a lossless PNG master and a compressed WebP runtime shell for
both desktop and mobile. The artwork contains only the premium chassis,
engraved labels, hardware icons, and empty display/action bays; all game data,
status text, rule tags, and buttons remain live DOM content.

| Family   | Desktop runtime shell                                                  | Mobile runtime shell                                                  |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| MTT      | `public/assets/club-buttons/game-cards/mtt/shell-desktop-v2.webp`      | `public/assets/club-buttons/game-cards/mtt/shell-mobile-v2.webp`      |
| NLH cash | `public/assets/club-buttons/game-cards/nlh/shell-desktop-v2.webp`      | `public/assets/club-buttons/game-cards/nlh/shell-mobile-v2.webp`      |
| PLO      | `public/assets/club-buttons/game-cards/plo/shell-desktop-v2.webp`      | `public/assets/club-buttons/game-cards/plo/shell-mobile-v2.webp`      |
| Spins    | `public/assets/club-buttons/game-cards/spins/shell-desktop-v2.webp`    | `public/assets/club-buttons/game-cards/spins/shell-mobile-v2.webp`    |
| Heads Up | `public/assets/club-buttons/game-cards/heads-up/shell-desktop-v2.webp` | `public/assets/club-buttons/game-cards/heads-up/shell-mobile-v2.webp` |

The corresponding `.png` files beside each runtime shell are the lossless
masters. All five V2 skins are the approved defaults in
`arenaGameCardRegistry.ts`; V1 skins remain available only as explicit
fallbacks for rollback and comparison.

## Generation method

Built-in image generation was used with the high-authority BBJ and individual-wallet masters as material references. `06_STACK_SAFE_VARIED_COMPONENT_ARCHITECTURE.png` was used only for proportions and component architecture.

The renderer initially painted a checkerboard instead of producing alpha. This was detected by inspecting the PNG type. The backgrounds were removed non-destructively with a 9% edge-connected tolerance, the objects were trimmed, and alpha was verified before runtime conversion.

## Normalized prompt set

### Primary action

Generate a single textless wide primary-action shell. Match the BBJ and wallet masters' chrome, brushed gunmetal, black-glass depth, bevel hierarchy, controlled crystal-blue inserts, reflections, and physical weight. Use the architecture board only for the wide JOIN TABLE silhouette. Include a contained empty icon well, empty stretch-safe content plane, and contained action well. Orthographic front view, no text or glyphs, all parts within bounds, transparent background, no generic CSS-button look or blue flood.

### Stackable row

Generate a single textless compact wallet-row shell. Match the high-authority master materials. Use the architecture board only for stack-safe proportions. Include a contained octagonal empty icon housing, empty stretch-safe black-glass plane, and contained action well. Orthographic front view, all hardware inside the row box, no protruding medallion, no baked value, transparent background.

### Jackpot hero

Generate a textless BBJ hero plaque shell. Image 01 is the absolute quality authority and Image 02 controls composition. Include empty raised badge, heading, large live-value, lower-caption, and bottom-medallion zones. Preserve stepped chrome/gunmetal construction, deep black glass, localized crystal-blue inserts, shadows, and realistic reflections. No letters, currency, values, suits, or logos; transparent background.

### Utility control

Generate one textless square or octagonal utility-control shell using the BBJ master as the material authority and the architecture board only for proportions. Use a recessed black-glass center, polished chrome perimeter, brushed-gunmetal chassis, machined bevel, restrained lower blue LED seam, and contained side crystal accents. Keep every part within the square bounding box. Orthographic front view, no icon, text, symbol, watermark, blue flood, or generic app-tile treatment; transparent background.

### Navigation segment

Generate one textless wide, low-profile connected navigation-tab shell using the BBJ master as the material authority and the architecture board only for proportions. Use a recessed black-glass center, chrome edge, compact angled metal end caps, restrained lower blue seam, and tiny corner energy points. Preserve end-cap geometry while allowing the center to stretch. Orthographic front view, no text, icon, symbol, watermark, pill styling, or blue flood; transparent background.

The utility source was generated in built-in mode at `/Users/smarter.poker/.codex/generated_images/01a045b0-0d71-73c0-910f-ce9bfddc9086/exec-2f902a68-37fb-4352-9e10-e0a255f20162.png`. The navigation source was generated in built-in mode at `/Users/smarter.poker/.codex/generated_images/01a045b0-0d71-73c0-910f-ce9bfddc9086/exec-c50a3ba8-78df-4381-a9b3-458d40c5bc29.png`.

## State assets

Hover, pressed, selected, disabled, loading, danger, success, stale, and offline are currently lightweight CSS overlays. Separate raster files are unnecessary because the shell material remains unchanged. Add raster overlays only when future visual QA proves a CSS overlay cannot preserve the approved quality.
