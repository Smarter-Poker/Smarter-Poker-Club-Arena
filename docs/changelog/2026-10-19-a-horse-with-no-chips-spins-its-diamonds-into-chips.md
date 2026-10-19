# A horse with no chips spins its Diamonds into chips

**Owner request (Dan, 2026-10-18).** "A horse with no chips left grinds the
Diamond Arena and uses its Diamonds on Diamond Spins to convert to chips."
Phase 3 built the door (`fn_horse_diamond_spins`, migration
`20261019023857`). This is Phase 4: the engine uses it.

## What the engine now does

`HorseDiamondSpinsDriver` (a leader-owned engine service, started and stopped
with the other horse services in `index.ts`) runs a pass every five seconds:

1. **Who.** It reads the cheapest cash game Midway Union has open, then every
   active horse membership at Club JAQK, Shark Club and Deep Stack Society.
   A horse joins a session when its club wallet is below one buy-in of that
   game (`HorseBankroll` rule 7, "broke means freerolls"; Diamond Spins is now
   the second way back). It stays in session while it has spun there in the
   last two hours and is still under its target. A horse with a card or bonus
   game still unplayed always finishes it.
2. **How far.** Its target is the bar the fleet needs before it will seat that
   horse at the cheapest open game again: the seat gate (`rollSupportsStake`)
   and bankroll rule 1 (`canSit`), whichever is higher. At today's cheapest
   open game (0.05/0.10, 4.00 minimum) that is 400 chips for a nit, 250 for a
   standard horse and 200 for a gambler.
3. **How much.** Each spin uses one of the wheel page's own entries (25, 100,
   500, 1,000 or 2,500 Diamonds). That is the biggest one within the
   temperament's cap (nit 500, standard 1,000, gambler 2,500), within the
   Diamonds above a 10,000 Diamond reserve it keeps for the Diamond Arena, and
   no bigger than the remaining gap needs at the wheel's 0.80 return.
4. **In the person's order.** One action per horse at a time, at a person's
   pace (6 to 18 seconds between spins, 3 to 8 seconds between bonus moves).
   It turns a waiting card first, then finishes a round in play, then starts
   the earliest unplayed prize, and only then spins again. That is the same
   order the wheel enforces for a person.
5. **Bonus games.** Plinko: every Diamond played in at most twenty drops of a
   listed value. Crash: an auto cash-out between 1.40x and 4.00x by
   temperament, then the round is settled on the server clock. Mines and
   Donkey Cross: the setting and round limit read from the game itself, one to
   four tiles or streets, then a cash-out. Diamond cards: one of the three.
   All are stable hashes of ids (`HorseDiamondSpins.ts`), so they can be
   replayed and checked.

## What it never does

- It never calls any function but `fn_horse_diamond_spins`, which opens only
  for the engine and only for a horse, and runs the person's own wheel. It
  writes no table.
- It never reads a sealed outcome: the crash point, mine cells, road roll,
  seeds, roll or card order are never selected. A horse knows exactly what a
  person's screen shows.
- It does nothing during the hourly freeze, and fails closed: a pass whose
  reads came back incomplete takes no action.
- Unknown refusals are reported and that horse waits 15 minutes. Known
  refusals wait by name: five seconds between spins, two hours for a daily
  limit, 30 minutes when the host cannot cover a prize.

`HORSE_DIAMOND_SPINS=false` turns the service off without a deploy.

## Proof, rolled back (CLAUDE.md 11.5)

The exact call sequence the driver sends was run through the live door for a
real horse (`93ecbb64-...` at Club JAQK). Each spin was in its own savepoint
and undone straight away, all inside self-aborting calls:

| Landed       | Played through the door                        | Result                      |
| ------------ | ---------------------------------------------- | --------------------------- |
| Chips        | spin                                           | 100 Diamonds in, chips paid |
| Plinko       | game commit, bonus start, 20 drops of 5        | paid 0.88 chips             |
| Crash        | game commit, bonus start at 1.70x, settle      | open on the server clock    |
| Donkey Cross | round limit read, start, two streets, cash out | cashed, paid 1.10 chips     |
| Mines        | round limit read, start, two tiles, cash out   | cashed, paid 0.90 chips     |
| Upgrade      | resolved to a Mines prize by the wheel         | played as Mines             |
| Diamonds     | card 2 turned                                  | 50 Diamonds back            |

Every game took the driver's arguments unchanged, and no call was refused for
a reason the driver did not plan. Inside one transaction a Crash round stays
open, because the server's clock does not move within it. Live, the driver
settles it on its next passes, a few seconds apart. Read afterwards: that
horse has no spin, prize, card, round or seed ticket on record.

## Tests

- `server/src/services/HorseDiamondSpins.test.ts`: who, how far, how much,
  bonus-game play, the order of steps, refusals (21 tests).
- `server/src/services/HorseDiamondSpinsDriver.test.ts`: the driver against a
  simulated wheel that refuses a spin behind an unplayed prize, as the real one
  does (7 tests).
- `server/src/services/aHorseSpinsThroughTheEngineDoor.law.test.ts` (law,
  `docs/laws.d/a-horse-spins-through-the-engine-door.md`).
- `HorseAdaptiveJournalBootstrap.test.ts` lists the new leader service.

## Live state at ship

No horse is out of chips today: the poorest active horse membership holds
about 3,400 chips. The service runs and finds nobody to spin for until one
goes broke.
