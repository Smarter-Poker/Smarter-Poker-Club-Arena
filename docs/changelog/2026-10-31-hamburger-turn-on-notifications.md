# Turn On Notifications is back in the hamburger menu (2026-10-31)

Dan: "THE TURN ON NOTIFICATIONS IS GONE FROM THE HAMBURGER MENU... THAT
PROBABLY NEEDS TO BE ADDED BACK IN GLOBALLY."

The hamburger menu shows a full-width **Turn On Notifications** quick action
(the same `quickAction quickActionFull` style as Change Avatar) for a
signed-in player whose device is not receiving push. `src/lib/pushMenuState.ts`
decides the row from the same `pushClient` helpers as the Notifications page's
`PushEnableBanner`, and the menu re-reads it each time it opens:

| State     | Device                                                          | Tap                                                                     |
| --------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ask`     | push supported, no live subscription (an opt-out still gets it) | `enablePush()` inside the tap, then a Title Case toast                  |
| `install` | iPhone or iPad in a plain Safari tab                            | opens `/notifications`, whose banner gives the Add To Home Screen steps |
| `blocked` | permission denied                                               | opens `/notifications`, whose banner gives the unblock steps            |
| hidden    | already enrolled and allowed, or a browser with no push at all  | -                                                                       |

World Hub carries the same row and the same states (`src/lib/pushMenuState.mjs`
there), so the entry exists everywhere the player can open a menu.

Pinned by `tests/unit/hamburgerTurnOnNotifications.test.ts`.
