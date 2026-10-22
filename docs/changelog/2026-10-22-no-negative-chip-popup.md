# Remove negative chip-contribution pop-ups

Bets, calls, raises, blinds and antes update the shared seat stack without a floating negative amount or its stack-down animation. The producer only creates animation state and a timer for positive changes. A contribution clears any preceding gain indicator; occupant changes still reset it.

Positive gain indicators, chip movement, wager amounts and pot accounting retain their existing behavior. This is a client presentation change with no new engine dependency.

Validation: TypeScript and existing seat-render, animation-speed and animation-law suites; contribution/gain/contribution and occupant replacement coverage for hero and opponent seats. Publication and live evidence are recorded in the task checkpoint.
