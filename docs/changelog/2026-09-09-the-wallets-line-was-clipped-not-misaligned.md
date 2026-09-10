# The wallets count line was clipped, not misaligned

A correction to `2026-09-09-three-mobile-lobby-bugs.md`, written the same day
by the same agent, because a wrong explanation left in a comment is read as
current by everyone after it.

## What was claimed

That the MY WALLETS count zone was wrong twice over: too narrow for its string,
AND left-aligned because `place-items: center` cannot centre a bare text node,
so that even "5 BALANCES" would have sat 1.8% of the plate left of the painted
title. `text-align: center` was added as "what does the centring", and the law
test asserted its presence.

## What is true, measured

Rendered against the shipped stylesheet at 393px, with the OLD zone
(left 41.4%, width 26.5%) and no `text-align`:

| string             | zone    | text    | centre | result                 |
| ------------------ | ------- | ------- | ------ | ---------------------- |
| "5 Balances"       | 104.1px | 73.4px  | 54.65% | centred, not clipped   |
| "Loading Balances" | 104.1px | 118.1px | 56.43% | clipped, start-aligned |

A grid item that fits its cell is centred by `place-items`, text node or not.
An item that overflows an `overflow: hidden` cell is given safe alignment,
which snaps it to the start edge; the remainder is cut off the right. That is
the photograph: clipped, and left-aligned BECAUSE clipped. Adding
`text-align: center` to the overflowing case changes nothing (still 56.43%,
still clipped), and adding it to the fitting case changes nothing either.

## What changed

- `src/pages/ClubHomeMobilePremium.css`: the comment now says this, and the
  no-op `text-align: center` is gone so nobody reads it as load-bearing.
- `tests/the-mobile-lobby-chrome-stays-fixed.law.test.ts`: the third case is
  retitled and no longer asserts `text-align`; it asserts the zone's centre and
  its width, which are the two things that matter.
- `docs/laws.d/the-mobile-lobby-chrome-stays-fixed.md` and the original
  changelog say the same.

The fix that shipped in #4003 stands: the placeholder is never printed, and
the widened zone keeps every real count clear of the overflow fallback. What
was wrong was the story told about it.

## How the error happened

The first harness rendered "Loading Balances" (overflowing) against the old
zone, saw it start-aligned, and generalised to every string. The fitting case
was never rendered against the old zone until the E2E mutation run asked why
removing `text-align` did not fail the test. One measurement would have
settled it an hour earlier.
