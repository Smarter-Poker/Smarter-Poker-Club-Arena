# A tournament chip is whole, and the number row has one owner (2026-10-06)

Two defects at the table's bet sizing, from the launch audit of 2026-10-05.

## A tournament chip is whole

The sizing panel's unit was 0.01 for every chip table, tournaments included,
and the multiplier presets are exact: facing a raise to 75, 2.5X is 187.5.
`HandController.performAction` refused a non-integer wager only for Diamonds.
Everything else in the controller already treats a tournament chip as one unit
(pot splits, the ante unit, the odd-chip rule), so a half chip, once in, was
pushed to one seat at every split. Production at the time of the fix: 800 live
tournament seats, none fractional, so no stack needs correcting.

- `TablePage`: the panel's unit is 1 on a tournament table.
- `HandController.performAction`: a non-integer wager is refused on a
  tournament table exactly as on a Diamond table. Cash chip tables still move
  in cents.

## The number row has one owner

1-4 size a bet while the sizing panel is open and switch tables otherwise.
Both listeners are on `window`, and the switcher's ran whatever the table's
did: with two tables open, pressing 2 for half pot also flipped to table two
and left the raise unconfirmed. Which listener runs first depends on mount
order, so `defaultPrevented` could not settle it.

`useTableKeyboard` now answers `tableSizingOwnsNumberRow()` from the same
options and the same conditions as the branch that takes the key, and
`MultiTablePage` asks before it switches. The switch is still only ever a
keypress the player made.

## Proof

`server/src/engine/ATournamentChipIsWhole.test.ts`,
`tests/unit/theNumberRowHasOneOwner.test.tsx`.
