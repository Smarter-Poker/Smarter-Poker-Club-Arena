# 2026-10-04 - Previous Hand is a full-screen popup

Dan asked for the tournament lobby to be a "full screen pop up", "same with
the 'previous hands' full screen pop up". Asked directly whether Previous
Hands should also become full screen, he answered "Yes, make it full screen".
This reverses his 2026-08-27 ruling (a 3/4 sheet with a backdrop above it).

`HandDetailModal.css` only; the component, its console and every control are
unchanged.

- Phone: the sheet is `100vw` by `100dvh` (was `75dvh` anchored to the
  bottom). The top strip still pays the safe-area inset, so the X stays
  reachable. Ways out: the X in the head, the Close plate, drag on the top
  strip, Escape.
- Desktop: the overlay is opaque and the column runs the full height at
  `min(560px, 100%)`, centred. The console sizes its type in `cqw`, so the
  column is capped rather than stretched across a monitor. Clicking the
  overlay beside it still closes.

Measured headless: 375x667 gives a 375x667 panel; 1440x900 gives 560x900.

`tests/unit/handHistorySheets.test.tsx`: the case that pinned `75dvh` now pins
the full-screen shape, in this commit. Hand History (the list drawer) is a
different surface and keeps its geometry.
