# Nine-Seat PLO6 On A 320px Phone

The 320 × 568 layout put top-cap seats in the side columns and left too little
vertical room between the three side players. Nine-seat phones up to 340px now
keep the cap seats inboard and evenly space the short side columns. Top action
labels wrap in their own lanes without reducing avatar or player-plate sizes.

In narrow PLO6 showdowns, wager placement includes exact obstacle-edge gaps that
the radial sampling missed. These candidates stay below the top chrome and
inside the page and table height. Existing felt-first placement remains first;
the narrow fallback preserves seat ownership before using the felt watermark
lane. Top-cap wagers put their amount below the chips to fit their narrow lane.

Preserves protected-main readable-card CSS alongside the unmerged table PR.
No financial, engine, animation-duration or game-state writers changed.

Regression coverage removes the previous 320px nine-seat PLO6 exclusion and
checks real components with six hero cards, six-card shown opponents, all-in
markers and all opponents shown. Geometry tests preserve wider-phone and
six-seat placement. Approval images use synthetic local fixture data.

Owner approved the rendered layout on October 22, 2026 and authorized required
checks, protected merge, publication and live verification. Production proof
remains pending until those steps complete.
