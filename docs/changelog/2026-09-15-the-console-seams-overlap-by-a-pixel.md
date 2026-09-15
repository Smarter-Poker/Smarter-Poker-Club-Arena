# 2026-09-15: the console seams overlap by a pixel, and three dead strings go

## The seam

Every `SpadeConsole` slice takes its height from an `aspect-ratio` against a
container width the browser rarely hands us whole. At 375px - the design width
this repo tests at - the head is `375 x 0.348 = 130.5px`. Two boxes that meet
on a fractional device row can both round away from it, so neither paints it:
a 1px black band straight across the console, cutting both side rails. That is
"CLEAN FRAMES ... nothing cut off at any edge" failing in one row of pixels.

It was found on the sign-in page during wave 7, and the page fixed itself by
anchoring the console to a whole-pixel top. Nothing about the defect was
particular to that page: it is arithmetic, and every surface in the kit was
one container width away from it.

The fix is in the kit. `.sc__body` carries the rails its neighbours also show,
so its box now extends one pixel into each of them and pays the negative
margin straight back as padding - the junction is painted with the right art
and no content moves:

```css
padding: 1px 10.5% calc(3cqw + 1px);
margin-top: -1px;
margin-bottom: -1px;
```

Measured in a real browser at 375px, head height 130.5: the head/body and
body/foot gaps go from `0` (boxes merely touching on a half-pixel) to `-1`
(overlapping), and the junction row's luminance goes from 82 to 88 on the left
rail and 15 to 27 on the right - the row was under-painted and is now painted.
Only rail pixels change; a screenshot diff of the whole card touches 13 pixels
on one row.

The sign-in page keeps its whole-pixel anchor: it also stops the console's own
top edge landing on a fraction, and its comment now points here.

## Three dead or lower-case strings

`metallic-popups.css` listed `.seat-buyin-confirm__panel` in its shell
selector. That class exists nowhere in `src/`, and a dead entry in that list
is worse than nothing: it is the list an agent reads to learn which surfaces
are still legacy shells. Removed.

`CashierModal` carried `className="cashier-dialog sc-dialog"`, and `sc-dialog`
has no rule in any stylesheet. Removed.

`src/lib/pushClient.ts` held nine player-facing sentences in sentence case -
"Notifications are blocked for this site...", "This browser does not support
push notifications." and so on. They are thrown as `Error`s rather than
written into JSX, which is why all four copy gates were green over them for as
long as they existed. `PushEnableBanner` title-cases what it prints, but the
source is what every other caller gets, so the source is fixed (Dan
2026-09-14: "THE FIRST LETTER OF EVERY WORD MUST ALWAYS BE CAPITALIZED").
