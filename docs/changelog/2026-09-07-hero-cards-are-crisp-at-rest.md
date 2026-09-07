# 2026-09-07 - Hero cards are crisp at rest

**Dan, from an iPad, with two screenshots:** "THERE IS A BUG ON MOBILE THAT IS
MAKING THE CARDS 'BLURRY' OR 'NOT CLEAR' EVERY SO OFTEN."

## What the screenshots show

Both frames are the hero's own hole cards on a coarse-pointer viewport
(iPad portrait, 751px wide, so inside the `max-width: 768px` mobile block).
In one the hero holds A6 on a completed board, in the other T7 preflop. In
both the hero's two cards are a soft, washed-out upscale - edges bleeding,
whites reading grey - while the six board cards in the same frame, drawn from
the same `cards/4color/*.webp` files, are pin-sharp. The files are 360x504
(checked against production: `spades_a.webp` is 4,596 bytes, 360x504), which
is more than twice the hero card's device pixels on that iPad, so the asset
was not the problem. Only the hero's card was blurry, only on a touch
viewport, and not on every hand.

## The cause

Two declarations kept the hero card on its own compositor layer for the
whole hand:

1. `src/pages/TablePage.css`, the mobile "GPU compositing hints" block
   (`@media (max-width: 768px) and (pointer: coarse)`, 2026-03-17):
   `.seat__cards--hero .seat__card { will-change: transform; }`.
2. `src/components/table/SeatSlot.css`, on the same card (2026-03-10):
   `transform-style: preserve-3d;`.

The card element is mounted fresh on every deal, and the same rule starts it
on `heroCardDeal` - opacity 0, `scale(0.94)`, 0.26s. WebKit rasterises a
promoted layer's backing store at the scale it sees when the layer is
committed, and a layer that STAYS promoted is not repainted merely because
its animation finished. So which frame of the deal the compositor happened to
commit the layer in decided whether the card was sharp or a 0.94-scale (or
smaller, with page scale) raster stretched to size for the rest of the hand.
That is "every so often". Desktop was never affected because the
`will-change` was mobile-only, and villain cards were never affected because
the rule named the hero row alone.

`CardImage.css` has carried the same diagnosis since 2026-08-21, when
`translateZ(0)` and `backface-visibility` were removed from the card
`<img>`: forcing a card onto its own compositor layer "resamples and softens
the very edges". That fix took the promotion off the image and left it on the
image's parent.

`transform-style: preserve-3d` had no 3D content to preserve. The face is a
flat image; the squeeze box carries `perspective()` inside its own transform;
the showdown flip rotates the card element itself. It was a compositing
trigger and nothing else.

## The fix

Both declarations removed. The hero card animates for 0.26s on the deal and
0.38s on a fold, and the compositor promotes it for exactly those windows on
its own, as it does for every accelerated animation, then hands it back to
the seat's backing store, painted at device resolution. The transient rules
(`.seat__cards--dealing .seat__card`, `.seat__cards--folding .seat__card`,
the squeeze's `[data-rs-animating='on']`) keep their scoped `will-change`;
they are removed with the class when the animation ends, which is the MDN
"switch will-change on and off ... before and after the change" pattern the
2026-09-05 mobile pass already adopted for the board and the squeeze. That
pass left the hero card "deliberately unstudied". It is studied now.

## The law

`tests/hero-cards-are-crisp-at-rest.law.test.ts` (registered in
`docs/laws.d/`): no stylesheet under `src/` may put `will-change`,
`transform-style: preserve-3d`, `translateZ`/`translate3d` or
`backface-visibility` on a selector that matches the hero card outside a
transient state (`--dealing`, `--folding`, `--showdown`, `--squeeze`,
`--discarding`, `[data-...]`). It also pins that the `heroCardDeal` rule still
exists (the fix removed a hint, not the animation - CLAUDE.md 10.6), that the
mobile hint block still carries the unmeasured `.pot-display` hint, and that
`.card-image__img` stays off its own layer. Run against the pre-fix tree it
fails three of four ways, naming both offending rules.

## Verification

- `npx vitest run tests/hero-cards-are-crisp-at-rest.law.test.ts
tests/law-registry.law.test.ts tests/unit/cardPresentation/auditFixes.test.ts`
  - 258 passed.
- The same law run against the stashed pre-fix CSS fails, listing
  `SeatSlot.css: .seat__cards--hero .seat__card { transform-style: preserve-3d }`
  and `TablePage.css: ... .seat__cards--hero .seat__card { will-change }`.
- There is no iPadOS simulator on this Mac. The real-hardware check is Dan's:
  deal a dozen hands on the iPad after this publishes and the hero's cards
  should match the board cards for sharpness on every one of them.
