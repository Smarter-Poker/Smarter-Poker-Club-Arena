# A money dialog owns the keyboard

2026-10-05. Launch audit, table client. Client only.

## What was wrong

`useTableKeyboard` ignores the action keys (F/Q fold, C/W/Space call or check,
R/E raise, A all in) while `isModalOpen` is true. The expression `TablePage`
passed for it named eight dialogs and left out the cashier, the Diamond wallet,
the leave confirmation, the cash and tournament rebuy prompts and the
post-or-wait dialog. With any of those open on the hero's turn, a keypress
meant for the dialog acted on the hand behind it.

## What changed

`src/pages/TablePage.tsx`: `isModalOpen` now also includes `showCashier`,
`showDiamondWallet`, `showLeaveConfirm`, `bustRebuyOpen`, `showRebuyModal` and
`postOrWaitOpen`. Nothing else about the hotkeys changes.

## Proof

`tests/unit/aMoneyDialogOwnsTheKeyboard.test.ts` pins that the hook gates the
action keys on the flag and that the flag names all fourteen dialogs. The six
new cases fail on the previous source. `tsc --noEmit` clean. Not exercised in a
browser here.
