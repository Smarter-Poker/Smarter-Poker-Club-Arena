# 2026-08-29 — The footer stays on the footer (and why it kept not staying)

Dan, from an iPhone: **"THE FOOTER IS COMING UP ON MOBILE AND ISN'T STAYING
LOCKED TO THE FOOTER."** Third report of the same thing (2026-08-24,
2026-08-25, today), and the third time it turned out to be the same single
declaration on a different element.

## The mechanism

```css
overflow-x: hidden;
```

CSS Overflow 3: when one axis is a non-visible value and the other is
`visible`, **the `visible` one computes to `auto`**. So that one line silently
makes the element a scroll container on _both_ axes. WebKit then resolves
`position: fixed` descendants against the nearest scrolling ancestor rather
than the viewport — so `ClubBottomNav` (`position: fixed; bottom: 0`, 74px) was
being pinned to the bottom of a 25,000px scroll box and riding up the page over
the game cards.

Chrome does not do this. That is the entire reason it kept surviving review:
it is invisible in a desktop browser, invisible in jsdom, and only appears on
the phone, after it ships.

Measured live on the club lobby at 375px before the fix:

| element      | declared    | computed `overflow-y`   |
| ------------ | ----------- | ----------------------- |
| `body`       | `x: hidden` | `auto`                  |
| `main`       | `x: hidden` | `auto`                  |
| `.club-home` | `x: clip`   | `visible` (fixed 08-25) |

## Why it was mobile-only

`AppLayout.module.css` sets `overflow-x: clip` on `.casinoStage`, and then the
`@media (max-width: 600px)` block later in the same file put `overflow-x:
hidden` back on the _same element_. Above 600px the rule never applied, so
desktop was always correct and the phone never was.

## The fix

`clip` is the one non-visible value the spec exempts from that promotion
(`visible` stays `visible` when its partner is `clip`), so the sideways
clipping these rules actually want is kept and the element stops being a
scrollport. `hidden` stays on the line before it as the fallback for anything
older than Safari 16 / Chrome 90 — the same pattern `.club-home` already used.

Applied to:

- `body`, in **both** sheets that style it (`design-system.css`,
  `club-engine.css`)
- `.main` in the `@media (max-width: 600px)` block of `AppLayout.module.css`
- `.pageContainer` in `StandardContentLayout.module.css` — shared by every
  StandardContentLayout page, so this one was breaking many pages at once
- 60 page-root rules under `src/pages/**`

Deliberately **not** applied to `.multi-table-page__lobby-tab`: that element
declares `overflow-y: auto` on purpose and is a genuine scroller.

## The law

`tests/footer-stays-on-the-footer.law.test.ts` fails if any rule under
`src/pages`, `src/styles` or `src/components/layouts` declares `overflow-x:
hidden` without pairing it with `clip`, unless the same rule also declares an
explicit `overflow-y` (a deliberate scroller). It found `.pageContainer` — the
one my own sweep had missed — on its first run.
