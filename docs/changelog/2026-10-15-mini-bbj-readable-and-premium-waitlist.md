# Mini BBJ Readable, And A Premium Waiting List Button (2026-10-15)

## What Dan Said

1. "MINI BBJ LOOKS LIKE SHIT WHEN ITS BEING DISPLAYED AND IS SUPER HARD TO READ
   AND SEE WHAT IT ACTUALLY IS ... ITS TO DARK AND TO SMALL"
2. "THE 'TABLE FULL - JOIN WAITING LIST' NEEDS TO BE IMPROVED, THIS IS TOO
   CHEAP, IT NEEDS A PREMIUM LOOK AND FEEL TO IT."

## 1. The Mini BBJ Row

The row under the Bad Beat Jackpot plate was a 14px band (16px on desktop) of
dark navy carrying an 8 to 9px slate label (`#9fb4d0`) and a 9 to 10px amount.
Against the felt it read as a smudge.

- Height: 19px on a phone, 22px on desktop. Both are values of
  `--sp-bbj-mini-h`, so `--sp-bbj-h` and the felt's top reserve in
  `TablePage.css` follow on their own; no seat can reach the row.
- Label: lit house blue (`#45adff`, the console's `sc-ink--blue`), Roboto
  Condensed 800, 11px phone / 12px desktop, with a blue glow.
- Amount: bright silver, 12px phone (the same size as the plate's own numerals)
  / 13px desktop, with a blue bloom.
- Face: the same navy body and nickel hairline, now lit from inside with a
  blue top hairline and inner glow, and a blue bloom around the row. Minimum
  width so a short amount does not leave a stub.

Pinned by `tests/the-mini-is-seen-and-discoverable.law.test.ts` (heights
updated in the same commit).

## 2. The Full-Table Call To Action

The flat green pill is replaced by `WaitlistCallToAction`, which prints into
the approved painted action shell (`action-primary-shell`, 1280 x 315: chrome
rim, black glass face, crystal end caps and a round socket). No CSS border,
radius or gradient draws the control.

- Socket: the number of players waiting, or `#N` once the hero is on the list.
- Eyebrow (lit blue caps): `Table Full · N Waiting`, or `You Are On The
  Waiting List`.
- Title (engraved silver): `Join The Waiting List`, or `Position N Of M`.
- Every string is fitted to its face with `useFitText`.
- Height is capped at the seated action row (`--sp-bottom-row-h`), which a
  spectator's felt already reserves, so the shell never reaches a seat.
- Same handler (`handleOpenWaitlist`), so the must-move routing is unchanged.
  `tests/unit/mustMoveWaitlistEntry.test.ts` now pins the new element.
