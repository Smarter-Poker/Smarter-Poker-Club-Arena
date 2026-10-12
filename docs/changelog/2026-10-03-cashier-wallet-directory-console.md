# The Cashier Wallet Directory Is Painted

Date: 2026-10-03.

## Scope

The routed Cashier pages and dialogs were already on the approved
#ClubArenaConsole master through PR #5111. The Cashier card's desktop
right-click and mobile press-and-hold directory was the remaining gap: it was
still a rounded CSS popover even though it is part of the Cashier experience.

## Change

- The wallet directory now renders directly on the approved shark
  `SpadeConsole` master, including its painted close control and flat foot.
- Generic borders, rounded frames, shadows, filled active rows, the rounded
  Retry control, and the circular initial placeholder were removed.
- Club and union rows remain 44px keyboard targets separated by engraved rules.
  A real club logo is still shown when one exists; an absent logo now prints
  only the club name rather than inventing an icon.
- The desktop portal anchor is clamped to the viewport so an edge Cashier card
  cannot open a clipped directory. Mobile safe-area positioning remains intact.
- Both the card directory and the in-Cashier club switcher now use
  `compactChips`, so player-facing wallet figures never show decimals and
  values over 1,000 use the approved downward-rounded compact notation.

All existing behavior is preserved: right-click, 500ms hold, keyboard opening,
focus return, stale-account balance refusal, Retry, realtime invalidation, all
eligible club wallets, owner-only union wallets, and direct navigation to the
selected club or union Cashier.

## Regression Protection And Verification

The Cashier console law now owns this directory, requires its direct painted
console, rejects CSS-built chrome, requires compact chip formatting, and
refuses a placeholder icon. Component coverage also pins the compact balances
and desktop edge clamp.

Final local candidate evidence:

- 16 focused Cashier, console, popup, role, gesture and geometry suites: 365
  tests passed.
- TypeScript passed.
- UI copy, Title Case, painted text and navigation copy gates passed.
- Console inventory: 0 generic surfaces remaining.
- Production build passed.
- Real-component render review passed at 393px and 1280px for populated,
  loading and balance-error/Retry states.

Policy receipt used for this resumption: version 2.9, manifest
`a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
