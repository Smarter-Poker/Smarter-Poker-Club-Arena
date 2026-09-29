# Daily Challenges Certification Follow-Up

The final certification of the Daily Challenges programme ran two independent
reviews against the Phase 4 build (#5065) and the authenticated post-deploy
suites against production `deec04a67`. The reviews found no crash, and the
accessibility certification found a regression #5065 introduced. This change
fixes the regression and the five things the reviews found not yet true.

## Shipped

**The page title grows at 200% text again.** #5065 capped every hero title
size at `18cqi` so that CHALLENGES would not split mid-word at 200% text. The
cap also stopped the title growing: at 320px it rose only 1.12x, where WCAG
1.4.4 and `daily-challenges-accessibility-responsive.spec.ts` require at least
1.5x, and that certification failed on production `deec04a67`. The five title
sizes are back to their values before #5065 and the copy column is no longer
a size container. At 200% text on a phone CHALLENGES cannot fit the column at a size
that honours the requirement, so `overflow-wrap` breaks it where the column
ends, as before #5065. Nothing gentler is possible without harming the
heading: browsers do not hyphenate capitalised words, and a `<wbr>` makes
Chrome's accessibility tree name the heading "Month ly Chal lenges"
(measured).

**The completion toast never carries a player off a live table.** #5065 made
the toast a door to Daily Challenges. A mission completes the moment a hand
ends, and on a phone the toast is a full-width bar over the table's action
buttons, so a tap meant for the next decision could open Daily Challenges
mid-hand. `ChallengeToastListener` now attaches no tap action while the
player is on `/table/...`, and re-checks at the tap, so a toast that arrived
in the lobby does nothing if the player has since sat down.

**The completion toast finds the club in the path too.** It read only
`?club=`, but a club's own pages carry the club in the path
(`/clubs/deep-stack-society/lobby`), so a tap there opened plain
`/challenges` and Back To Arena went Home. The listener now reads
`clubIdFromPath(location.pathname)` first, then `?club=`.

**The wallet door carries only the club the URL names.** #5065 fell back to
the store's remembered club, a UUID, when the wallet URL named none. The
Rewards rail on the same page stamps only the URL's club, so the two doors to
the same page disagreed, and the door put a UUID in the address bar and
scoped Daily Challenges to a club the player had not come from. The door now
uses `readClubContextParam(location.search)` alone.

**A failed Realtime sign-in retries on the next event.** When
`supabase.realtime.setAuth()` fails before a private join (no session yet, a
refresh in flight, the network gone), there is no channel, so the MasterBus
health monitor, which recovers closed or errored channels, has nothing to
recover, and the surface never heard from its channel again. With the
15-second reconciler gone, a Daily Challenges page in that state caught up
only when the tab resumed. `useMasterBusBroadcastChannel` now arms one
event-driven retry: the next `TOKEN_REFRESHED` or `SIGNED_IN`, or the browser
coming back online, starts the subscription once more. An attempt that gets
past authentication disarms it, unmounting removes it, and no timer is
involved. The completion toast's channel shares the hook and gains the same
repair.

**The route shell matches the page it hands over to.** Rendered through the
harness at 280px to 1440px, four things differed:

- Frame width. The page widens StandardContentLayout's 680px reading column
  to 1240px; the shell did not, so above 768px (a desktop, a landscape phone)
  its hero jumped from 680px to the page's width at the handover. The shell
  now paints the same 1240px frame.
- Title size. The shell's title had its own sizes: larger than the page's on
  phones (41.6px against 37.6px at 320px), smaller on a tablet or desktop
  (86.4px against 96px at 1440px), so it changed size at the handover, and at
  a 280px phone CHALLENGES ran past its column. It now uses the size, weight
  and tracking the page's cascade resolves to, read from the page's own
  stylesheets by its test.
- 200% text. The shell's title allowed no break, so at 200% on a 393px phone
  CHALLENGES (419px at 78.4px) ran past its 281px column and the hero clipped
  it. It now grows with the text size and wraps inside the column, the page's
  own rule.
- The cycle instrument. On a phone the copy now starts below the badge
  (20px down, 58px tall), so text that grows makes the hero taller instead of
  running under it. At normal text the copy sits at the foot of the 430px
  hero and nothing moves.

## Corrections

- `src/pages/ClubDetailPage.tsx` is routed nowhere. It is on the unreachable
  list in `tests/every-file-under-src-is-reachable.law.test.ts`, so the Club
  Detail card fixed in #5065 is not a door any player can see, and no live
  club page has a Daily Challenges door. The fix stays so the card is correct
  if the page is ever routed again; its test now says so.
- The `sign-in` icon variant served only the signed-out panel Phase 3
  removed, and nothing used it. It is deleted.
- #5039 shipped without a changelog;
  `docs/changelog/2026-09-21-daily-challenges-event-driven-catch-up.md` is it.

## Pins

- `tests/daily-challenge-entry-parity.test.ts`: no container unit or size
  container on any hero title in any partial, the wallet rule, the rail's
  stamping, the toast's club sources and table guard, and the shell's frame
  width and title size (both read from the page's cascade), wrapping title
  and instrument clearance.
- `tests/unit/ChallengeToastListener.test.tsx`: path club, no action at a
  table, a tap after sitting down stays on the table.
- `tests/hooks/useMasterBusBroadcastChannel.test.tsx`: retry on online, on a
  token refresh, a failed retry re-arms once without looping, unmount cleans
  up.
- `tests/components/challenges-instrument-icons.test.tsx`: 18 variants.
- `tests/e2e/daily-challenges-accessibility-responsive.spec.ts` is unchanged
  and is the gate the title fix answers to.

## Deliberately not changed

- The lobby label is at the size the art's plate allows (about 5.4px at a
  393px phone, one line). A larger printed name needs a taller plate in the
  approved art, which is an art change.
- The shared Toast has no keyboard or screen reader affordance for its tap
  action. Every door it offers also exists as a real link or button.
- `PageErrorBoundary` does not reset on navigation. That is shared behaviour
  across every page and is out of this programme's scope.
