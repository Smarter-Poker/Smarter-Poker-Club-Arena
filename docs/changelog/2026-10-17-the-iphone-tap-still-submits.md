# 2026-10-17 - ENTER ARENA works on an iPhone again

## What Dan reported

"THE LAST TWO PLAYERS TO SIGN UP WITH MY REFERRAL LINK HAVE BOTH STATED THAT
AFTER THEY GOT THE CODE VERIFIED THROUGH THE EMAIL, AND GOT TO THE PICK AVATAR /
ALIAS THAT IT TOOK AN EXTREMELY LONG TIME TO LOAD/FINISH."

## What the logs say

Both players (TomTomTamale, Dinodollars) arrived through
`/hub/club-arena/invite/a41434bb-...?ref=1` on iPhone Safari (iOS 18.7).

| | email verified | gate shown | avatar saved | ENTER ARENA write | through |
|---|---|---|---|---|---|
| Dinodollars | 00:44:15 | 00:44:17 | 00:45:41 | never | 00:49:36 after reloads |
| TomTomTamale | 13:56:24 | 13:56:25 | 13:57:09 | never | 14:30:25 after a reload |

Loading was fast (the gate was up within two seconds). Finishing never
happened: no profile write followed the avatar, and each player reloaded
until the gate re-read the row and found it complete.

## Cause

Since 2026-10-01 every SpadeConsole plate inside a pop-up carries `TapHaptic`,
an invisible `<input type="checkbox" switch>` over the plate's face: the only
haptic an iPhone browser can play. A click has ONE activation target, the
innermost element with activation behaviour, and that is the checkbox. React
`onClick` handlers still ran (the click bubbles), so most plates worked, but a
plate that relies on the button's own native action - ENTER ARENA is
`type="submit" form="complete-profile-form"` - never submitted. Desktop and CI
never render TapHaptic, so no test saw it. Reproduced on production with a
fresh account in an iPhone-emulated browser: the tap landed on the switch and
no request left the page for 60 seconds.

The same dead button existed on every submit plate in a pop-up:
CreateUnionModal, CreateTournamentModal and GameManagementPage.

## Fix

- `TapHaptic` finishes its host's native action: after the tap has
  dispatched, if the host is a submit/reset button, nobody called
  `preventDefault` and the form did not submit by itself, it calls
  `form.requestSubmit(host)` (or `form.reset()`). Exactly once, with the host
  as submitter and constraint validation intact.
- `CompleteProfileModal`: closes the moment the rows are written (no 500 ms
  pause); refuses a second submit in the same tick; no longer overwrites an
  alias the player typed whenever the store rewrites the user (choosing an
  avatar did); never offers a session stub (`email.split('@')[0]`) as the
  alias; checks availability with `_` matched literally (ILIKE wildcard).

## Pins

- `tests/the-iphone-tap-still-submits.law.test.tsx` runs the real modal with an
  iPhone user agent and taps the switch.
- `tests/components/TapHaptic.test.tsx` pins submit-once, no double submit,
  `preventDefault` honoured, and `type="button"` hosts untouched.

## Damage

None owed. Both players' avatars and aliases were saved, both are members of
SHARK CLUB under KingFish as their agent.
