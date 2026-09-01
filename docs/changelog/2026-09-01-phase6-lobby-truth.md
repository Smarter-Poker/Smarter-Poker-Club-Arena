# Phase 6 items 1 and 8 - the lobby stops saying things that are not true

2026-09-01. Branch `phase6/lobby-truth`.

## Item 1 - every Spin card said "300 chips / Turbo"

`tournaments.starting_chips` is **seeded at 300** by the recycler and rewritten
to the drawn tier's stack at draw time. Every lobby surface read the raw
column:

- `arenaGameCardAdapter` printed it as the starting stack;
- `stackDepthLabel` derived Turbo / Standard / Deepstack from it.

**12.6% of games actually deal 1,000 or 5,000.** A 100x is 5,000 chips at 250
big blinds - the opposite of Turbo - and a seated player then watched their
stack jump from 300 with nothing explaining it.

Before the wheel turns the honest answer is the RANGE, and it now comes from
`spinStartingStackRange()`, computed from the same `SPIN_TIERS` table the draw
itself uses rather than from a hardcoded pair. After the draw, the column is
the truth and is read exactly as before.

A depth label derived from a placeholder is worse than no label, so
`stackDepthLabel` returns null for an undrawn Spin and the card falls back to
the speed label it already has. The reveal test is `spinMultiplierRevealed`,
the convention this repo already uses for "is a Spin's outcome known yet".

## Item 8 - "Play Again" could land you on a full table

The sibling lookup filtered on status, club, stake, game and class - and not on
capacity. Every other surface goes through `seatFirstJoinable`, whose entire
job is `players >= capacity`.

Spins fill in seconds, so the most likely sibling of the game you just finished
is one that filled while you were watching the podium. The button walked the
player into "That Seat Was Just Taken".

Now it selects `current_players, max_players`, takes eight candidates instead
of one, and picks the first that has room. Capacity is applied in JS rather
than in the query so a row with a null or absent max is treated as joinable
rather than silently dropped - the same forgiving reading `seatFirstJoinable`
takes. The club and stake scoping that PR #1702 made law after an unscoped hop
nearly seated a player in a stranger's club is untouched, and pinned.

Its fallback was `/tournaments?type=spin`. `TournamentPage` reads
`useParams()` only and its filter state is `'all' | 'freeroll' | 'micro' |
'highroller'`, so that query string was carried for nobody. It now navigates to
the list the player can actually use.

## Verification

- `npx tsc --noEmit`: clean.
- `a-card-never-states-a-stack-it-has-not-drawn` (3) and
  `play-again-never-lands-on-a-full-table` (5): 8 tests, green, both registered
  in `docs/LAWS.md`.
- The first law asserts the range is derived from `SPIN_TIERS` rather than
  written down, so a new tier cannot silently fall outside the advertised range.
