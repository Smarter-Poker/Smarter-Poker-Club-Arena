# 2026-08-27 — the notifications page was booting a second application

Dan, with a screenshot of the page: "NOTIFICATIONS PAGE SHOULD NOT TAKE SO LONG
TO LOAD, IT SHOULD INSTANTLY OPEN AND DISPLAY WHEN CLICKED LIKE IT DOES ON ANY
OTHER PLATFORM... AND IT NEEDS TO BE RAISED UP TO THE TOP TO BE ATTACHED TO THE
GLOBAL HEADER."

Two complaints, two separate causes. Both were structural rather than slow.

## Why it was slow

`src/pages/NotificationsPage.tsx` rendered an
`<iframe src="/hub/notifications?embed=ca">`. Tapping the bell therefore booted
a **second application** on top of the warm one: a fresh HTML document, the
Next.js runtime, `_app`, that page's chunk, hydration, a second Supabase
client, a second auth read, and only then the feed request.

Every one of those steps ran serially, and Club Arena — already loaded, already
authenticated, already holding a Supabase client — could not contribute a single
one of them. The `.ca-notif-embed__loader` spinner covered the whole chain,
because nothing could paint until the last step finished. No amount of tuning
inside the frame could have removed that; the cost was the frame.

It also violated CLAUDE.md section 1.3, which forbids iframe code in this repo
for exactly this reason.

The embed had been introduced deliberately, and for a good reason: Dan on
2026-08-25 asked for "ONE DISPLAY" after discovering that Club Arena's own copy
of the list read the `metadata` column while nearly every producer writes
`data`, so 1219 `waitlist_seat_open` rows resolved to no destination, marked
themselves read, and did nothing. The fix for that was correct. Embedding was
the wrong way to deliver it.

## What replaces it

The list renders natively in this SPA. First paint comes from the
`sp-notif-cache` localStorage entry, read **synchronously in the `useState`
initializer** so rows exist on frame one rather than after an effect — this is
a Vite SPA with no SSR, so there is no hydration mismatch to guard against.
That is the same cache key the World Hub page writes, and we are same-origin
with it, so the two surfaces warm each other's first paint. The network refresh
runs behind the already-painted list and reconciles.

**"One display" survives where it actually mattered.** The 2026-08-25 bug was
two routing implementations disagreeing, not two stylesheets. The new page
contains no routing rules at all: `/api/notifications/feed` runs the one
canonical resolver server-side (World Hub `src/lib/notificationRoute.js`) and
returns `n.link` already resolved; this page renders it and follows it. Same
feed, same resolver, same read/dismiss endpoints as the hub page and as
`NotificationDropdown`. Only the markup is local — which is the part that has to
be local for the route to be fast.

Realtime `INSERT` rows are the one case the resolver has not seen. Rather than
re-deriving a route on the client — the precise mistake that killed those 1219
rows — the new row is prepended for visibility and a refresh pulls in the
resolved version.

## Why there was a black band under the header

`AppLayout.module.css` `.main` reserved space for the global header:
`calc(63px + var(--space-8))` on desktop, `calc(55px + var(--space-4))` on
tablet. `GlobalHeader` is `position: sticky`, which stays **in the flow** and is
therefore already accounted for by normal layout. The reservation is a leftover
from when the header was `position: fixed`, and it put a header's worth of empty
space under the header on every Club Arena page above 600px.

The 600px block had already been corrected for this on 2026-08-24 ("THE CLUB
LOGO AND WALLET SHOULD BE RAISED UP SO IT IS ONE PIXEL UNDER THE TICKER").
Tablet and desktop were missed then, and are corrected now. Notifications
additionally opts into a new `.mainFlush` modifier — no gutter, no max-width, a
flex column — so the list runs edge to edge and sits flush against the header's
bottom border.

`.ca-notif__bar` is deliberately **not** sticky: `GlobalHeader` is itself sticky
at `top: 0` with `z-index: 130`, so a second sticky bar at `top: 0` pins
underneath it and is covered.

## Hostile state

- Cache missing, unparseable, or written by a browser in private mode — every
  read is in a `try`/`catch` returning `[]`, and the skeleton renders.
- Cache older than 5 minutes — discarded, same as the hub page.
- Cache holding rows deleted elsewhere — the background refresh replaces the
  whole list, and every local mutation rewrites the cache.
- Feed API down or unauthenticated — whatever is already painted stays. A stale
  list beats a blank one.
- Delete rejected by the server — re-sync from the feed rather than inventing a
  rollback, so there is never a second opinion about what the list contains.

## Verified

- `npx tsc --noEmit` clean.
- `npx vitest run tests/` — 458 files, 7301 tests, all passing.
- `NODE_ENV=production npm run build` clean.
- PR #1436 merged as `49e5701`; World Hub sync `310f5e22`.
- Production `/api/health` served `310f5e22`, and the live chunk
  `NotificationsPage-DwjFCQA4-v6.js` fetched from `smarter.poker` contains
  `ca-notif__row` / `ca-notif__tap` / `sp-notif-cache` and **zero** occurrences
  of `iframe` or `ca-notif-embed`. The previously deployed chunk contained four
  `ca-notif-embed` references and one `iframe`, which is the baseline this is
  measured against.
