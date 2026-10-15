# Club Data Wears The Smarter.Poker Look (2026-10-15)

Dan: "change this layout up, make it more smarter.poker style. you literally created this as a 1:1 of poker bros, even the color schema. change it to smarter.poker schema, make the frames dynamic with depth and 3d look and feel. keep all the data and layout the same."

Only `ClubDataSimplePage.module.css` changed; markup, data and layout are untouched. The screen now uses the strict Smarter.Poker palette the tournament lobby already uses (`styles/tournament-lobby-3d.css`): navy glass surfaces, electric-cyan accent (#6fdcff), club-blue action (#1877f2), no gold. Every frame is built from the house three-layer depth recipe: a lit-top gradient, an inset bevel, and a cast shadow. The period well and search are recessed; the selected range, game type and stakes keys are raised and lit; the totals are one raised glass slab with grooved bays and a lit rim; every game is its own raised card.

The console sweep's ruling for this screen records both of Dan's rulings, and `tests/club-data-is-live-and-counts-the-felt.law.test.ts` pins the palette and the depth recipe.
