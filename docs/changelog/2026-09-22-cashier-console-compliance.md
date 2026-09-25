# The Cashier Is Rendered On The Console

Date: 2026-09-22. Branch `fix/cashier-console-compliance-current`, replacing the
stale PR #4526 (`feat/cashier-console-compliance`, cut 2026-09-13, 328 commits
behind main and conflicting).

## What Changed

Every Cashier page and every Cashier-owned dialog now prints on the approved
#ClubArenaConsole master through `SpadeConsole`, directly:

- Trade Cashier (`/clubs/:clubId/cashier`): the retired `cashier-vault-hero`
  picture is gone; the page is one continuous console, and its Transaction
  Receipt, Request Chips, Send Out / Send Ticket and Claim Back dialogs are each
  a console of their own. Claim Back has one action, so it closes on the flat
  cap with a lit word control; the other three fill both painted plates.
- Classic Cashier (`/clubs/:clubId/cashier-classic`) and its no-club state:
  the page shell is the console; the approved Dynamic Wallet masters above it
  stay exactly where they were, never nested. The high-value confirm dialog is
  a console with both plates.
- Club Bank Cashier, Player Wallet details, Cashout Request, Chip Mint, the
  in-table Cashier and the Union Wallet Cashier: the direct `SpadeConsole`
  implementations main re-landed in #4696 are kept, and audited to this
  standard.
- Cashier club/union switcher: flat, engraved rules, 44px items, no logo box.

The Sept 13 wrapper (`CashierConsoleSurface`) is retired. One console API.

## Defects Fixed On The Way

- Four Trade dialogs and the Classic confirm dialog rendered without the
  legacy-flattening class, so the old bordered, rounded, gradient chassis
  painted on the glass (receipt amount, receipt facts, target lists, action
  buttons, `.reqBtnGo`'s `!important` gradient). The rules are deleted, not
  suppressed.
- Browser number spinners and generic input frames on seven chip fields.
- CSS avatar and logo fallback boxes (gradient squares) on recipient rows and
  the entity switcher; the `◆` icon box, `▾` chevrons, `✓` step ticks.
- A card wrapper and a duplicate `Cashier` heading inside the no-club glass,
  and a bare page title printing outside the frame.
- `.cbc-totals` tiles and the `.uwm-notice` / tag boxes inside the wallet
  consoles.
- Painted head zones printed raw locale figures; they print `compactChips()`.
- Chip figures on the glass printed `12,500.00` (Dan: never decimals on a
  forward-facing page). A whole balance prints whole; a balance that really
  holds cents keeps them, because a money desk never misstates a ledger. The
  three tests that pinned `.00` on whole figures were updated in this change.
- A commission rate printed `33%` for 32.5% (rates keep one decimal).
- Chip Mint showed `0` diamonds when the diamond read FAILED; it shows
  `Unavailable` and keeps the presets disabled.
- A cashout status from a row reached the screen lower-case
  (`Already approved`); dynamic copy goes through `titleCase()`.
- Off-schema blues (`#36a9ff`, `#8ad2ff`, `#5bb8ff`) replaced by `#45adff`.
- `:where(button)` overrides now exclude `.sc-plate`, so plate labels keep
  fitting their painted face whatever the import order.
- The Cashier prints on the console's default crest (the spade). The club,
  diamond and crown crests Dan called cheap on 2026-09-13 are not used here.

## Preserved (Verified By The Existing Suites)

Money conservation, authorization and role scoping, replay/idempotency keys,
club and union wallet routing, the desktop right-click / mobile press-and-hold /
keyboard Cashier launcher (`ClubQuickLinkTile`, untouched), first-visible-tab
default, club switching with stale-response rejection, realtime subscriptions,
offline mutation locking and `Reconcile Now`, batch recovery, immutable
copyable receipts, honest `Unavailable` (never `0`) balances, focus traps and
Escape guards, and every test-pinned literal.

## Law

`tests/cashier-club-arena-console.law.test.ts` (registered in
`docs/laws.d/cashier-club-arena-console.md`) now reads every console tag: it
requires a direct `SpadeConsole` import, the exact console count per surface,
no wrapper, no vault picture, no close glyph, no rejected crest, the flattening
class on every page console, both plates or none, spinner suppression wherever a
number is taken, zero painted radii and gradients in every Cashier stylesheet
(the three legacy global rules other components still borrow from
`CashoutRequestModal.css` are pinned by exact count), and `compactChips` in the
painted head zones.

## Known, Deferred (Not Cashier-Owned)

- `DepositWithdrawModal` (Player Wallet page) and `AgentCashoutPanel` (Agent
  Management page) are still generic. They belong to a Player Wallet and an
  Agent batch.
- `CashoutReceiptChecks` renders unstyled markup outside the Cashout console.
- The Dynamic Wallet plate on the Classic Cashier prints `12,500.00` from the
  shared `ClubWalletArtwork`; that master is used across the arena and is a
  kit change.
- The Trade page's readiness copy (`Balances synchronized`) is pinned by the
  production certification specs and stays as written.

## Verification

Recorded in the task checkpoint: console gates, scanner, the console law
suites, the Cashier / wallet / union / ledger regression family, TypeScript,
changed-file lint and format, fresh 393 / 375 / 1280 renders, production build
with clean provenance, protected merge, `publish-club-arena.yml`, both
build-info endpoints and the authenticated production Cashier E2E.
