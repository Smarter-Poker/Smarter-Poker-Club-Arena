# Equal Table Seat Sizing

Owner request: all avatars and name/chip/action panels use the hero size and fit on full mobile tables.

- Move the former hero avatar and panel sizing onto the shared seat; remove opponent-only dense-ring and top-row reductions.
- Share the tallest natural name/chip panel and widest action label within each table so complete wrapped names do not produce unequal panels.
- Fit short portrait screens with one shared avatar scale, including hero; keep normal-height phones at the previous hero size. The 320px fallback retains readable names/stacks with uniform compact panels.
- Reserve the side players' shown-card lane when fitting the two top seats, place action captions against measured player/chrome/wager bounds, and give normalized portrait side seats room below the board. Bounds keep the top pair separate.
- Prefer shown hands over their own avatar rather than the neighboring betting lane. Retain card placement only after its deal/flip animation reaches rest, then preserve it through later runouts.
- Preserve rectangle dimensions explicitly when moving browser DOMRects; their prototype-backed properties do not survive object spread. Add a regression for this placement failure.
- Do not count the home-indicator inset twice in the hero card band: the action reserve already includes it. Keep PLO cards above the buttons on a short embedded phone.
- Keep the observer footer reserve proportional to the shared avatar and readable panel; preserve a small board margin beside full-size side panels.
- Return six pixels of unused hero reserve on short portrait phones; the reserve stays static throughout play.

Validation is recorded in the task checkpoint. Focused unit/law tests and the maintained full-table browser suite cover equality, complete names, board/marker/card clearance, ownership and fixed shown-card positions. Retained CSS translations remain exact; composited DOMRect comparisons allow only 0.0005px numerical drift during native transforms. The geometry baseline records the intentional avatar/panel enlargement and compact shared fit. The production seat-rendering proof also measures matching hero/opponent avatar, name/chip and action dimensions in the actual published client under its existing upstream-write guards. Its controlled browser input is not a natural seat or financial receipt. Required hosted checks, protected merge, publisher and live proof are recorded separately.

Client-only change using existing game APIs. No engine, migration or financial write.
