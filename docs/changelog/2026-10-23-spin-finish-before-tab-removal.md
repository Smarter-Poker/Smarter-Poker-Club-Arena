# A Spin Finish Reaches Its Card Before The Tab Closes

The tab rebuild treated a released seat paired with a still-playing entrant read as a move and pruned its table even without a replacement seat, cancelling the delayed result handoff. It now retains every removed tab until a readable cash table, a confirmed replacement in the same tournament, or a published terminal result establishes the exit. Omitted table rows stay unknown. No rank, payout, or finish is inferred from a missing seat.

Play Again retains its same-club, same-stake, same-format sibling selection and navigation-only behavior. Each network lookup now uses the existing bounded read helper, with the Spin list as the usable fallback. A late lookup cannot navigate after its report is dismissed or replaced.

Behavioral regressions reproduce the pre-commit seat-release and omitted-row losses, render the real ranking card with Play Again, preserve balancer/rebuy behavior, verify sibling navigation and duplicate taps, and cover each stalled read plus dismissal during lookup. Production verification uses the already-recorded finish; it does not purchase or force a game.
