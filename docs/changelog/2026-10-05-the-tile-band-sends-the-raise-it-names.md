# The tile band sends the raise it names

2026-10-05. Launch audit, multi-table tile view. Client only.

## What was wrong

The tile-view action band (`src/pages/MultiTablePage.tsx`) sized its raises
inline, and two were wrong. Every `raise` the engine takes is a raise-TO.

- **All In** sent `raise` to `heroStack`, the chips behind. With anything
  already in front (a blind, an earlier bet) that is less than all-in, and when
  it fell under the minimum raise the engine refused it.
- **1/2 Pot** and **Pot** sent `toCall + (pot + 2 * toCall) * f`, capped at the
  stack behind. That is not a raise-to. From the small blind at 1/2 the half-pot
  button sent 3.5 against a minimum of 4, and was refused.

The single-table panel was never affected; it uses
`currentBet + (pot + toCall) * f`.

## What changed

- `src/utils/tileRaiseSizing.ts` holds the sizing: `tilePotRaiseTo` is the
  single-table formula clamped to the bounds the engine reported, and
  `tileAllInTo` is the stack behind plus the chips in front. A button with no
  legal raise behind it is not drawn, and All In is not drawn when the engine's
  ceiling is under the stack (pot-limit, fixed-limit).
- `TablePage` reports two more primitives to the tab while it is the hero's
  turn: `currentBet` and `allInTo`.

## Proof

`tests/unit/tileRaiseSizing.test.ts`, 17 cases, including the small-blind spot
above with the old number shown beside the new one, and a pin that the pot
button equals `ActionPanel.potSizedRaiseTo`. `tsc --noEmit` clean. The band was
not exercised against a live table in a browser here.
