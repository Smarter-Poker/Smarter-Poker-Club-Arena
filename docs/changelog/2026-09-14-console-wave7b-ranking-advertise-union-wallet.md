# 2026-09-14 - #ClubArenaConsole wave 7B: the ranking card, advertise, the union wallet, create union, sit out, jackpot announcements

Six generic surfaces rebuilt on Dan's approved masters. Two more were opened,
found to be finished work on another approved master, and left alone.

## What moved onto a master

| Surface                                               | Chassis                           | Foot                                        |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------- |
| `src/components/tournament/TournamentRankingCard.tsx` | spade console, VIP crest          | plates: Share / Play Again                  |
| `src/pages/ClubAdvertisePage.tsx`                     | six consoles, one per section     | flat cap + lit words; plates on The Details |
| `src/components/union/UnionWalletModal.tsx`           | riveted console (the money frame) | plates: Close / Send, Pull, Load More       |
| `src/components/union/CreateUnionModal.tsx`           | spade console, club crest         | plates: Cancel / Create Union               |
| `src/components/table/SitOutModal.tsx`                | spade console, flat crest, 330px  | flat cap + a lit Leave Table                |
| `src/components/bbj/BBJThresholdPanel.tsx`            | spade console, diamond crest      | plates for staff, flat cap for a member     |

Every frame, header well, pill slot and action plate is painted in the master.
The only things still drawn are the form fields, the two advert previews and
the ranking card's medal - no master contains a disc that can carry an
arbitrary finishing place in four metals.

## Defects found on the way, and fixed

1. **The ranking card's medal has never had a colour.** `medalClass()` returned
   `trc2-medal--gold` (one dash) while the stylesheet has always declared
   `.trc2__medal--gold`. Nothing matched, so `--trc2-medal-face`,
   `--trc2-medal-edge`, `--trc2-medal-ink` and `--trc2-band` were never set:
   every medal was an empty ring, every trophy took the card's text colour, and
   every place band fell through to its `#233355` fallback. First, second and
   third have been indistinguishable from 47th since the classes were written.
2. **Create Union was not a dialog.** No `role="dialog"`, no `aria-modal`, no
   Escape, no focus trap, no focus return. `metallic-popups.css` scopes every
   control it dresses to `[role='dialog']`, so both of its fields rendered as
   RAW BROWSER INPUTS - white boxes with a monospace placeholder - on a black
   sheet. Its tokens (`--surface-card`, `--radius-xl`, `--space-6`) are declared
   only in sheets `main.tsx` does not import, so they were undefined at runtime
   as well. Its toasts were sentence case.
3. **The union wallet had a second `titleCase`.** A local copy lower-cased the
   tail of every word, so the ledger printed "Bbj Sweep" and "Mtt Fee" for
   `bbj_sweep` and `mtt_fee`. It now uses `enumToTitleCase` from
   `src/utils/titleCase.ts`, which knows the product's initialisms.
4. **Data reached the screen without Title Case** (Dan 2026-09-14) in four
   places the copy gates cannot see: club and member names and ledger notes in
   the union wallet, the operator's note on a jackpot announcement, and the
   headline, surface label and review note on an advert. All now go through
   `titleCase()` at the print site.
5. **Warm hues on money and gameplay surfaces.** The union wallet tinted an
   owner `#ffd166`; the advertise page badged "Awaiting Review" in amber. Both
   are the master's own ink now.
6. **The riveted base always paints two plates.** `bottom.png` carries them, so
   `foot="foot"` on that family leaves two painted plates with nothing on them.
   Every page of the union wallet fills both; the read-only Spin Reserve gets a
   disabled plate that says READ ONLY rather than an empty one.

## Left alone, and why

- `src/components/cash/CashGameCard.tsx` is **already on an approved master**:
  Dan supplied Classic, Action and Madness as finished artwork
  (`public/images/cash-cards/*.webp`) with every value baked in, and the
  component prints live text into zones measured on those renders in percent of
  the 784 x 1168 frame. `tests/unit/cashGameCard.test.tsx` is its visual
  contract ("a zone that drifts off the artwork is a card that lies"). Finished
  work.
- `src/components/bbj/BBJBasicPanel.tsx` is **already on this standard**. It is
  a page of the BBJ console's glass, and its stylesheet says so: cqw sizing,
  engraved rules, the master's inks, no radius, no gradient, no `:hover`.

## Tests changed

`tests/config/spinReserveWalletView.test.ts`, one case. It proved the send
button was gated by finding the string `Pick A Member` after the first
`{!readOnly && (`. The send button is the foot's painted primary plate now, so
its label is computed above the JSX and the guard is a ternary. The same
protection is pinned against the new shape: `showSend` is `!readOnly && mode
!== 'ledger'`, `send()` is called exactly once and only inside that branch, and
the reserve's plate says READ ONLY.

## Gates

`check-ui-text`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case` and `check-css-modules` all exit 0.
`npx tsc --noEmit -p tsconfig.app.json` prints nothing. 25 test files / 472
tests green, including `rankingCardPalette`, `classNamesResolve`,
`no-hover-effects`, `gameplay-wears-the-house-colours`, `a-horse-is-never-named`,
`discardedErrorReadRatchet` and
`every-file-the-user-gets-goes-through-one-door`. Prettier clean.
