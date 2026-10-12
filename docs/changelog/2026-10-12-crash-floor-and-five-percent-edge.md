# Diamond Crash: never before 1.25x, up to 20x, 95 percent back (2026-10-12)

## What Dan asked for

> "CRASH ALWAYS CRASHES TOO SOON. THE GAME IS DESIGNED TO GO TO 20X MAX. THE
> GAME SHOULD NEVER CRASH BEFORE 1.25X AND NEEDS TO LAST A LITTLE LONGER ON
> AVERAGE."
>
> "CRASH CAN BE A 5% HOUSE EDGE GAME. MAKE IT BETTER OVERALL FOR THE PLAYERS."
>
> "BUT CRASH NEEDS TO BE ABLE TO GO AS HIGH AS 20X. MAKE SURE THAT PLAYERS ARE
> AWARE THAT THE 'AVERAGE CRASH' IS BETWEEN 2.4 - 3.0X AND IF THEY 'BOOK THE
> WIN' OR STOP BEFORE IT CRASHES, IT SHOULD SHOW HOW FAR 'IT WOULD OF GONE'."

## What changed for the player

New Crash rounds are sealed under contract 5 (`payout_version` 5):

|                                             | Contract 4 (until now) | Contract 5 (new rounds) |
| ------------------------------------------- | ---------------------- | ----------------------- |
| Lowest crash point                          | 1.10x                  | 1.25x                   |
| Cash out opens                              | 1.11x                  | 1.26x                   |
| Paid back at every cash-out target          | 80% of the stake       | 95% of the stake        |
| Cap                                         | 20x to 25x             | 20x for every flight    |
| Climb                                       | 20x in about 30 s      | 20x in about 37 s       |
| Average crash, standard award               | 2.14x                  | 2.72x                   |
| Average crash, Super award with the add-on  | lower                  | 2.24x                   |
| Rounds ending at the floor (standard award) | about 1 in 2           | about 2 in 5            |

The loss minimum is unchanged: half the stake, or for a Super award what the
player paid.

On the Crash page the readout now says the average crash of the round on the
table before Start and while it climbs ("Average Crash 2.7x"), computed from
that round's own stake, minimum, contract and cap. A Super award with the
add-on keeps two thirds of its stake on a loss and pays for that out of the
odds, so it honestly shows 2.2x. After a booked win the readout and the receipt
say "It Would Have Crashed At 4.37x", or "It Would Have Flown All The Way To The
20.00x Max". The sealed point still only reaches the browser once the round is
settled. The lobby shows "Average Crash" beside the instant-crash odds.

## The money

- Crash at 95 percent: the value of always cashing at any hundredth from 1.26x
  to 20x is at most 0.95 of the stake and within one roll's grain of it, proved
  in integers for every hundredth on every stake kind
  (`tests/the-games-never-pay-more-than-they-take-in.law.test.ts` item 8c, and
  the migration's own readback).
- Every other game still returns 80 percent.
- The wheel still draws at exactly 80 percent, but a Crash award is now worth
  more when played, so the wheel's real long-run payback rises from 80.00 to
  81.85 percent (0.8 + 0.15 x 0.1235). The house keeps 18.15 percent, and no
  spin's expected value after any prize reaches its entry.
- No reservation or cap had to move. The wheel already reserves 40x of an
  ordinary base and 30x of a Super base, which is 20x of the largest stake
  either can be played at. A Crash round reserves bet x 20x, and its 95 percent
  return is well inside that. A wheel-funded flight that could not cover 20x
  would now be refused rather than shortened. In production every live Crash
  award covers it, so this never happens on the normal path.
- The only path that can still cap a flight below 20x is a Crash round started
  with no wheel award (only possible if the wheel's release switch is turned
  off): it is capped by cap_fraction of that pool's headroom, as before.

## Release order

1. Publish the client (it reads contracts 4 and 5 and prices every figure by
   the version the server states, so it is correct before and after).
2. Then apply `20261012052305_crash_never_ends_before_1_25x_flies_to_20x_and_pays_back_95_.sql`
   once, outside the :50 to :03 break window.

The other order breaks Crash: the old client refuses a contract-5 quote and
receipt as unknown.

## Verified

- Full `scripts/dev/test-accounting-delivery.sh` on PostgreSQL 17: all 35
  probes pass, including the new `tests/sql/diamond-crash-contract-five.sql`
  (four real wheel award kinds, 1.25x auto target and 1.25x cash-out refused,
  20x cap sealed, the point revealed only on settlement and paid once, a
  contract-4 round keeps 1.10x and 1.11x).
- 4,000 contract-5 crash points computed by PostgreSQL 17 for the same 1,000
  production rolls match the browser mirror exactly
  (`tests/fixtures/diamond-spins/crash-point-postgres-rolls.json`, `v5_cents`).
- Nothing was applied to production.
