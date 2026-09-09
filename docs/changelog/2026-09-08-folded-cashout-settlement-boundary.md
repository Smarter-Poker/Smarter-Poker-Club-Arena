# Folded Cashout Settlement Boundary

Phase 2 review reproduced an early cashout after a participant had folded in a still-running hand. The leave condition excluded folded participants from the live-hand branch. They could therefore cash out before settlement persisted their final stack and contribution.

The correction treats every participant in the live hand as awaiting settlement. A folded participant is marked leave_pending without another fold or a cashout. The existing settlement path handles their final cashout. A player who was not dealt into the hand retains immediate departure.

The regression failed before correction (immediate true instead of false). Coverage includes voluntary and forced departures, no duplicate fold, no early wallet operation, and a negative control for a player outside the live hand.

This is a bounded correction within Phase 2. It does not complete the occupancy protocol, other cashout paths, all poker-rule acceptance, or Phase 2 deployment verification.
