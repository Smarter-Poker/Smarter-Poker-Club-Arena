# A Tournament Is Capped By The Deck, Not By The Cash Seat Law

2026-08-31

## What was wrong

`TournamentManagerBase.createTablesAndSeatPlayers` and
`TournamentManager.ensureLateRegSeated` both finished their seat-count
calculation with `clampSeatsForVariant(...)` — the CASH seat law. It was
applied LAST, after every format branch, so it won over spin, sng and
`table_size` alike.

That module says so itself, in its own header:

> Maximum seats per game variant — the house law. CASH GAMES ONLY.
> ... Nothing here may be applied to a table with a tournament_id.

And the client copy carries Dan verbatim:

> "WHAT I GAVE YOU WAS FOR CASH GAMES ONLY, YOU CAN NOT RUN IT TWO OR THREE
> TIMES IN A TOURNAMENT"

The cash cap is deliberately tighter than the deck so Run It Twice keeps three
boards to come out of. PLO6 dies at 7 seats by that rule — `52 - 6n >= 15`
gives `n <= 6` — which is exactly why the cash cap is 6. Run It Twice is
hard-disabled on a tournament table (`ServerTableEngineBase`: `ritIsTournament`
forces `ritEnabled` false), so a tournament was paying for a board it can never
be dealt.

## What it is now

The ceiling is the deck and only the deck:
`floor((deckSize - 5) / holeCards)`.

    nlh / flh 23   short_deck 15   pineapple 15
    plo4 / plo8 / flo8 11   plo5 9   plo6 7

Reused, not copied: the tournament paths import `maxSeatsFor` from
`server/src/engine/VariantRules.ts`, the same module the DEAL path reads its
hole-card counts from. The formula already existed twice (there, and
`maxSeatsTheDeckAllows` in `src/config/tableSeating.ts`, which the browser
bundle needs because it cannot import from `server/`). A third copy would be a
third thing to keep in step.

`clampSeatsForVariant` is no longer imported by either tournament file, so the
cash law is now unreachable from a tournament path rather than merely unused.

## Live effect

| Variant | Tournaments | Seats before | Seats after |
| ------- | ----------: | -----------: | ----------: |
| plo4    |      12,193 |            8 |           9 |
| plo5    |       5,967 |            7 |           9 |
| plo6    |       5,000 |            6 |           7 |
| plo8    |          61 |            8 |           9 |

(The "after" column is the requested `table_size` finally being honoured, not
the deck ceiling itself — the deck allows more than that in every row.) NLH is
unaffected today, but a `table_size` 10 NLH MTT had been losing its tenth seat
to `DEFAULT_MAX_SEATS = 9` and now keeps it.

## What did NOT change

- The CASH seat law. `MAX_SEATS_BY_VARIANT` is untouched in both copies, PLO6
  cash stays 6-max, and `ritHeadroom('plo6') === 1` still holds.
  `scripts/ci/check-seat-law-parity.mjs` passes unchanged.
- `tests/table-seating-caps.test.ts` — the pin on the cash law — was not
  touched.

## Tests

- `server/src/tournament/DeckCapacity.guard.test.ts`: the three assertions that
  pinned `clampSeatsForVariant` into the tournament paths now pin the deck
  function instead. The ORDERING assertion is kept exactly as it was — the
  ceiling must still be applied last, or `table_size` wins. Added: PLO6 seats 7,
  PLO5 seats 9, no tournament ever seats past its deck at any request 2..30,
  the deck ceiling is never tighter than the cash cap, and neither tournament
  file may import `config/tableSeating` again.
- `tests/unit/variantSeatingAndTournamentKeys.test.ts`: the root vitest config
  can import server modules, so the client's `maxSeatsTheDeckAllows` and the
  server's `maxSeatsFor` are now pinned against each other — the deck-ceiling
  equivalent of the CI parity gate that covers the cash law.
