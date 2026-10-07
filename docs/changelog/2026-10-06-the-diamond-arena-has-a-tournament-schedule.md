# The Diamond Arena has a tournament schedule

2026-10-06. Migration `20261006090619_the_diamond_arena_has_a_tournament_schedule`.

## What a player sees

The Diamond Arena's tournament lobby was empty. Tournaments were open (`tournaments_enabled` true), but the arena had no schedule and no event. It now has four daily events, modelled on Midway Union's own board and priced in whole Diamonds:

| Event                           | Starts (UTC, daily) | Total | Prize side + fee | Bounty             | Stack / blinds      |
| ------------------------------- | ------------------- | ----- | ---------------- | ------------------ | ------------------- |
| Diamond Bounty Hunt 1000        | 01:00               | 1,000 | 900 + 100        | 225 fixed knockout | 18,000 / standard   |
| Diamond Progressive Bounty 2000 | 03:00               | 2,000 | 1,800 + 200      | 900 progressive    | 22,000 / turbo      |
| Diamond Daily Turbo 300         | 14:00               | 300   | 270 + 30         | none               | 12,000 / turbo      |
| Diamond Daily Deep Stack 500    | 20:00               | 500   | 450 + 50         | none               | 30,000 / deep stack |

No event carries a guarantee, and each one says "No Guarantee". Every total is 200 or more, so the spawner publishes each event six days ahead, the same rule it uses for a chip event of 200 or more. The lobby holds about six of each at once.

## What it leaves out, and why

- **A guarantee.** The Diamond door refuses one (`diamond_tournament_format_not_open`, `diamond_guarantee_has_no_chip_bank`) until the guarantee destination is built.
- **A freeroll.** The door refuses a buy-in below one Diamond. The recorded answer admits a Diamond freeroll only together with its guarantee, because its prize is the guarantee. Through the spawner it would become a one-Diamond rebuy and add-on event that the recorded answers say does not exist. It waits for the guarantee door. This is recorded in `docs/DIAMOND-RULINGS.md` as decided by Claude on Dan's delegation.
- **A satellite or a Spin.** A Diamond satellite seat cannot be settled (`diamond_satellite_is_never_settled_on_chip_rails`), and a Spin has no scheduled time.

## How it was proved before it was applied

`docs/evidence/diamond-arena-schedule/one-spawn-cycle-rehearsal.sql` ran on production through `rehearse.sh`, in one transaction that was rolled back. It ran one whole spawn cycle the way `ScheduledTournamentService` runs it, with the exact rows `buildInsertRow` writes for these configs, generated from the real code, as `service_role`, through every live trigger: 24 events, six of each, every one admitted. Every event is the arena's own (no union) and is recognised as a Diamond event at the whole-Diamond unit. It is REGISTERING in the future and priced at exactly the advertised total, with the fee exactly 10% rounded down. Its bounty is whole and within the buy-in. It has no guarantee, no free buy, no rebuy and no add-on, so the house can never owe on it. The real Diamond creation door, `fn_poker_diamond_create_tournament`, was then asked for each event and admitted it at the same buy-in, fee, bounty, guarantee and unit. The same door refused the zero buy-in freeroll by name.

The engine's spawner writes these rows itself as `service_role`. It does not call the staff door. That is why the proof compares the rows with the door's rather than assuming they match.

## The file

Four `tournament_schedules` rows, `union_id` NULL, `horsesToRegister` 0 set explicitly so horses join the way people do and are never pre-seated. The file inserts nothing else and moves no switch. Its post-image proves both arena switches still hold what its pre-image read, so it applies whichever state the cash switch is in. Live proof: the four rows, read back by name.
