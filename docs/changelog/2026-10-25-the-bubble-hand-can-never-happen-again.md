# The bubble hand can never happen again

Dan, 2026-10-25, with a screenshot of tournament hand 48403158: "a short stack
calling a pre flop raise with 92o out of position!! ON THE FUCKING MONEY
BUBBLE THEN CALLIN OFF WITH 4 DIAMONDS ON THE RIVER ... THIS CAN NEVER
FUCKING HAPPEN AGAIN!! ... JUST CHECKS TOP PAIR TWICE".

## The hand

Kings Club MTT, 92 entrants, 13 left, 12 paid, hand-for-hand, blinds
5,000/10,000 with a 10,000 big-blind ante. lilqueen (a horse) in the small
blind with 9c 2d and 71,912 chips (7.2 big blinds). bbNit (a horse, 318,730)
min-raised to 21,876.

| street | board | lilqueen did | what was wrong |
|---|---|---|---|
| preflop | | called 16,876 | a 7bb stack facing a raise jams or folds; 9-2 offsuit folds |
| flop | 9h 8d 6d | checked | top pair, 61% against the raiser, 50,036 behind into 63,752 |
| turn | 3d | checked | top pair and a flush draw, 69% |
| river | 7d | called off 50,036 | the 2d made the lowest possible flush on a four-diamond board |

## Why each one happened

1. **The call.** On its own the preflop brain folds this hand every time
   (a 7bb stack is jam-or-fold). The opener read as a wide raiser, and two
   "maniac" recoveries priced a FLAT CALL against that read: the V38 all-in
   price (the call cost 25.2% of the stack, just over its 25% trigger) and
   the reference call-down. Replayed with the full tournament context and a
   wide-raiser read, 9-2 offsuit called 34% of the time and 7-3 offsuit 46%.
2. **The checks.** The not-facing-a-bet branch only leads when the horse
   holds the initiative; a caller never does, so a strong hand with less than
   one pot behind checked every time.
3. **The call-off.** The committed branch priced the deuce-high flush at about
   49% because the bettor's range is read from its preflop line and board
   contact, not from "checked twice, then bet when the fourth diamond came".
   Every diamond above the deuce beats it.

## The fix (server/src/engine/HorseLogic.ts)

- A tournament hold'em stack of 12 big blinds or less facing a raise that
  leaves chips behind is answered by the jam or the fold in both maniac
  recoveries. The jam is priced as the whole stack against the raiser's full
  call (no fold equity credited), plus the full survival premium, plus a
  margin when another seat is still to act.
- Flop or turn, not facing a bet, tournament no-limit hold'em: with at most
  one pot behind (against the deepest live opponent) and a made hand with
  equity of at least 45% plus half the multiway/survival margin, the horse
  moves all in.
- River call-offs in tournaments: a flush made with ONE card on a board with
  four of the suit, with three or more live flush ranks above it, folds to a
  bet that costs half its stack or more. It carries the commitment guard, so
  no later owner reverses it. Cash games keep their own pricing.

Replayed with the engine's full tournament context: 9-2 offsuit, 7-3 and 8-3
fold 100%; A-T and 8-8 jam 100%; no hand tested flat-calls; the flop and turn
jam 100%; the river folds 100%.

Pinned by `server/src/engine/HorseBubbleShortStackDiscipline.law.test.ts`.
