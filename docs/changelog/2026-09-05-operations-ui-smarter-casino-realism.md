# The operations workspace joins #SmarterCasinoRealism

Dan: _"go back and fully upgrade, enhance, optimize and improve the UI in every
possible way shape and form. USE THE #SMARTERCASINOREALISM and upgrade every
single page and sub page you just audited and fixed."_

## The system was already here. The operations pages were not in it.

`src/styles/club-engine.css` carries the material layer on `:root` -
`--realism-obsidian` through `--realism-green`, plus the three light effects
every machined surface in this app is built from (`--realism-bevel`,
`--realism-cavity`, `--realism-lift`). Its own prose says where the work goes:
_"Realism on any other page is that page's own stylesheet, drawing from the
tokens above."_

Measured before this pass, across the eleven stylesheets behind the operations
registry:

```
505 hardcoded hex literals
  0 references to a --realism-* token
```

Eleven pages, each with its own private palette, all approximating the same
seven colours. That drift is the thing a player sees.

After:

```
101 hardcoded hex literals   (every one deliberate, and named below)
633 references to a --realism-* token
```

| stylesheet                        | hex before | hex after | tokens |
| --------------------------------- | ---------- | --------- | ------ |
| `ClubRulesPage.css`               | 11         | 1         | 18     |
| `ClubAnnouncementsPage.css`       | 26         | 2         | 43     |
| `PromoVaultPage.css`              | 56         | 9         | 79     |
| `PromotionsPage.css`              | 34         | 12        | 40     |
| `ClubSettingsPage.css`            | 61         | 18        | 57     |
| `ReportReviewPage.css`            | 65         | 10        | 64     |
| `SuperAgentDashboard.css`         | 48         | 1         | 73     |
| `BlacklistManagerPage.module.css` | 60         | 17        | 49     |
| `AntiCheatPage.module.css`        | 60         | 10        | 58     |
| `SettlementPage.module.css`       | 22         | 11        | 52     |
| `CashierPage.module.css`          | 62         | 10        | 100    |

## What "material" means on these pages

A surface is a made object. Every card, panel, metric tile, row container and
modal now carries the same recipe: a panel-raised to panel gradient, a 1px
gunmetal edge, and bevel + cavity + lift. Every input, textarea and select is
the INVERSE - a cavity cut into the panel, with an inset shadow - so a field
reads as somewhere you put something rather than another card. Every button has
the milled face and an `:active` press you can feel on a phone.

**Interaction is `:focus-visible` and `:active`, never `:hover`.** There is no
hover on a phone, `tests/no-hover-effects.law.test.ts` exists, and the reference
sheet has zero hover rules. Not one was added.

## What was deliberately left alone, and why

The 101 surviving hex literals are not oversights.

- **Every red and every amber.** On a blacklist, an integrity console, a
  settlement screen and two cashiers, those are verdicts about a player or a
  sum of money. A token would have made them prettier and less meaningful.
- **Gradient far-stops** (`#0099cc`, `#2563eb`, the settlement green) - swapping
  only the near stop leaves a gradient that reads as broken.
- **Text on saturated fills**, where the colour is contrast against the fill
  rather than a type role.
- **The promo vault's tier colours.** That page's header records a standing
  instruction: _"NO GREEN AND NO PURPLE ... Arena cyan for features, the three
  VIP tiers in bronze, club blue and gold."_ `--realism-green` appears nowhere
  in that file. Bronze `#C88A4A` has no token and stays.
- **`.txRow`'s divider** in the classic cashier was converted to solid gunmetal
  and then reverted, with the reason written in: gunmetal is the milled EDGE of
  a surface, and a solid one on every row of a long ledger reads as stripes.

## Three things worth knowing

**Reduced motion is scoped per sheet, not universal.** The reference sheet uses
`.page *`, which is right for a page that owns everything inside it. The
promotions page does not: the daily bonus wheel renders inside it and its spin
lives in another stylesheet. A universal `animation-duration: 0.01ms !important`
would have reached an animation this sheet does not own and collapsed the
result reveal to one frame. CLAUDE.md 10.6 - motion may collapse, meaning never
does. Each block lists its own selectors. The cashier's `.spinner` is excluded
outright: it is the only signal that a transfer is still in flight.

**`ClubSettingsPage.css` is a global sheet, and seven of its names are declared
bare by other stylesheets** (`.settings-section`, `.toggle-btn`, `.btn-danger`,
`.modal-overlay` and three more). Colour and shadow changes were made only
inside rules that already declared that property; every rule needing a NEW
property went into a block scoped under `.club-settings-page`, so it cannot
reach TwoFactorSetup, ErrorBoundary, FormToggle, SettingsPanel or the report
queue. The leak ratchet was at 161 before this pass and is at 161 after it.

**A contrast note that is a real trade-off, not a defect.** In the classic
cashier the house blue `#1877f2` maps to `--realism-blue` (`#4169e1`), which
drops small-text contrast on near-black from about 4.8:1 to 3.9:1 on chips that
were already under 4.5:1. The house/brand mapping is what the system asks for.
If those readings matter more than the vocabulary, the fix is to route those
TEXT uses to `--realism-cyan`; it is recorded here rather than decided quietly.

## Verified

- Full suite green: **14,078 tests**, `tsc` clean, `check-css-modules` OK.
- `no-hover-effects.law`, `realism-is-one-vocabulary.law` and
  `global-css-does-not-leak-across-pages.law` all pass.
- Prettier clean on all eleven files, so the commit hook reformats nothing.
- No class selector was renamed, added or deleted in any of the eleven sheets -
  verified by diffing each file's comment-stripped class inventory against
  `HEAD`. The `.tsx` files were not changed, so every selector still matches.
- No `display`, `grid-template`, `flex-direction`, `width`, `height`, `padding`,
  `margin`, `position`, `gap` or `z-index` was touched. Border widths and radii
  changed only where the pass report names them.
