# Multi-board audit descendant populations

Four October24 collapse findings divided actual multi-board decisions by all
cash or fleet decisions. Bomb hands declined 6877/6113/4141/1272 across
October21-24, while board-two/trim fires per bomb stayed 11.91/11.85/11.94/14.22,
lock fires .6123/.6041/.6066/.6580 and freeroll bets .4072/.3916/.4069/.4119.
The gameplay gates consume multiple boards even when the hand is not a bomb
hand, so the diagnostic uses existing phase13_board_2 plus phase13_board_3
decisions, not a bomb-only proxy. Board counts are population receipts.
Missing decision counts remain unknown; no strategy, schedule or historical
financial data is changed. The existing native fixture reproduces all four
false alerts before the replacement, clears them afterward, preserves a real
within-population decline and refuses a guessed missing denominator.
