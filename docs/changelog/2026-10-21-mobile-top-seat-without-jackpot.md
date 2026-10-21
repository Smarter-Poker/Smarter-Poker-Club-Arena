# Mobile Top Seat Without A Mini Jackpot

Tables without a payable Mini BBJ left the top player at the unshifted felt position, overlapping that player's wager. Phone top seats now anchor below the lowest visible jackpot row, or the existing declared plate band when neither row is drawn. Bet coordinates retain their rail compensation; desktop placement is unchanged.

The existing occupied-table regression now renders the real components with both jackpot rows, only the main row, and no jackpot, in playing and revealed states. It checks 6-max and 9-max at 320, 375, 393, 430 and 480 pixels. The no-jackpot case reproduced a wager/nameplate collision and avatar/nameplate on felt before the fix; all 60 WebKit configurations pass after it. This extends the October 20 taper, rail clearance and shared tool sizing correction.

Validation: application TypeScript and 40 focused hook/placement/style tests passed. Publication and exact production gameplay proof are recorded separately in the task checkpoint.
