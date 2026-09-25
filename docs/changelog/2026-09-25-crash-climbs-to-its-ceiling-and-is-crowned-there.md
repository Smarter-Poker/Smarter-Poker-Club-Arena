# Crash Climbs To Its Ceiling, And Is Crowned There (Mobile Spins, Phase 2 Of 7)

Phase 2 of the mobile spins programme is the feel of Diamond Crash now that it
has a 25.00x ceiling (migration `20260925143159`, phase 0): the pace of the
curve, what happens when a round books at the ceiling, the axis labels, and
the frame between rounds. The crash-point strip ("Last 20", newest left) was
already on the page and is unchanged.

## The pace: k = 0.10 (migration `20260925215112`)

The curve is e^(k t). k was 0.04, set on 2026-09-19 together with a 100x
ceiling so the long tail took long enough to watch. Under a 25x ceiling that
pace was the wrong shape: 2x took 17 s, 5x 40 s and the ceiling 80 s, so the
top of the range was practically never reached and every round felt slow.

k is now 0.10: the 1.10x floor (cash-out opens at 1.11x) at 1.0 s, 2x at
6.9 s, 5x at 16.1 s, 10x at 23.0 s and the 25x ceiling at 32.2 s. The pace
changes nothing about the money: the crash point is sealed from the roll
before the round starts, a cash-out books the multiplier at the server's own
clock, and P(point >= x) does not depend on k, so every target still returns
0.80 of the stake. `fn_crash_config_limits` now clamps `growth_k` at 0.10 (it
clamped at 0.04) and both live crash configs were set to 0.10 in the same
transaction; a round already open keeps its own `growth_k`, which
`crash_rounds` carries per row. The client's fallback growth (the page's
default and the fixture page) is 0.10 as well.

## Booked at the ceiling

A round that books at the max is the best thing that can happen on this
glass, and it now says so. In the scene the flight is crowned rather than
crashed: the replay ends at the cap (there is nothing above it to reveal),
the jet keeps flying, the ribbon and fill stay gold, and the burst plays in
the gold palette and keeps ringing while the plate is read. On the glass the
cash marker reads "Max 25.00x", no crash marker is pinned, and the frame
carries `data-max="true"` from the moment the replay reaches the cap: a gold
breathing edge, the Max chip lit gold, the hero in gold, the plate gold-edged
under "Booked At The 25.00x Max". Reduced motion keeps every colour and drops
the breathing.

## The axis labels give way before they overprint

Once the axis is large, the 1.00x and 2.00x lines sit a few pixels apart on a
phone glass and their labels overprinted. Every tick line still draws; a
label prints only where it has room under the label below it (14 glass
pixels), and 1.00x always prints because it is the launch line. The
presentation test that pinned all four low labels together now pins the four
lines and the three labels that fit.

## Alive between rounds

While idle, the launch line breathes light blue and the four LED corners
breathe with it, both opacity only, and the jet hovers on the launch line
instead of sitting on it. Nothing runs under reduced motion.

## Tests

`tests/components/CrashCurvePresentation.test.tsx` gains: the frame turns
gold once a cap booking's replay reaches the cap, reads the cap on the cash
mark and pins no crash; an ordinary booking and a crash are never marked as
the ceiling; tick lines all draw while a crowding label hides and 1.00x keeps
its label; the idle attract is present, opacity only, and rests under reduced
motion. The crash lifecycle, auto-settle, completion and replay suites are
unchanged and green. tsc and eslint clean.
