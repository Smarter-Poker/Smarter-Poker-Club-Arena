# 2026-10-12 - Share & Invite is the share button's label, not a second button

## What failed

Post-Deploy E2E runs 38206133852 and 38209318287 (Client browser verification)
failed `tests/e2e/mobile-tap-targets.spec.ts:180`, "every control answers to a
thumb at 375px", on the club home page:

```
clubs/a41434bb-8d0c-400a-8f0d-e8b3d65afed4: button.club-identity__invite "Share & Invite" box 7px, reachable 0px
```

## Cause

PR #6705 (Dan 2026-10-11: "Remove the 'Level 29' under the playing Now and
replace that with 'Share & Invite'") made the blue plate a second button that
runs `onShare`, the same action as the painted copy frame above it. At 375px
the club card sits beside the BBJ plaque and is 180.5 x 75.2px. There:

- the plate is 7.4px tall, and its own 44px `::after` band was clipped by the
  `overflow: hidden` every printed zone shares;
- the plate's centre is 24px below the copy frame's centre (55.8 vs 31.9), and
  the frame's band (z-index 2) reaches 53.9, over the top of the plate.

This is geometry, not a missing rule. The sweep requires each control to own
20px above and below its centre, so two separate controls in one column need
their centres more than 40px apart, inside a card 75px tall. Centres 24px
apart cannot both get it, whichever one paints on top, and the paired card's
proportions are pinned (Dan's master, `club-lobby-premium-machine.test.ts`).

## Fix

The two faces run one action, so they are one control. The words
"Share & Invite" are printed INSIDE the share button and positioned onto the
painted plate (`zoneStyleWithin(invite, share)`), so:

- a tap on the plate is a tap on the share button; the frame keeps its full
  44px band and nothing competes with it;
- the keyboard meets one stop, named for the words it can see
  (`aria-label="Share And Invite"`, `title="Copy Referral Link"`), and focus
  lights both faces;
- the picture is unchanged: rendered at 393px before and after, identical.

An arena covers the plate with its rail, so its button stays the bare copy
frame named "Copy Referral Link". No art, ratio or breakpoint changed, and no
assertion in the post-deploy sweep was touched.

## Pinned

`tests/e2e/club-mobile-wallet-reach.spec.ts` (CSS Beat E2E, before merge) now
replays the sweep's exact rule on the real stylesheets at 375 and 393px: every
control on the card owns its 44px band, and the centre of the plate belongs to
the Share And Invite button. It failed on `main` with the same 7px / 0px
result as production before the fix. `tests/unit/lobbyTournamentBoardDesign.test.ts`
pins that the plate is not a separate button.
