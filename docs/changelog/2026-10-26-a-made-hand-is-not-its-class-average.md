# A made hand is not its class average

Dan, 2026-10-26: "I JUST WATCHED A HORSE RAISE AJc 'SLEEPYREG' AND FLIP THE NUT
FLUSH AND CHECK IT EVERY SINGLE STREET INSTEAD OF EVER BETTING FOR VALUE!?"

## The hand

Hand 48442708, Sunday Funday Mystery, heads-up in the blinds: sleepyreg (a
horse) raised A-J of clubs from the small blind, the big blind called, and the
board ran Q-5-8 of clubs (the nut flush), 5h, Kh. The horse checked the flop,
the turn and the river.

## Why

The open-node solver consult reads `gto_postflop_compact`, whose cells hold the
MEAN of a hand class over every board in a texture class. On a monotone flop
"AJs" is mostly an ace-high hand without the suit, so the production cells
say: flop (tourney_ev, BB seat, 20bb) check 76%; turn (tourney_icm) check 82%.
The cell cannot see that this particular A-J holds the ace of the board's suit.
Replayed on the code serving tonight with those exact cells, the nut flush bet
the flop 17% of the time and the turn 21%.

## The fix

`server/src/engine/HorseLogic.ts`: when hero's made hand on the board is a set
or trips, a straight, a flush or better, the class-mean cell does not answer
(`v58_made_hand_cell_skip`); the value ladder bets it. Any other holding still
reads the cell exactly. Replayed: flop and turn bet 80%+ and 93%+.

Pinned by `server/src/engine/HorseMadeHandBeatsClassMean.law.test.ts`.
