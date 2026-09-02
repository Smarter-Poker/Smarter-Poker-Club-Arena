# 2026-08-30 — The reconnect banner comes off the BBJ's lane, and Rabbit Hunt stops announcing its own stock

Dan, with a screenshot of a live table:

> NOTIFICATIONS, ANY "RELOADING" OR "DISCONNECTED" NOTIFICATIONS SHOULD APPEAR
> ON THE TABLE ABOVE THE SMARTER.POKER BADGE ON THE TABLE. (CURRENTLY IT
> APPEARS AS LAYER 2, BEHIND THE BBJ) ... YOU DO NOT NEED A POP UP IN THE
> BOTTOM RIGHT CORNER, "ALERTING YOU" HOW MANY RABBIT HUNTS YOU HAVE LEFT.

## 1. The connection banner was drawing underneath the Bad Beat Jackpot plate

`TableConnectionBanner` shipped this morning at `top: 12px` of
`.table-container`. `.bbj-widget` is at `top: 6px` of the same box, also
centred, also a rounded pill, and it paints later — so the two occupied the
same thirty pixels of screen and the banner was the orange sliver visible
behind the BBJ in Dan's screenshot. The status the banner exists to deliver was
unreadable in exactly the situation it exists for.

Raising its z-index would only have swapped which pill is illegible. The fix is
the **position**:

- it renders inside `.table-surface` now, immediately above `.table-brand`;
- `top: 52%` with `transform: translate(-50%, -100%)`, so its bottom edge sits
  just above the felt wordmark (whose top edge is ~52.7% of the felt) and it
  grows upward instead of down through the lettering;
- percentages, not pixels, so the relationship to the wordmark holds at every
  breakpoint and in landscape. The 420px override now only shrinks the type; it
  no longer moves the pill.

`.table-surface` is its own stacking context (`z-index: 1`), which is the real
guarantee here: nothing in the top chrome can reach into it however either
side's z-index grows later. `z-index: 70` inside it clears the pot (30) and the
chip-flight layer (25) while staying under every modal and celebration overlay.
`pointer-events: none` is unchanged and still load bearing.

The `table-conn-banner-in` keyframes carry the `-100%` base offset now. Without
that the pill would drop onto the wordmark for the length of the animation and
settle back up.

## 2. Rabbit Hunt no longer toasts how many hunts you have left

Two `toast.info` calls fired after a reveal — "Free Rabbit Hunt, N Left This
Month" and "Rabbit Hunt Used, N Left In Your Pack". The count is not deleted,
it **moved**: it already renders as the corner numeral on the tile
(`rabbit-hunt__remaining`), where it reads *before* the press rather than being
announced after the money has gone, which is the moment it is actually useful.

The purchased-pack count had nowhere to land, so it gained one: `packRemaining`
state, and the numeral falls back to it when there is no VIP monthly pool. That
keeps the pack path acknowledged — it spends neither diamonds nor a VIP use, so
without it that path would be the one where a player burns something they paid
for and hears nothing.

What deliberately survives: the `N Diamonds Charged` toast. A **charge** is not
a stock level, and spending diamonds in silence is the bug
`tests/unit/rabbitHuntIsPaidFor.test.ts` was written for in the first place.

## Pins

- `tests/table-says-when-it-is-reconnecting.test.tsx` — new: the banner rule
  carries no pixel `top`, is anchored at 52% with a `-100%` Y offset, renders
  inside `.table-surface` before `.table-brand`, and exists exactly once.
- `tests/unit/rabbitHuntIsPaidFor.test.ts` — new: no remaining-count copy in
  the component at all, the pack count reaches `setPackRemaining`, the numeral
  falls back to it, and the diamonds charge is still spoken.

`tsc --noEmit` clean. Full suite green: 652 files, 9558 tests.
