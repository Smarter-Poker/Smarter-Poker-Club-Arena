# Complete Profile: a dead "Select Avatar" and a gate that stopped members who had already passed it

Dan, 2026-08-30: "THE CLUB ARENA MAY BE GLITCHING OR BLOCKING PLAY BECAUSE THE
'CHOOSE AVATAR' DOESN'T FUNCTION AND ALLOW YOU TO SELECT IT. IT JUST SILENTLY
FAILS, ALSO ITS ASKING USERS TO DO THIS WHO HAVE ALREADY BEEN IN THE CLUB, HAVE
POKER ALIAS PLUS AVATAR SELECTED ALREADY (WHICH SHOULDN'T HAPPEN)"

Two separate defects, and together they are a hard block: a modal you cannot
dismiss without choosing an avatar, and a button for choosing one that does
nothing.

## 1. The gallery opened every time. It opened UNDERNEATH.

`AvatarGallery` portals to `document.body` at `z-index: 9999`.
`CompleteProfileModal`'s overlay is a sibling in the same root stacking context
at `z-index: 10000`, filled `rgba(0, 0, 0, 0.85)` with an 8px backdrop blur
across the whole viewport. So every tap on "Select Avatar" mounted the gallery
behind an almost-opaque sheet — and `AvatarGallery` also sets
`document.body.style.overflow = 'hidden'` and traps Tab inside a dialog the
player cannot see. Nothing logged, nothing threw. It is the exact shape of
"silently fails".

Raising the gallery would have been the wrong end of it. `Toast` sits at 10000
deliberately so "Avatar Updated" lands on top of the gallery; lifting the gallery
past the toast would have traded a dead button for a silent save. Only one of
these two surfaces can be front-most, so the one not in use now steps off screen:
the profile modal unmounts its overlay while `showAvatarGallery` is true. The
alias the player already typed survives, because that state lives in
`CompleteProfileModal` itself and the component stays mounted.

## 2. The gate was reading a session stub, not the profile row.

`danimal5022` has `arena_avatar_url = /avatars/table/free_samurai@2x.webp` and
always did. Across the whole `profiles` table, 1023 of 1026 rows have an arena
avatar and none has a social photo without one — the data was never the problem.

`useCompleteProfile` decided from the Zustand user, and **four** paths seed that
store with a session stub before the profile row arrives:

| Path                                     | username           | avatar_url                     |
| ---------------------------------------- | ------------------ | ------------------------------ |
| `IdentityDNA.hydrateUserFromSession`     | `email.split('@')` | `metadata?.avatar_url ?? null` |
| `useAuthUser.rehydrate`                  | `email.split('@')` | `metadata?.avatar_url ?? null` |
| `AuthGuard.hydrateStoreFromSession`      | `email.split('@')` | `metadata?.avatar_url ?? null` |
| `AuthGuard.hydrateStoreFromLocalStorage` | JWT username       | `null`, hard-coded             |

Every one of them yields `avatar_url: null` for a player who has an avatar,
because the Arena avatar lives in `profiles.arena_avatar_url` (split out
2026-08-21) and a JWT does not carry it. The gate read that null as "never chose
an avatar" and threw up a blocking modal — on every cold load, and again on every
token refresh, since `hydrateUserFromSession` runs on `SIGNED_IN`,
`TOKEN_REFRESHED` and `USER_UPDATED` alike. It cleared itself once the profile
landed, which is why it presented as glitching rather than as a plain bug: a hard
gate flickering over a player who had already walked through it.

The gate now asks the database:

- one read of `profiles(username, arena_avatar_url)`, keyed on the account id;
- **a query that did not answer is not a missing profile** — an error or a
  dropped connection leaves the gate DOWN and allows a retry, rather than locking
  a paid-up member out of the tables over a network hiccup;
- decided ONCE per account id, so a token refresh cannot re-litigate it;
- `isReady` stays false until the answer is in, and `AppLayout` does not mount
  the modal until then, so there is no window in which it can flash.

The `profile_alias_configured` localStorage key is gone. It was written in two
places and read in one, where the value was computed and then never used in any
branch — it decided nothing.

## 3. A refused avatar write reported success.

`handleSave` discarded the return of `avatarService.setUserAvatar`. That function
**refuses rather than throws** (the library-only guard returns `false` for
anything that is not library art), so a refused write left the modal showing
"Welcome!", closing, and then re-appearing on the next load with no explanation —
the same gate, for the same reason, forever. It now surfaces the failure and
stays open.

## Pinned

`tests/unit/CompleteProfileGate.test.tsx`, 8 assertions. The stacking pin is
behavioural rather than a z-index compare: the two surfaces are asserted never to
be mounted together, which stays true whatever the numbers become. The gate pins
include the token-refresh rerender that caused the report.

## Not fixed here, worth its own decision

`profiles.tier` is `'Newcomer'` for all 1026 rows, and this modal computes
`isVip={user.vip_level !== 'bronze'}` — so `isVip` is **true for every player**
and the VIP avatar collection is currently open to everyone. That is an
entitlement question, not a bug fix, so it is raised rather than changed.
