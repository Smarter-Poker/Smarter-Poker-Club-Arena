# A bomb pot does not announce its default

2026-09-07

Dan, item 7D: "because all bomb pots are double board, it doesn't need to say
double board, just bomb pot in x hands or next hand etc."

The bomb pot COUNTDOWN was fixed when he said it. This is the rest of the same
sentence, found by reading the bundle production was actually serving rather
than the branch: `Double Board` was still in the shipped JavaScript in four
more places, all of them player-facing.

## Where it still said it

| surface                                                      | before                      | after                 |
| ------------------------------------------------------------ | --------------------------- | --------------------- |
| Bomb pot overlay, the line under the title as the hand fires | `DOUBLE BOARD`              | `ALL PLAYERS IN`      |
| Lobby medallion row                                          | a whole `DOUBLE BOARD` chip | gone                  |
| Lobby medallion, bomb-pot-only tables                        | `DOUBLE BOARD`              | no detail             |
| Game Rules modal headline                                    | `Double Board Bomb Pot`     | `Bomb Pot`            |
| Cash game card rules line                                    | `... · Double Board`        | ends at the frequency |

The overlay one is the worst of them. It is the single line a player reads in
the second before the cards land, and it was spending that second on a fact
that is true of every bomb pot they will ever be dealt into.

## What still says it, deliberately

- **Three boards.** `TRIPLE BOARD` is a real departure from the default, so it
  survives everywhere the double did not. That is the whole rule: the default
  is silent, the exception speaks.
- **The host's own choice control.** `CashGameCreateFlow` offers 2 or 3 boards
  and has to name both, or the control has nothing to choose between.
- **The Boards row in the Game Rules modal**, which reads
  `2 (Pot Splits Per Board)`. That is not a label restating a default, it is
  the number and what it does to the pot, for a player who went looking.
- **The `double_board` flag itself**, everywhere it means something: the second
  board on the felt, the lobby filters, hand replay, the rules snapshot. This
  is a copy rule about badges, not a change to the game.
- **`TournamentPage`'s enum formatter**, a different domain (tournament format
  names, not the cash bomb pot).

## Pinned

`tests/unit/cashGameCard.test.tsx` asserted the old tail on two snapshots and
was updated in the same commit, per CLAUDE.md 5.8 - a test that pins behaviour
you deliberately replaced is updated by you, not left for whoever ships next.
