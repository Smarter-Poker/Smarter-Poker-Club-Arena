# Production Asset Manifest

## Runtime files

| File                                                   | Role                      | Scaling                     |
| ------------------------------------------------------ | ------------------------- | --------------------------- |
| `public/assets/club-buttons/action-primary-shell.webp` | Wide primary action shell | Fixed 4.06:1 aspect ratio   |
| `public/assets/club-buttons/wallet-row-shell.png`      | Stack-safe row shell      | CSS border-image cap insets |
| `public/assets/club-buttons/jackpot-hero-shell.webp`   | Live BBJ hero shell       | Fixed 1.726:1 aspect ratio  |

Lossless PNG masters are stored beside the runtime files and copied into `production-shells/desktop/`.

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

## State assets

Hover, pressed, selected, disabled, loading, danger, success, stale, and offline are currently lightweight CSS overlays. Separate raster files are unnecessary because the shell material remains unchanged. Add raster overlays only when future visual QA proves a CSS overlay cannot preserve the approved quality.
