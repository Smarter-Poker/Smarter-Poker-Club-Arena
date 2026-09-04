# The footer gets out of the way while you read

**Date:** 2026-09-04
**Branch:** `fix/footer-hides-while-you-read`
**Reported by:** Dan — "any other pages that you can 'scroll up to see more'
need this same disappearing footer functionality... check all the pages and sub
pages globally inside the world hub and for the club arena and implement this
everywhere its needed."

Follows `2026-09-04-footer-frame-background.md`, which fixed the artwork itself.

## What it does

`useHideFooterOnScroll` (new, `src/components/club/`) gives `ClubBottomNav`
Facebook's rule: travelling down the page drops the bar, travelling back up
brings it straight back. It is the deliberate twin of `useHideOnScroll` in the
World Hub's `BottomNavBar.jsx` — the two apps have to feel like one product, so
if the behaviour changes in one it changes in both.

**There is no route list, and none is needed:** a page that does not scroll
never fires a scroll event, so its footer never moves. `shouldShowClubFooter`
still decides which routes have a footer at all; this only governs what that
footer does once it exists.

## The parts that matter

- **"Real time instant change" is the requirement**, so there is no transition,
  no easing and no timer anywhere in this path. The transform lands on the
  animation frame following the scroll event, which is the frame the browser
  was going to paint anyway. Do not "smooth" it later — smooth is the thing Dan
  rejected.
- It listens on the **capture phase at the document**, not on `window`. Scroll
  events do not bubble, and several Club Arena pages scroll an inner panel
  rather than the document; a `window` listener would silently do nothing on
  every one of them. Each scroller's position is tracked separately, so
  switching between two panels cannot read as a jump.
- The 4px threshold is measured from **where the current run of travel in one
  direction began**, not from the previous event. A single flick flips it
  immediately; a couple of pixels of momentum bounce cannot rattle it open and
  shut.
- Always shown at the top of the page. Rubber-band overscroll past the end is
  not a reader travelling further down and hides nothing.
- Reset on every route change, so arriving at a page from a scrolled one never
  inherits a hidden bar.
- Revealed by keyboard focus (`onFocusCapture`): focus has no scroll direction
  to read, so tabbing into a parked footer would move focus off-screen.
- `.bottomNav` keeps `transform: none` in the stylesheet. The hidden state is
  an inline `translateY(100%)` — one axis, exactly its own height, so it parks
  below the viewport rather than shrinking or fading. Everything the position
  contract defends is untouched: still `position: fixed` at `bottom: 0`, still
  never a scroller, and `--bottom-nav-clearance` never moves, so no content
  reflows when the bar goes.

## Enforcement

Three new cases in `tests/components/ClubBottomNav.test.tsx`: it starts visible
and drops travelling down and returns travelling up; it is always present at
the top of the page; and it ignores the jitter inside a momentum scroll.

## Two things CI and the cache taught this branch

**`club-arena-footer-v2.webp`.** `public/sw-bus.js` keeps `MEDIA_CACHE`
deliberately unversioned across deploys and serves images
stale-while-revalidate, only really revalidating after six hours; the origin
also sends `max-age=2592000`. The transparent frame therefore shipped to a URL
every returning player already had cached opaque, and Dan kept seeing black
corners against a build that had replaced them. The stylesheet's own comment
names the pattern (`btn-hamburger-v4.png`): a new filename is the one thing the
cache cannot answer for.

**`scripts/ci/entry-chunk-baseline.json`.** `useHideFooterOnScroll` is imported
by `ClubBottomNav`, which is in the app shell, so it lands in the entry chunk
by construction. The guard is right to ask; the answer is that the footer is on
every page and its behaviour cannot be lazy. Baseline moved by one module and
about 1kB gzipped.
