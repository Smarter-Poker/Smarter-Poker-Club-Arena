# Five throwables were signatures in name only

**2026-08-29** — Club Arena, throwable pass 4 (the bespoke half of Task 2).

The framework landed in #1798: contact shadow, speed-proportional smear, ground
shadow, felt dust, settle. That lifts all 48 items at once. This is the other
half of the approved plan — the per-item work — and the first job was working out
_which_ items actually needed it.

## The question I started with was useless

"Which throwables have no signature?" **All 48 have one.** Zero gaps. Asking
that question and stopping there would have produced a confident report that
nothing needed doing.

So I counted instead — declarations and distinct animations actually attached
to each item's selectors, comments stripped so prose could not inflate anything.
That found a real distribution: **median 23 declarations, min 1, max 45**, with
five items far below the floor:

| item          | rules | declarations | animations |
| ------------- | ----- | ------------ | ---------- |
| `robot`       | 1     | **1**        | 1          |
| `ghost`       | 2     | **2**        | 1          |
| `tennis_ball` | 2     | **2**        | **0**      |
| `angry_emoji` | 4     | 5            | 3          |
| `ufo`         | 2     | 7            | 1          |

`tennis_ball` is the one that gives the game away: two declarations, and **not a
single animation** — the only throwable in the set with no motion of its own at
all. Its whole "signature" was a trail opacity and a duration override.

`boxing_glove` also measures thin (10) and is deliberately left alone: it
delegates its entire landing to `KnockoutFlurry`, so a thin block there is
correct. It is the one sanctioned exception in the new test.

## On picking these five

I tried to rank by real usage first. `throw_usage` holds **91 throws from about
two accounts** — that is test data, not a usage signal, and I am not going to
dress it up as one. What it does show is that these are not obscure corners:
**ufo, ghost, angry_emoji and robot all appear in it**, and they are four of the
five thinnest. So the ranking here is the declaration count, which is objective,
and the telemetry only confirms the items are reachable.

## What each one does now

- **robot** (1 → 29 decls, 4 animations). It had a glitch on landing and nothing
  around it. In flight it is now _powered_: a scanning eye sweeping the hull in
  `steps(6)` — quantised on purpose, because mechanical motion is what makes a
  robot read as a robot — and an antenna blink on a deliberately different
  period so the two do not lock into one flashing lamp. On impact it shorts out:
  electric arcs snap across the point in `steps(3)`, twice.
- **ghost** (2 → 25). Was 82% opacity and a rise. A ghost should be _unsteady_,
  so it wavers — placed on the tilt wrapper, which owns no transform of its own
  and therefore cannot collide with the arc or the tumble spin above it. A
  spectral wisp streams behind it, and it passes _through_ the seat as a cold
  double ripple rather than hitting it with a shockwave.
- **tennis_ball** (2 → 19, 0 → 2 animations). Hard speed lines rather than a
  soft blur: a small light ball reads as fast through separated streaks and as
  heavy through a smear. The felt takes an elliptical scuff, offset so it sits
  _on_ the table — the same ground-plane rule the framework's dust follows.
- **angry_emoji** (5 → 30, 5 animations). Steam from both ears, two puffs on one
  element at different offsets and rhythms so they do not pulse together. The
  landing flushes red on a double-beat.
- **ufo** (7 → 28). The beam was already good; the saucer was a static glyph. It
  gets a travelling rim of lights — a conic gradient rotated under a ring mask,
  which is one element and one composited rotation rather than six positioned
  lamps — and a scan sweep so the abduction is looking at something.

## Guards, including one of mine that fired

Everything is checked, and one check earned its keep immediately:

- **The double-settle guard from #1798 was run against this work.** Two of the
  new keyframes rotate (`fx-ufo-rim`, `fx-robot-arc`), which is exactly what
  that guard watches for. Both are on `__fxf` / `__fxi`, never on
  `__impact-icon`, so no item newly needs a `--settle: 0` opt-out — confirmed by
  re-deriving the set, not by assuming.
- **All 11 new keyframe names checked against all 880 in the app.** `@keyframes`
  is a global namespace; a generic name silently overrides someone else's
  animation. All free, all `fx-` prefixed, and the test now pins both.
- **Every duration, delay and duration-override scales** with
  `--animation-speed` (CLAUDE.md §10.6). Zero unscaled.
- **color-mix has a plain-colour floor.** A new block-aware test checks _both_
  stylesheets: an engine that cannot parse `color-mix()` discards the whole
  declaration, so the floor must be a separate earlier declaration of the same
  property in the same block. My first version of this checker reported a false
  positive by matching the word "first:" inside a comment — it strips comments
  and groups by block now, and both files come back clean.
- PostCSS re-parse: 428 rules / 63 keyframes (was 381 / 52).

## The pin that matters

`LAW: no throwable ships as a stub` sweeps **all 48 items** and fails any that
drops below 8 declarations or has no animation — so the next item added cannot
arrive as a colour and a duration, and these five cannot quietly regress. The
floor for the five is set at 18, comfortably under the 23 median: it pins them
as _finished_, it does not freeze the tuning.

## Still honest

None of this has been seen on a real table. The numbers are judgement, and
judgement about animation is worth what it looks like at 375px on a phone.
Eleven items now sit between 8 and 13 declarations (`banana_peel`, `trash_can`,
`thumbs_up`, `thumbs_down`, `chicken`, `magic_8_ball`, `fireworks`, `doge`,
`horseshoe` among them) — below the median but above the stub line, and the
sensible next pass if Dan wants it.
