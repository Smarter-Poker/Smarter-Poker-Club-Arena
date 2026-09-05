# Card reveal animation: what the industry actually does

Dan, 2026-09-05: "DO A DEEP DIVE ONLINE HOW THE OTHER ONLINE POKER ROOMS RUN
AND PROGRAM THIS ANIMATION SO WE HAVE THE INDUSTRY STANDARD AND AREN'T JUST
GUESSING."

This is the evidence the profile table in
`src/presentation/cardPresentation/profiles.ts` is derived from. Every claim
carries a source and a confidence level. **Where nothing could be found, this
document says so rather than filling the gap** - a confident guess is worse
than a gap here, because a guess written down becomes a production timing that
nobody questions.

## The headline: nobody in poker publishes their numbers

Across eight clients (PokerStars, GGPoker, 888poker, partypoker, WPN/ACR,
PokerBros, PPPoker, WSOP/Zynga) the total documented timing evidence is **one
2011 forum post from a PokerStars staff account.** Everything else is feature
description. So the timings come from the cross-platform motion standard,
which does publish, cross-checked against the reference recording.

## 1. The all-in run-out pause

| Claim                                                                                                                                                   | Evidence                                                                                                                                                                                                                 | Confidence  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| PokerStars settled on **1.5s between board cards** in an all-in run-out, after shipping 2s, then 1s, then reverting                                     | "PokerStars Steve" (staff), 2011-08-29: _"the time taken to deal the turn and river cards when all-in has been increased slightly to 1.5 seconds. This duration had recently been decreased from 2 seconds to 1 second"_ | MEDIUM      |
| That value is **server-side table configuration**, not a client preference                                                                              | Same post: _"Newly deployed tournaments and newly created ring game tables will be affected"_ - a rollout shape only possible server-side                                                                                | MEDIUM      |
| PokerStars turns hole cards face up automatically when players are all in, with no opt-out                                                              | July 2016 update removed the hide option; PokerNews + Pokerfuse. PokerStars' own article is gone (302s to fanduel.com, no Wayback snapshot)                                                                              | WEAK-MEDIUM |
| GGPoker squeezes the BOARD at all-in showdown, and gates it on pot size: **>100bb** Hold'em/Omaha, **>100 antes** short deck, **always** in tournaments | ggpoker.com/poker-games/table-social-features/                                                                                                                                                                           | SOLID       |
| GGPoker's board squeeze is **deliberately not opt-outable**                                                                                             | Same page: _"Open/Squeeze options and preference settings are not provided for board cards"_                                                                                                                             | SOLID       |
| Duration of GG's board squeeze                                                                                                                          | —                                                                                                                                                                                                                        | **NONE**    |
| All-in run-out timing for 888, partypoker, ACR, PokerBros, PPPoker, WSOP, Zynga                                                                         | —                                                                                                                                                                                                                        | **NONE**    |

**What this means for us, and the answer to "does this require a freeze":**
**No new feature is needed. We already have it, and it is already in the right
place.** `HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS` is server-side, mirrored
byte-for-byte into the engine, and the `all-in` profile derives its hold from
it - so the card is face up exactly when the server's gate opens. That is the
shape the only sourced evidence describes.

**One open item for Dan:** ours is **1250ms**; the sourced number is **1500ms**,
and PokerStars reached it by trying 1000ms and being told it was too fast.
Changing it is a change to the engine's run-out scheduler and to a constant
pinned by law, so it is not being changed here. It is a one-line decision if
you want it.

**Not adopted: GGPoker's pot-size gate.** Their threshold governs an EXTRA
ceremony on top of a normal reveal. Ours _is_ the normal reveal, and gating it
would mean the river does not animate on small pots - which CLAUDE.md 10.6
forbids outright. Recorded here so nobody re-derives it as a good idea.

## 2. What controls other clients actually expose

Three shapes exist, and **no client that could be documented ships a numeric
animation-speed slider**:

1. **Quality / refresh-rate reduction, ambient only** - PokerStars Aurora:
   `Graphics Quality` (Low/Medium/High) and `Ambient Animations` (Disabled).
   Support, quoted: _"The 'Low' setting reduces the refresh rate of the
   animations in the background of the table."_ (WEAK - forum; every live
   PokerStars help URL now redirects to fanduel.com.)
2. **Per-feature opt-out** - GGPoker `Game Settings > Card Squeeze`, with the
   most dramatic instance excluded from it. (SOLID.)
3. **Blunt global off** - 888poker: _"disable animation and more"_. (SOLID
   that it exists.)

Ours is a fourth shape and a defensible one: `--animation-speed`, a duration
multiplier, with no off switch (10.6). Worth knowing we are not alone in
refusing an off switch for the marquee animation - GG refuses it too, for the
board squeeze specifically.

## 3. Mobile: the assumption everybody has is wrong

| Claim                                                                          | Evidence                                                                                                                                                                                                | Confidence |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Mobile transitions should be LONGER than desktop, not shorter**              | Material Design: _"Transitions on mobile typically occur over 300ms"_; _"Desktop animations should be faster and simpler than their mobile counterparts. These animations should last 150ms to 200ms."_ | SOLID      |
| Entering elements 225ms, leaving 195ms; tablets +30%                           | Same                                                                                                                                                                                                    | SOLID      |
| **Ceiling: 400ms**                                                             | _"Transitions that exceed 400ms may feel too slow"_                                                                                                                                                     | SOLID      |
| Any poker client using shorter animations on mobile                            | —                                                                                                                                                                                                       | **NONE**   |
| GGPoker ships the same squeeze on both platforms, touch as a first-class input | _"squeeze them slowly with your mouse or by applying your finger to your mobile device screen"_                                                                                                         | SOLID      |

**This overturned our table.** The old profiles had mobile at a 320ms flip and
desktop at 480ms - mobile shorter, desktop over the ceiling. Both are now
corrected: **mobile 300ms, desktop 250ms**, everything at or under 400ms.

## 4. Performance practice (mobile web)

| Claim                                                                                                                                                              | Evidence                                                                                              | Confidence |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------- |
| Frame budget **16.67ms at 60Hz**, and refresh rate is not guaranteed - derive from the rAF timestamp or animations run double speed on a 120Hz phone               | MDN `requestAnimationFrame`                                                                           | SOLID      |
| **rAF is PAUSED in background tabs and hidden iframes**                                                                                                            | MDN, verbatim                                                                                         | SOLID      |
| **Animate `transform` and `opacity` only**                                                                                                                         | web.dev: _"restrict animations to opacity and transform to keep animations on the compositing stage"_ | SOLID      |
| `will-change` is a **last resort**; excessive use costs memory and makes rendering worse; it applies to the entire subtree; switch it on and off around the change | MDN                                                                                                   | SOLID      |
| Acceptance threshold: **≥99% frames retained**. web.dev's own comparison: `top`/`left` dropped 50% of frames, `transform` dropped 1%                               | web.dev                                                                                               | SOLID      |
| M3 duration ladder: short1 50, short3 150, short4 200, medium1 250, medium2 300, medium4 400                                                                       | material-web token source                                                                             | SOLID      |
| No thermal or battery signal on iOS Safari - Compute Pressure is Chromium-only, Battery Status is not cross-browser                                                | MDN, developer.chrome.com                                                                             | SOLID      |

**Adopted:** the ladder for every duration; `will-change` on one element and
only while it turns; the rAF background guard in the frame sampler.

**Not adopted: adaptive downgrade on a slow device.** The only portable signal
is our own frame sampler, and an animation that quietly gets shorter forever
after one bad second is exactly the shape 10.6 exists to prevent. We measure
and report; we do not act. Dan's call if that should change.

## 5. Haptics

`navigator.vibrate` **does not exist on any iOS Safari version** (caniuse:
`"n"` for every `ios_saf` from 3.2 to 26.5), and where it does exist it needs
sticky user activation - which a self-revealing board card does not have.
Already handled platform-wide by #3136. Nothing further here.

## 6. Reduced motion

| Claim                                                                                                                                                                                                                                                           | Evidence                      | Confidence |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
| `reduce` means _"minimize movement or animation, preferably to the point where all non-essential movement is removed"_                                                                                                                                          | CSS Media Queries 5           | SOLID      |
| **Swap the mechanism, do not delete it.** web.dev's global override uses a 1ms duration rather than `none`, _"as some websites depend on an animation to be run in order to work correctly"_; MDN's own example swaps a scale `pulse` for an opacity `dissolve` | web.dev, MDN                  | SOLID      |
| ~34% of sites use `prefers-reduced-motion` at all                                                                                                                                                                                                               | HTTP Archive Web Almanac 2022 | SOLID      |
| What fraction of USERS have it on                                                                                                                                                                                                                               | —                             | **NONE**   |

**Adopted:** the reduced profile is now a **150ms cross-fade** rather than
`animation: none`. The card still arrives face up, the movement is gone, and
every completion beat still fires.

## Sources

- https://forumserver.twoplustwo.com/28/discussion-poker-sites/pokerstars-speeds-up-software-dealing-speed-1070833/index8.html (post #180)
- https://ggpoker.com/poker-games/table-social-features/
- https://www.888poker.com/poker-software/features/
- https://www.pokernews.com/news/2016/07/pokerstars-hole-cards-25337.htm
- https://pokerfuse.com/news/poker-room-news/28506-pokerstars-removes-hole-card-hiding-option-cash-game/
- https://m1.material.io/motion/duration-easing.html
- https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-motion.scss
- https://web.dev/articles/animations-guide
- https://web.dev/articles/prefers-reduced-motion
- https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- https://developer.mozilla.org/en-US/docs/Web/CSS/will-change
- https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate
- https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/vibration.json
- https://almanac.httparchive.org/en/2022/accessibility
- https://drafts.csswg.org/mediaqueries-5/#prefers-reduced-motion
