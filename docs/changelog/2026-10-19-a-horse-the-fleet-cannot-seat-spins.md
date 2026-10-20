# A horse the fleet cannot seat spins its Diamonds, and the spins have a reader

**Owner request (Dan, 2026-10-18).** "A horse with no chips left grinds the
Diamond Arena and uses its Diamonds on Diamond Spins to convert to chips."
Phase 3 built the door and Phase 4 the engine service that uses it
(`2026-10-19-a-horse-with-no-chips-spins-its-diamonds-into-chips.md`). This
is Phase 5. It closes the gap Phase 4 left in who spins, and gives the service
a reader.

## What was wrong

**1. A gap between "too poor to be seated" and "poor enough to spin."**
Phase 4 started a horse spinning below one buy-in of the cheapest open game
(HorseBankroll rule 7 as written: 4.00 at today's 0.05/0.10 game). The fleet
stops seating a horse much earlier than that. It needs 12 to 40 buy-ins behind
the horse, depending on temperament: 200 chips for a gambler, 250 for a
standard horse and 400 for a nit at that game. `bestAffordableGame` answers
null for such a horse (the code's own "broke path"), and the fleet counts it
in its `ladder_exhausted` gauge. So a gambler holding 150 chips was refused
every seat and never spun. It waited on freerolls and rakeback with Diamonds
in its pocket.

**2. A wallet is not the whole roll.** The wallet does not include chips a
horse has on a cash table, which come back when it stands up. Counting the
wallet alone would start a seated horse spinning while it still held a full
roll on the felt.

**3. No reader (CLAUDE.md 10.83).** The service's figures (horses in session,
spins, refusals, errors) lived in memory. The only thing anyone could see was
one log line at start-up.

## What changed

- **Who spins.** A horse spins when the fleet cannot seat it at the cheapest
  open game: its roll is under the seat bar. The roll is its club wallet plus
  the chips it has on open cash seats paid from that wallet. Tournament stacks
  are not counted (they are tournament chips), and neither are Diamond Arena
  or Lightning seats (another wallet). `HorseDiamondSpins.cannotBeSeated`
  replaces `isOutOfChips`. It spins up to that same bar, as before.
- **The two-hour "spun recently" window is gone.** It existed only to keep a
  horse spinning between one buy-in and its target. The new trigger covers
  that range directly, and one database read per roster goes with it.
- **The reader.** `horseDiamondSpins` on the engine's `/health` carries:
  - the cheapest game measured against;
  - `cannotBeSeated`: horse wallets the fleet cannot seat;
  - `cannotSpinNoDiamonds`: those with no Diamonds above the 10,000 reserve,
    who wait on the Diamond Arena, freerolls and rakeback;
  - horses in session;
  - every spin, bonus game, move, card, refusal by name and error since start.

  Like the journal section beside it, it is added to a copy of the body and
  never moves the HTTP code Caddy routes on. The certificate line stays
  byte-identical.

## Tests

- `HorseDiamondSpins.test.ts`: the bar per temperament. A gambler at 150 or
  199.99 chips spins; at 200 it does not.
- `HorseDiamondSpinsDriver.test.ts`:
  - a horse with 48 buy-ins but under its bar spins, and takes the entry the
    gap needs, not the biggest;
  - a seated horse whose felt covers the bar does not spin;
  - a horse the fleet can seat is left alone;
  - a horse under the bar with only its reserve is counted in
    `cannotSpinNoDiamonds` and does not spin.
- `handlers/health.test.ts`: the section rides on the body and never changes
  the status code.
- `aHorseSpinsThroughTheEngineDoor.law.test.ts` now also pins the reader and
  the trigger.

## Live state at ship

Every active horse membership at JAQK, Shark Club and Deep Stack Society
holds more than 3,000 chips, so none is under its bar today. The engine's
`ladder_exhausted` gauge read 26 at the same time. That gauge counts every
wallet the fleet reads, and the only horse wallets under 400 chips that are
not departed accounts are the Lightning Internal Pilot's 72 (27 to 206 chips),
which this service does not serve. The 62 horse memberships per club at 0 chips are
departed (deleted) accounts, which the wheel rightly refuses.
