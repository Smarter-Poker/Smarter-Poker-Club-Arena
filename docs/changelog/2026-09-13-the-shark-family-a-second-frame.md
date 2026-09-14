# The shark family: a second frame, cut from a master Dan already approved

2026-09-13. Branch `feat/shark-console-family`. Follows #4497 and #4499.

Dan: "I do not want every single card to look exactly the same, they should not
all have the same frame, with the same spade at the top middle ... not all the
same boring cookie cutter style." He was right, and the fix was already on
disk: seven approved masters exist under `public/assets/club-buttons/`, with
five genuinely different frame architectures - the riveted NLH frame with the
chip medallion, the shark chamfer, the ornate spins vault, the Kingfish
landscape banner, the wallet strip. Each was cut as ONE fixed-size `chassis.png`
for one lobby card, so nothing else could use it. Only the spade PLO master was
ever sliced into a head, repeating rails and a foot so it could stretch to a
page. That single cut is why every console surface looked the same.

## What this adds

The shark heads-up master (`game-cards/heads-up/shark-headsup-premium-v1`,
733 wide) cut the same way, into `console/shark-console-v1/`:

- `top.png` 733 x 154: the top rails, the diamond crest, the header well and
  its pill slot. Master rows 50-203.
- `mid.png` 733 x 8: the plain rails, a median of master rows 738-748 - proved
  straight (max deviation 15/255 across the band) and free of the LED nubs.
- `bottom-plate.png` 733 x 172: one blue plate and the shark crest in the
  bottom rail. Master rows 749-920, trimmed to the crest. The source carried a
  2-row stray white line at its very bottom; it is not in the cut.

`SpadeConsole` takes `family="shark"`. Same component, same zones API, same
inks, same fitted text; different frame, different crest, and ONE plate - the
shape the spade could not do (its foot paints two plates, so a surface with
one action left the other painted and empty). All zone maths in
`SHARK_CONSOLE_ZONES`, in this master's own pixels. `--sc-max` is 733px for
this family: the art is never stretched past itself.

The chassis is opaque on black rather than transparent - that is how the
master was delivered - which composites identically on the platform's pure
black ground.

## Assignment (proposed to Dan 2026-09-13, not yet ruled on)

Shark for tournaments and the lobby. Riveted for money. Spins for VIP and
prizes. The Kingfish banner as the header on club pages. The spade for rules,
announcements, settings and admin. The wallet strip for rows.

## Verification

Rendered at 393px and 1440px with real copy: a tournament page, a one-line
popup, and the spade beside them. The shark plates' labels sit 32px and 8px
inside their faces at 393px. Copy gates and no-emoji OK; 102 tests across the
console, class-resolution, hover, popup and animation suites.

## Next

The riveted, spins and banner families, cut the same way. Then the 181-surface
sweep assigns each page a family by section. Repainting the club, diamond and
crown crests still needs an OpenAI image key on the Mac.
