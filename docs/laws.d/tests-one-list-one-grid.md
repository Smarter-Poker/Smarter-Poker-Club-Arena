# tests/one-list-one-grid.law.test.ts

The rake snapshot renders three breakdowns through one `<li>` with four, five and six cells; the shared element declares NO `grid-template-columns` and each list sets its own via `.listClub` / `.listAgent` / `.listDownline`, so an appended rule cannot govern lists it was not written for - the agent grid is asserted to have exactly one column per cell the agent row renders, and `.legend` is declared once
