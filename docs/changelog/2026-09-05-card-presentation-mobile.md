# The card reveal, retimed against the published standard and built for the phone

2026-09-05. Branch `feat/card-presentation-mobile`.

Dan, verbatim, three instructions:

1. "WE HAVEN'T IMPLEMENTED LIGHTNING YET ... LEAVE IT ALONE."
2. "DOES THIS REQUIRE SOME SORT OF FREEZE OR OTHER FEATURE. DO A DEEP DIVE
   ONLINE HOW THE OTHER ONLINE POKER ROOMS RUN AND PROGRAM THIS ANNIMATION SO
   WE HAVE THE INDUSTRY STANDARD AND AREN'T JUST GUESSING."
3. "THIS NEEDS TO BE BUILD AND OPTIMIZED FOR MOBILE, NOT JUST DESK TOP, 95% OF
   USERS WILL BE MOBILE."

The research is `docs/research/2026-09-05-card-reveal-industry-standards.md`.
What follows is what the research changed.

## The assumption it overturned: mobile is the LONGER one

Every timing in `profiles.ts` was invented. The desktop cash flip ran 480ms and
the mobile flip ran 320ms, on the reasoning that a phone is the weaker device so
it should get less animation.

Material Design's duration ladder says the opposite, and says it twice:

- the ceiling is **400ms** ("transitions that exceed 400ms may feel too slow");
- **mobile transitions run 300ms and desktop 150-200ms**, because a phone screen
  is small and held close, so the same motion covers less distance and reads as
  abrupt if it is given desktop timing.

So the old table was backwards in both directions at once: desktop was 80ms over
the published ceiling, and the platform that 95% of players use was given the
shortest reveal in the file. Every profile is re-derived from the ladder now,
and the flip (squeeze + reveal + settle) is the number being placed on it:

| profile      | prepare | flip    | total   |
| ------------ | ------- | ------- | ------- |
| cash desktop | 50      | 250     | 300     |
| tournament   | 50      | 300     | 350     |
| lightning    | 50      | 200     | 250     |
| replay       | 100     | 400     | 500     |
| spectator    | 50      | 250     | 300     |
| **mobile**   | **50**  | **300** | **350** |
| background   | 30      | 150     | 180     |
| reduced      | 0       | 150     | 150     |

`FLIP_CEILING_MS = 400` and `MOBILE_FLIP_MS = 300` are exported and pinned, so
the next agent to reach for a number has one to reach for. Nothing here is a
toggle and nothing here is zero except the `off` profile, which is only ever
resolved for a table nobody can see (CLAUDE.md 10.6).

Lightning's row moved with the ladder because the ladder is arithmetic on a
constant, not a feature: no Lightning behaviour, surface or code path was
touched, per instruction 1.

## The freeze question: no new feature is needed, and one number is open

There is no separate "freeze" mechanism to build. The only sourced description
of how a real room does this is PokerStars' all-in runout pause, which is a
SERVER-SIDE config value rolled out per newly created table - not a client
animation flag. Ours already has exactly that shape:
`HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS` is set server-side and mirrored into
the engine scheduler, and the all-in profile derives its `holdMs` from it rather
than carrying a number of its own.

**Open item for Dan, deliberately not changed.** Ours is **1250ms**. The sourced
industry value is **1500ms** (PokerStars tried 2000, then 1000, and settled on
1500). It is a one-line change, but it touches the engine scheduler and a
law-pinned constant, so it is a call about pacing rather than a defect, and it
is Dan's. Say the word and it moves.

## Mobile work, in the order it matters on a phone

**Nothing is promoted speculatively any more.** `TablePage.css` carried a
blanket `will-change` under `@media (max-width: 768px) and (pointer: coarse)`
that included `.community-cards__card`, so every board card held its own
compositor layer permanently: five per table, twenty in a four-up tile view, on
the devices with the least memory. MDN is explicit - "use `will-change` as a
last resort", "don't use it to anticipate performance problems", and it applies
to the entire subtree. The card is out of that rule. The stylesheet now has
exactly one `will-change`, and it is gated on the animation actually running:

    .card-squeeze-host[data-rs-animating='on'] .card-squeeze { will-change: transform; }

`data-rs-animating` is written by `SqueezeCard` and cleared on complete and on
cancel, so the hint exists for the length of the flip and not one frame longer.

**Everything that moves is a transform.** `ccCardSheen` travelled by animating
`left`, which is layout on every frame; web.dev's measurement of that exact
substitution is 50% dropped frames for `top`/`left` against 1% for `transform`.
It travels by `translateX` now. The dead `ccCardFlip3D` keyframe and its
`.community-cards__card--dealing` rule, which also animated `left`, are deleted
rather than fixed - nothing referenced them.

**The frame sampler no longer libels a healthy phone.** rAF stops firing in a
backgrounded tab (MDN), so a sample that spans a backgrounding computes a very
low frame rate and reports a perfectly good device as degraded - which on mobile
is the common case, because switching apps is how phones are used. The sampler
abandons its sample on `visibilitychange` when `document.hidden`.

**A new mobile e2e spec**, `tests/e2e/card-squeeze-mobile.spec.ts`, runs under
`devices['iPhone 13']` against a real built bundle and measures the live
cascade: the 375px board, the flip duration, the single gated `will-change`, the
reduced-motion path, and the resting face-up transform. It is wired into both
`ci.yml` and `post-deploy-e2e.yml`.

## Reduced motion swaps the mechanism, it does not delete the reveal

The reduced-motion block used `animation: none` on `.card-squeeze`, which is the
shape CLAUDE.md 10.6 forbids: motion collapses, meaning never does. A player on
reduced motion got a card that changed state with no event at all, and any code
waiting on `animationend` waited forever. It cross-fades now
(`ccCardCrossFade`), on the same `--rs-flip` clock and the same
`--animation-speed` multiplier, so the reveal still happens, still takes time,
still ends, and simply does not turn. web.dev's own guidance is the same: use a
short duration rather than `none`, so the event still fires.

The spine (the edge-on sliver) is the one thing that is genuinely gone in that
mode, because an edge belongs to a turn and there is no turn.

## What was deliberately not built

- **Lightning**, per instruction 1.
- **A pot-size gate on the squeeze** (GGPoker shows a longer reveal on big
  pots). It would make an animation conditional on game state, which 10.6
  forbids: every animation plays every time it is owed.
- **Adaptive downgrade on a slow device.** The sampler measures and reports;
  it does not quietly shorten anyone's reveal. Same reason.
- **Showdown and winning-hand reveals through this engine.** They live in
  `SeatSlot` and are pinned by `handCompletionLaw`; moving them is its own
  change with its own pin migration, not a rider on this one.

## Verification

`tsc --noEmit` clean; `npm test` green; `vite build` clean; the six-spec
Playwright chromium run green against a bundle built from this commit and served
locally, including the new mobile spec.
