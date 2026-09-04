# 2026-09-04: Mobile lobby batch four - KingFish club card, My Wallets master, spade PLO card, Variant menu proof

Dan, verbatim: "1, YOU NEED TO MAKE THE CLUB CARD LOOK EXACTLY LIKE THIS. 2, YOU
NEED TO MAKE THE WALLETS LOOK EXACTLY LIKE THIS. 3, THE TOPS OF THE PLO FRAMES
ARE DISTORTED, USE THIS NEW IMAGE EXACTLY. 4, THE VARIANT BUTTON HAS ZERO
FUNCTIONALITY AND DOESN'T WORK AT ALL, JUST SILENTLY FAILS." Three masters were
attached. Every one is now the served chassis, rendered in the harness at
phone width and matched against the master before this was pushed.

## 1. Club identity card on the kingfish-v1 master

`src/components/club-buttons/ClubIdentityCard.tsx` and `.css` are rewritten as
a layered card, the way every game card is built: the 1566 x 672 master with
its dynamic words inpainted out is `public/assets/club-buttons/club/kingfish-v1/chassis.png`
(source kept beside it), and every live string is printed into a pixel zone
measured on the master (`CLUB_IDENTITY_ZONES`: alias, clubId, playerId,
playing, level, share), converted to percentages so a 320px phone and a 430px
one get the same picture. Sizes are cqw against the card.

- The alias is the headline (weight 800 solid silver with a bevel; never a
  clipped gradient, which rendered black on Dan's phone) and is fitted by
  measurement (`useFitText`, floor 0.3) so a long alias shrinks instead of
  clipping.
- The two ID lines are real buttons (copy on tap, 44px reach via the line
  box) whose "ID: n" text sits beside the painted house / person icons.
- The count is a live blue number beside the painted PLAYING NOW; the level
  is live white capitals in the painted blue plate; the referral copy frame
  top right is a transparent button with a 44px `::after` thumb target.
- The master has no club name and no logo, so `clubName` is spoken only
  (`<h2 class="club-identity__name sr-only">`), `logoUrl` / `logoFallback` /
  `shareIcon` are accepted and unused. Props are unchanged for callers.
- The old sizing helpers (`clubNameSizeCqw`, `fittedNameSizeCqw`,
  `fittedPlayingSizeCqw`) are retired; the card measures instead of guessing.
- In the paired mobile top row (`ClubHomeMobilePremium.css`) the pair now
  shares the CARD's ratio (`--lobby-paired-card-ratio: 1566 / 672`) instead
  of 2.4 / 1, so the chip crest is a circle, not an oval.

Tests moved with the layout in the same commit:
`tests/unit/lobbyTournamentBoardDesign.test.ts` (identity pins now guard the
master, the zone order, the measured alias, the blue count, the 44px share
band, no gradients, no breakpoints, no :hover),
`tests/unit/lobbyMobileControls.test.tsx` (alias printed into its zone and
fitted by measurement; name first and sr-only), and the CSS Beat E2E fixture
`tests/e2e/club-mobile-wallet-reach.spec.ts` (mirrors the new markup with the
component's inline zone styles; verified green locally in Chromium).

## 2. My Wallets on the my-wallets-v1 master

`src/pages/ClubHomeMobilePremium.css`: the 2172 x 724 master IS the trigger
(`public/assets/club-buttons/wallets/my-wallets-v1/chassis.png`), rail, octagon
bay, billfold and MY WALLETS all paint. Live: the balance count printed under
the title (x 900-1476, y 414-480 on the master, blue) and the chevron in the
right bay, which rotates when the list opens. The old CSS-drawn icon and
gradients are display:none under the paint. MY WALLETS stays in the DOM,
visually hidden, for the accessible name.

## 3. PLO on the spade-plo-premium-v1 master

New `src/components/lobby/game-cards/SpadePloCard.tsx` and `.css` on the
1177 x 1337 master (`public/assets/club-buttons/game-cards/plo/spade-plo-premium-v1/chassis.png`):
spade crest, header well (title, subtitle, status pill), four painted-label
bays with live values (GAME TYPE / STAKES / PLAYERS / BUY-IN, buy-in stacked
min over max via `LayeredBuyIn`), VIEW TABLE and JOIN TABLE plates, spade chip
at the foot. Registered as `spade-plo-premium-v1` and made the approved
default for the whole Omaha family (PLO, PLO5, PLO6, PLO8) in
`arenaGameCardRegistry.ts`; `LAYERED_RENDERERS` in `ArenaGameCard.tsx` maps it.
The previous shark four-bay skin stays registered as a fallback.
`tests/arena-game-card-system.test.ts` pins the new default.

## 4. The Variant menu, proven

Dan's screenshot was a pre-merge build (PR #2945 wired the menu), but "opens a
menu" is not something a grep proves, so
`tests/unit/lobbyVariantMenuWorks.test.tsx` renders `LobbyTable`, presses the
Variant heading on the phone sort bar and checks: the menu opens with All,
every game on the tab in canonical order, and Sort By Variant; pressing a game
reports the new selection (`onVariantsChange(['pineapple'])`), pressing it
again removes it, All clears and closes; Sort By Variant sorts and closes; and
the menu closes on a second press of the heading, on Escape and on an outside
tap. It also pins the page wiring (Hold'em and Omaha read and write the same
saved `games` filter as the Advanced Filters sheet).

One real defect found by that test and fixed in `LobbyTable.tsx`: the
outside-tap closer listened on `pointerdown` and treated the Variant heading
itself as "outside", so a press on the open heading closed the menu on
pointerdown and the click that followed re-opened it. The menu could never be
closed from where it was opened. The closer now ignores the heading
(`[aria-haspopup="menu"]`); the test fails without the fix.

## Gates

`tsc --noEmit -p tsconfig.app.json` clean; prettier clean; `check-ui-text` and
`check-title-case` OK; vitest: every `tests/unit/lobby*` file, the card
system, club buttons, premium machines, no-hover law, footer laws, law
registry (all green); Playwright `club-mobile-wallet-reach.spec.ts` green.
