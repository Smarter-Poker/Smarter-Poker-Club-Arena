# Shown cards never move, in every game

The PLO5/PLO6 fix locked a tabled hand's slot only for five- and six-card hands. Hold'em, PLO4 and other shown hands were still re-placed on every runout, shake and winner effect, so on a crowded phone a four-card all-in could slide or close up mid-runout. Every tabled hand now keeps the slot, spacing and size it was first given for the rest of the hand.

A hand whose first placement found no clearer spot used to stay unlocked and could jump once space opened later in the hand. It now stays where it is drawn.

A phone browser's toolbar showing or hiding changes the viewport height without moving the felt. That height change alone used to reset every lock. Locks now reset only on a new hand, an orientation change or a real change in the table's own size.

Unit coverage pins all three behaviors against the old code: two- and four-card hands through a runout that lands the board on their spot, a hand with no clear spot, and a viewport-height change. A shim backs the CSS `translate` property in jsdom, and a fixture typo that hid the board from the original placement test is fixed. The occupied six- and nine-seat phone matrix now proves zero card movement through effects for Hold'em-sized shown hands as well as PLO5/PLO6.
