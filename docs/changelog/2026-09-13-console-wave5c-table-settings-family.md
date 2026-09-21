# 2026-09-13 - #ClubArenaConsole wave 5c: the table settings family

Three surfaces a seated player opens from the table menu, rebuilt on Dan's
approved spade master (`src/components/console/SpadeConsole.*`) or, where the
surface is felt cinematics rather than a card, inked in schema colours and
left unframed. Nothing behind the picture changed: every handler, guard,
timer, ref, focus trap, subscription, persisted key and test-pinned literal is
where it was.

## Table Studio (`ThemeSettingsModal`)

The 2,500-line studio was a bespoke steel workstation: gradient shell, drawn
tabs, bordered tiles, a gold plaque for a price, a blue disc for a tick, a
dashed slot for an empty look. It is now one console:

- head: `Player Table Studio` / `Make The Table Yours`, the game type it
  applies to printed in the painted pill slot;
- glass: the table-art link status (same six strings, `Table Art Live`,
  `Linking...`, `Applying...`, `Reconnect`, `Review Sync`, `Balance Sync`,
  because the unit and production specs pin them), `Close` as a lit word
  (`.theme-modal__close`, still first in the DOM so it takes focus on open),
  the game-type select, Light/Dark and Standard/Final Table as lit words with
  `aria-pressed`, the live gameplay preview as a picture with its caption
  under it, the selection ledger as four label/value rows, five tabs as lit
  words (`role="tab"`, arrow keys, the same ids), the catalog as the real
  artwork with the name and standing printed under each tile and the
  favourite star beside them, the locked price as a lit gold word over dimmed
  art, and the three saved looks as rows with Equip/Update/Clear as words;
- foot: the painted plates, `Restore Defaults` on steel and `Done` on the blue
  glass (still `Saving...` while a write is in flight, still disabled while
  the design is loading).

The purchase prompt is a second, smaller console under the diamond crest:
`Cancel` on steel, `Buy For N ◆` / `Add N Diamonds` on the blue glass. The
plates paint Cancel before Buy, so the open-focus line prefers
`#theme-purchase-buy` before falling back to the first control - the Buy
button had first focus before and keeps it.

CSS literals the architecture test pins are kept and true: the overlay is
`height: 100dvh` and scrolls; from 960px the dialog wrapper is
`width: min(92vw, 1440px)` with the console centred at its own 1000px
ceiling; the workspace inside the glass is `grid-template-columns:
minmax(360px, 44%) minmax(0, 56%)` at that width; tiles keep
`content-visibility: auto`, `object-fit: contain` on the art and `cover` on
the ambient duplicate.

**The thirty preview-shell baselines were regenerated.** `customization-
studios.spec.ts` clips `.theme-modal__preview-shell` at 390px and 768px and
compares at `maxDiffPixelRatio: 0.02`; the shell is now a region of the
glass rather than a bordered panel, so every clip changed size. They were
regenerated the way #3782 did it - deleted, written on a clean run, verified
on a second - not with `--update-snapshots`.

## Table Settings (`SettingsPanel`)

The slide-in side sheet is a console with the rails bridged flat (`crest=
"flat"`; a preferences sheet, not a showpiece). Every setting is a row on the
glass with an engraved rule between rows; every switch is a lit word (`role=
"switch"`, ON green, OFF muted - the hidden checkbox it replaces announced
nothing); Animation Speed is three lit words with `aria-pressed` on the same
`handleSelect`; the volume slider is the one drawn control and it runs up and
down (`writing-mode: vertical-lr`, `aria-orientation="vertical"`), because a
sideways drag at the felt switches tables. The pill prints the sound state.
Two actions, so plates: `Reset To Defaults` on steel, `Close` on the blue
glass. `resetPayload`, `RESETTABLE_KEYS`, the backdrop-only dismiss and the
80ms staggered section reveal are untouched.

`TableSettingsPanel` (`mode="inline"`, Bible V8 §11.1) still renders inside
this console with its own drawn toggle cards. It is a separate surface with
its own stylesheet and was outside this batch; it is the next thing to put on
the glass, and until then it is a frame inside a frame.

## Tournament announcements (`TournamentAnnouncementOverlay`)

Felt cinematics (a vignette with a light sweep, and the compact level banner),
the same ruling as BombPotOverlay: inked, not framed. The per-beat accents are
now schema colours - brass `#d6ad52` for hand-for-hand, brand gold `#ffd700`
for the final table and the mystery bounty, the lit blue `#45adff` for a level
change, the house green for the bubble, accent red `#f02849` for knockouts
and the seven-deuce bounty. Slate copy is silver `#e4e7ec`, whites are
`#f4f7fb`, blacks are the console's `#050607`, the final-table rules are
brass at reduced alpha over black. The knockout and mystery-bounty lines,
the only two on the overlay not in Title Case, now are. Every animation still
plays; reduced motion still lands the subtitle and the rule fully drawn.

## Verification

`check-title-case`, `check-painted-text-case`, `check-nav-title-case`,
`check-ui-text`, `check-css-modules` OK; `tsc --noEmit -p tsconfig.app.json`
clean for these files; the 35 tests naming these components plus the console
laws green; `customization-studios.spec.ts` (axe, 44px targets, keyboard,
zoom, forced colours, purchase, cross-tab, and the thirty re-blessed
baselines) green on the Mac. Rendered before and after at 393px in every
tab and state.
