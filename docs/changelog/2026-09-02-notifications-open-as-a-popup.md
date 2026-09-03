# Notifications open as a full-screen popup, not as a page

**Date:** 2026-09-02
**Repo:** club-arena (a matching change lands in Smarter-Poker-World-Hub)
**Branch:** `fix/notifications-fullscreen-overlay`

## What Dan asked for

Verbatim, with a screenshot of `smarter.poker/hub/club-arena/notifications`:

> "WHEN YOU CLICK ON NOTIFICATIONS, IT SHOULDN'T OPEN TO ITS OWN PAGE, IT SHOULD
> CREATE A 'FULL SCREEN POP UP' SO YOU STAY ON THE PAGE YOU WERE ON, AND NOT
> REDIRECT TO A WHOLE PAGE FOR NOTIFICATIONS. YOU SHOULD BE ABLE TO 'X' OFF THE
> NOTIFICATIONS POP UP AND STAY ON THE SAME PAGE YOU WERE ON STILL. THIS SHOULD
> WORK LIKE THIS INSIDE THE WORLD HUB, CLUB ARENA AND CLUB COMMANDER PAGES.
> MAKE THESE CORRECTIONS GLOBALLY NOW PLEASE."

## What was actually wrong — it was half-built, which reads as unbuilt

The popup already existed **in the World Hub**. `UniversalHeader`'s bell has
called `openOverlay('notifications')` for months, `FullScreenPageOverlay` had
escape-to-close and a scroll lock, and `pages/hub/notifications.js` already
detected `window.self !== window.top` and hid its own header and hamburger when
framed.

It still reached Dan as a bug, because the open flag was a `useState` **inside
one header component**. Every other door in the estate kept navigating:

| Door                                     | Before                                            |
| ---------------------------------------- | ------------------------------------------------- |
| World Hub header bell                    | popup (already correct)                           |
| World Hub bottom nav "Alerts"            | `<Link href="/hub/notifications">` — full page    |
| World Hub hamburger (4 entries, 2 menus) | full page                                         |
| World Hub `/hub/pages` footer "Alerts"   | full page                                         |
| Club Arena header bell                   | `navigate('/notifications')` — full page          |
| Club Arena hamburger                     | full page                                         |
| Club Arena account rail                  | full page                                         |
| Club Commander profile menu              | full page, **to an endpoint that does not exist** |

So "notifications" meant two different things in one app depending on which
control you touched — and the bottom nav, which is what most players actually
reach for on a phone, was on the wrong side of the split. Nobody had reverted
anything; the behaviour simply never spread past the control it was written on.

## Club Arena: what changed

Club Arena had no popup at all, and it may not have one built the World Hub's
way: **CLAUDE.md section 1.3 forbids iframe code here**, and this very route was
rewritten away from `<iframe src="/hub/notifications">` on 2026-08-27 because
framing it booted a second application — second document, second hydration,
second Supabase client, second auth read — before the feed request could start.
So the popup renders the list natively.

- **`src/components/notifications/NotificationsSurface.tsx` (new).** The body of
  `NotificationsPage` moved here verbatim: same markup, same styling, same
  endpoints, same server-resolved destinations. It gained two props —
  `variant` ('page' owns the document title; 'overlay' does not, because a popup
  that renames the tab lies about where you are) and `onRequestClose` (called
  before the surface navigates anywhere, so the destination is never delivered
  underneath an open popup).
- **`src/components/notifications/NotificationsOverlay.tsx` + `.css` (new).**
  Portal to `document.body`, scroll lock that **restores** the previous value
  rather than blanking it, escape / backdrop / X to close, focus trap with focus
  returned to the bell. Opens with no navigation and no history entry, so the
  page underneath keeps its scroll position, sockets and in-flight state.
- **`src/stores/useNotificationsOverlayStore.ts` (new).** One open flag, so a
  future door cannot invent its own — which is the whole failure above.
- **Mounted once in `AppLayout`**, not in `GlobalHeader`. The header is hidden on
  table and tournament play pages, and a player sitting at a table is exactly
  who needs to read a seat call without leaving the hand.
- **`NotificationsPage.tsx`** is now a thin route wrapper around the same
  surface. **The route stays** — push payloads, emails, bookmarks, cmd-click on
  the bell, `everyRouteIsReachableLaw` and `e2e-page-load-audit` all need an
  address. A page that redirected into the popup would be a dead link to every
  one of them.
- **Triggers rewired:** `GlobalHeader` bell, `HamburgerMenu` (intercepted in the
  shared `handleNavigate`, so any present or future entry pointing at
  `/notifications` gets the popup), `ArenaSectionRail`, and the unmounted-but-
  exported `components/common/NotificationBell`. Every one stays an anchor, and
  every one checks the modifier keys first, so cmd/ctrl/shift/middle-click still
  opens the route in a new tab.
- **`ChunkPreloader`** now warms the overlay chunk. Dan, 2026-08-27: "IT SHOULD
  INSTANTLY OPEN AND DISPLAY WHEN CLICKED." Without this the first bell tap of a
  session would pay a lazy-chunk fetch.

## One bug found and fixed on the way

The surface subscribes to a realtime channel keyed `ca-notif-page:<user>`.
Nothing stops a player already on `/notifications` from tapping the bell, which
mounts the overlay **on top of** the page — two instances, both wanting that one
channel name, with the loser silently stopping receipt of inserts. The channel
name now carries the variant.

## The law

`tests/notifications-open-as-a-popup.law.test.ts`, registered in `docs/LAWS.md`.

The failure it guards is not "somebody puts it back". It is "somebody adds the
next notifications trigger and wires it the way every existing example looked
until today". Each pin is a door that was, in fact, navigating this morning. It
also pins the things that must NOT change: the route still renders the surface
directly, and neither the overlay nor the surface may contain an `<iframe>`.

## Verification

- `tsc --noEmit` clean.
- `tests/components/GlobalHeader.test.tsx`, `tests/unit/everyRouteIsReachableLaw.test.ts`,
  `tests/config/clubArenaInformationArchitecture.test.ts`,
  `tests/unit/headerBadgeAcknowledgement.test.ts`, `tests/unit/GlobalHeaderNav.test.ts`
  — 61 tests, all passing. The GlobalHeader spec pins the bell as `role="link"`
  named "Notifications"; keeping it an anchor is what preserves that as well as
  the new-tab behaviour.
- `tests/law-registry.law.test.ts` passing with the new row.

## Follow-up raised, not silently fixed

`pages/hub/commander/notifications/index.js` in the World Hub reads
`/api/commander/notifications/my`, `/[id]` and `/mark-all-read`, and
`pages/api/commander/` in that repo contains only `home-games/` and
`tournaments/`. Those three endpoints do not exist, so that page has been
rendering a permanent empty state. Commander's Notifications entry now opens the
canonical feed instead (Dan, 2026-08-25: "we need ONE DISPLAY"), which fixes the
dead surface as well as the popup. The Commander page and its missing API are
left in place for a separate decision rather than deleted here.
