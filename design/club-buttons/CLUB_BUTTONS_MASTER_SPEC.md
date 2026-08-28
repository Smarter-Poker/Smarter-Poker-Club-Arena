# #ClubButtons Production Specification

Status: foundation implemented in Club Arena. This document records the working implementation, not the small-component quality ceiling shown on overview boards.

First production migration: the live hero on `BadBeatJackpotPage.tsx` now uses `ArenaJackpotDisplay`. Its existing data source, refresh events, threshold rules, loading branch, no-pool branch, and read-failure branch remain unchanged.

## Authority order

1. `master-references/01_BBJ_MASTER_QUALITY_BAR.png`
2. `master-references/03_CASH_WALLET_MASTER_DETAIL.png`
3. `master-references/04_TOURNAMENT_WALLET_MASTER_DETAIL.png`
4. `master-references/05_DIAMOND_WALLET_MASTER_DETAIL.png`
5. `master-references/02_BBJ_PLUS_WALLETS_MASTER_COMPOSITION.png`
6. `master-references/06_STACK_SAFE_VARIED_COMPONENT_ARCHITECTURE.png`
7. `master-references/07_MOBILE_FIRST_MASTER_KIT_OVERVIEW.png`

The first four files control material realism. The final two files control coverage, varied silhouettes, states, and mobile architecture only. A simplified item on an overview board never authorizes a simplified production surface.

## Production architecture

The working system is hybrid:

```text
static hyper-realistic shell
  + live React content zones
  + semantic HTML interaction
  + lightweight state overlays
  + application state and formatters
```

The shell never owns business logic or live values. Current shell assets live under `public/assets/club-buttons/`; lossless production masters and source references live under this design directory.

### Shell rules

- Action and hero shells preserve a fixed master aspect ratio. Their live text and icons are separate DOM layers.
- Stackable wallet rows use CSS `border-image` cap insets. Fixed end caps remain intact while the center stretches.
- Wallet icons remain entirely inside each row. No stackable component may protrude above or below its own box.
- PNG is the lossless alpha master. WebP is the optimized runtime format where supported by the component.
- Runtime state overlays may change light, transform, opacity, or a localized energy color. They may not replace the manufactured shell with a generic gradient.
- A mobile-specific shell is required when a fixed-ratio shell can no longer preserve the content priority order. The current action and jackpot shells retain their proportions at 320px, so the foundation uses the same artwork at reduced resolution.

## Implemented families

The Club Arena foundation exports:

- `ClubButtonsSurface`
- `ArenaActionButton`
- `ArenaWalletRow`
- `ArenaJackpotDisplay`
- `ArenaValueDisplay`
- `ArenaIconButton`
- `ArenaTabs`
- `ArenaBadge`
- `ArenaPanel`
- `ArenaInput`
- `ArenaSelect`
- `ArenaToggle`
- `ArenaModalFrame`
- `ClubIcon`

All are exported from `src/components/club-buttons/index.ts`. The laboratory route is `/dev/club-ui` inside the existing authenticated application shell.

## Content zones

Action: `icon`, `label`, `sublabel`, `value`, `actionIndicator`, `loadingIndicator`.

Wallet row: `icon`, `label`, `sublabel`, `value`, `dataState`, `actionIndicator`.

Jackpot: `badge`, `eyebrow`, `value`, `label`, `dataState`.

The current data-state vocabulary is `loading`, `loaded`, `updating`, `empty`, `error`, `stale`, and `offline`. Unknown data never renders as zero.

## Tokens

Tokens are defined in `src/components/club-buttons/club-buttons.css` with a `--club-` prefix. They cover black, gunmetal, chrome, energy colors, semantic tones, type families, touch target, durations, focus, energy strength, bevel depth, and density.

Black dominates. Chrome builds the chassis. Blue appears only as controlled energy. Red, green, gold, and purple are semantic accents.

Typography:

- Premium headings: Cinzel 600-700.
- Controls: Inter 600-700.
- Live numbers: Roboto Condensed 700 with `font-variant-numeric: tabular-nums`.

## Product modes

`ClubButtonsSurface` sets `data-club-mode`:

- `arena`: full visual depth and the strongest controlled blue energy.
- `hub`: cleaner navigation density and reduced illumination.
- `commander`: tighter density, lower bevel depth, and restrained illumination.

Mode changes visual density only. It does not fork component behavior.

## Interaction and accessibility

- Controls remain native `button`, `input`, and `select` elements.
- Loading controls expose `aria-busy` and become disabled when an action cannot be repeated safely.
- Selected utility controls expose `aria-pressed`.
- Tabs use ARIA tab roles, roving `tabIndex`, arrow keys, Home, End, and focus-follow-selection.
- The modal uses `role="dialog"`, `aria-modal`, initial focus, Escape dismissal, focus containment, and focus return.
- Focus is visible independently of hover.
- The minimum target is 44px; the default system target is 48px.
- Motion respects `prefers-reduced-motion`.

## Responsive priorities

At narrow widths preserve, in order: critical value, primary label, primary action, core icon, status, sublabel, decorative hardware. Optional sublabels disappear below 430px before a critical monetary value is shortened. The laboratory contains 320, 375, 390, and 430px stress frames.

## Performance

- Shells are static cacheable files.
- Live values update in isolated DOM nodes; an amount change does not recreate the shell.
- Animations use transform, opacity, and small localized shadows.
- The runtime WebP shell set is less than 100 KB total in the foundation.
- Components contain no polling, database access, or subscriptions. Existing application state and realtime services remain authoritative.

## Migration law

For each replacement, preserve the existing props, handlers, routes, authorization, validation, analytics, loading conditions, and realtime source. Replace only the presentation layer. A visually correct control that breaks a handler is a failed migration.

Do not bulk-replace every `<button>`. Select the correct family and verify each flow in its real context.
