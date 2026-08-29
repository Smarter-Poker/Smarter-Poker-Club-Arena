# The throwable system had opted out of Animation Speed entirely

2026-08-29. Found while wiring the boxing-glove throwable to the knockout
flurry, by counting rather than by looking.

## What was wrong

`ThrowAnimation.css` and `ThrowableSignatures.css` carried **217 hardcoded
animation durations between them, and not one of them scaled.**
`ThrowAnimation.tsx` never called `getAnimationSpeed()` at all — not for the
four CSS timeline variables it computes, not for its four phase timers, not for
the flight whoosh, not for the two decorative class-removal timeouts.

So a player on the slow setting watched every other animation on the table
stretch — up to 3× — while throwables kept snapping past at 1×. CLAUDE.md
§10.6 is explicit that speed scaling via `--animation-speed` is _the_ one
sanctioned control over animation duration; the throwables had opted out
wholesale, and nothing noticed because no test had ever asked.

**It also became a live drift the moment the boxing glove started playing the
knockout cue.** `playKnockoutFlurry` scales its beats by the player's setting;
the throwable's impact container did not. At 2× the audio would have run twice
as long as the picture it was describing, and the container would have faded
the flurry out mid-punch.

## The fix

Each duration is scaled in exactly **one** place — the only way to avoid
scaling something twice, which is as broken as not scaling it and much harder
to spot:

- **In JS**, the four timeline variables (`--flight-dur`, `--impact-dur`,
  `--life-dur`, `--linger-dur`) are multiplied where they are computed, so
  every keyframe that reads them stretches for free. `getAnimationSpeed()` is
  read **once per throw** rather than per use, so a setting changed mid-flight
  cannot desynchronise a throw already in the air.
- **In CSS**, the remaining 217 literals are wrapped in
  `calc(<n> * var(--animation-speed, 1))`.
- The `at()` helper multiplies, which covers all four phase transitions in one
  edit. Scaling at the call sites would have been four chances to forget one,
  and a forgotten one fires an impact before its projectile has landed.
- `playFlight` now receives the scaled duration, so the whoosh lasts as long as
  the flight it announces.

## How it was verified

The transform was re-run from the pristine base with a **stricter, comment-aware
matcher** and diffed against what shipped: byte-identical, 42 + 175 wrappers.
Structure checked independently — same rule count (203 / 436), same keyframe
count (28 / 52), balanced parens, and every changed line contains the calc
wrapper and nothing else.

A new law test walks **both stylesheets** and fails on any animation duration
that neither scales nor defers to a pre-scaled timeline variable, and asserts
those variables are never multiplied a second time in CSS.

Worth recording: the test's first regex reported a phantom failure, because
`.throw-animation:` inside a prose comment satisfies `/\banimation:/` — a
hyphen is a word boundary. It strips comments first now and refuses a property
preceded by a hyphen. The shipped transform had the same loose pattern but
wrote nothing into a comment; that was luck, and the strict re-run is what
proved it rather than assumed it.
