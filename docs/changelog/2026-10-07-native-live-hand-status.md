# Native Live Hand Status

Android Chrome omitted the informational table-menu header from its native accessibility tree even while the live hand number was visible. The shared menu now exposes that number as a named status, keeping its single text child and appearance. Updates do not move focus or announce every hand.

The rendered regression checks the accessible name follows the current hand and active table, retains a single text child, and disappears for a lobby tab. Before the correction: one failure and eight passes. Physical Android verification remains required after publication.
