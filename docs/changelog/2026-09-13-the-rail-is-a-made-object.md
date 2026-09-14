# The rail is a made object, and three defects only a photograph could find

2026-09-13. Dan, with a picture of the live bar under the console header:
_"THE TICKER ALSO NEEDS TO BE UPGRADED VISUALLY USING THE AGENT SKILL
#ClubArenaConsole. its too flat and boring at the moment."_

The picture carried more than the complaint. Read closely, the live rail said:

```
Sunday $200 Deep Stack Starts In0:19 · Buy-In Free Buy · 271 Entered
$100 Freeroll • 12:00 PM StartREGISTER In
```

Three shipped defects in one screenshot, none of which the suite could see,
because all three are facts about LAYOUT and `textContent` has no opinion about
layout.

## 1. A flex box ate the space before every countdown

`Starts In0:19`. The three pieces of a field - the text before the clock, the
clock, and the text after - were three SIBLING spans, and `.mtt-ticker__item`
is `inline-flex`, so each of them was a flex item. A flex item's own trailing
whitespace is trimmed at its line-box edge. The space the author wrote between
"In" and the number was removed by the layout engine, on every countdown the
bar has ever shown.

A field is one flex item now and the clock is inline inside it. The digits did
not change; the box around them did. The test pins the STRUCTURE rather than
the string, because the string was always right.

## 2. The call to action sat on top of the message

`StartREGISTER In`. The label was absolutely positioned at the right edge with
a scrim behind it, and the marquee scrolled underneath. A scrim cannot fix that

- the text is still there and still moving. It is a flex sibling of the
  viewport now, so the two can never occupy the same pixels and the edge mask
  does the blending it was already there for.

## 3. A field name in front of a label that was already a sentence

`Buy-In Free Buy`. `formatBuyInShort` returns the house label at zero and the
composer prefixed it unconditionally. A price gets a field name; a label does
not.

## And then we looked at it properly

`tests/visual/` mounts the real `TickerRail`, the real stylesheet and the real
composers over a felt, at 375, 1440 and 2560, and in the reduced-motion branch

- which no human had ever seen, because it only exists for a player who asked
  for no motion. Four more things were visible the moment there was somewhere to
  look:

- **The flag ate half a phone.** "STARTING SOON" took 185 of 375 pixels to say
  the least surprising thing on the bar. Every item carries a short form now
  (`SOON`, `REG`, `GTD`, `CLUB`) and the stylesheet picks one at 560px.
- **"REGISTER" appeared on a club's own message**, which has neither a
  tournament nor a table - a button promising a door that does not exist. The
  call to action renders only when there is somewhere to go.
- **The drain was scaled to a hard-coded five minutes** whatever it was
  counting, so a registration closing in 4:12 drew a nearly-full bar and a
  start in 0:19 drew a stub that read as an artefact. Items carry their own
  `windowMs`; an item with no window draws nothing.
- **Two loop copies ran together.** Between copies there was only padding, so a
  wrapped line read as one broken sentence: "…, All Members Welcome Freeroll
  At 8 PM". A copy ends with a pip now, except when the rail is holding still
  and there is no second copy.

## #SMARTERCASINOREALISM

`docs/laws.d/realism-is-one-vocabulary` is binding: the palette and the three
light effects are declared once on `:root` in `club-engine.css`, and a surface
that wants material reaches for `--realism-*` rather than inventing a ninth
palette. Every var here carries a literal fallback, which that law also
requires.

The rail was a painted rectangle with a cyan hairline, sitting directly beneath
a header that is milled. It now has the three effects - `--realism-bevel`,
`--realism-cavity`, `--realism-lift` - a gunmetal edge rather than a cyan
outline, a specular line drawn the way `club-engine.css` draws one on a button,
and a gloss on the flag so the chip reads as moulded rather than filled.

**The club still owns the face.** Material is light, not hue: the render builds
the gradient from the club's saved colour and the accent reaches the material as
a single `--ticker-glow` variable. The stylesheet decides where the light lands.
That direction matters - an inline `box-shadow` beats a stylesheet one, which is
exactly how the designed gradient was lost for three weeks in the first place.

The three house rules hold. No hover rule was added, because
`no-hover-effects.law.test.ts` outranks this pass. The page ground stays black.
Reduced motion drops the movement and keeps every border, bevel and colour.

## Verified

- `tsc --noEmit` clean; `eslint` 0 errors; title-case and painted-text OK
- `npm run build` clean in 9.66s, and the harness does not enter the bundle
- 203 assertions green across the 12 ticker-touching files
- Full suite, four shards: **20,019 tests, one failure** - and that one is this
  machine running Python 3.9, which has no `tomllib`, in a law test that
  mentions the ticker zero times. Verified failing the same way on clean
  `origin/main` earlier today.
- The pictures are in `tests/visual/__shots__/`, gitignored as build output.
  Regenerate with `./tests/visual/shoot.sh`.
