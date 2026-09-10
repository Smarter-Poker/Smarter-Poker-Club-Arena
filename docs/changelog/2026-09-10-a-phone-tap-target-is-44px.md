# A phone tap target is 44px (audit CL-31, CL-33)

**Branch:** `fix/mobile-fit-tap-targets`
**Law:** `tests/a-phone-tap-target-is-44px.law.test.ts`

## What was wrong

- **CL-31** `src/components/club/GameCreationActions.module.css`: the
  `.compact` variant set the create-cash-game / create-tournament buttons to
  `min-height: 30px`, and the 760px breakpoint re-flowed the row to two
  columns without restoring height. The union and game-management screens
  render that row as their only route to creating a game on a phone.
- **CL-33** `src/components/lobby/GameLobbyPanel.css`: `.glp__close` was
  30x30 and the 640px breakpoint only widened the sheet, leaving a 30px
  dismiss control as the only way off the lobby game panel.

## What changed

- The 760px block in `GameCreationActions.module.css` now sets
  `min-height: 44px` on `.actions button, .compact button`, after the compact
  rule so it wins the tie. Desktop is untouched.
- `.glp__close` is 44x44 at every width. The header grows by 14px; nothing
  else in the panel depends on its height.

## What was NOT changed here, and why

- **CL-30** `src/components/social/FriendsList.css` and **CL-32**
  `src/components/players/PlayerNotes.css` belong to components with zero
  importers (`FriendsList.tsx` is exported only by a barrel nothing imports;
  `PlayerNotes.tsx` is not even in its directory's barrel; the at-table notes
  panel is `gameplay/PlayerNotesPanel`). A phone cannot reach either. Both
  are deleted on the dead-code branch rather than restyled.

## Verification

- `npx vitest run tests/a-phone-tap-target-is-44px.law.test.ts tests/unit/premiumTournamentConsoleContract.test.ts tests/law-registry.law.test.ts`: green.
