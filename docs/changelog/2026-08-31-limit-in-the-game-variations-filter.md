# Limit poker in the game variations filter

**Dan, 2026-08-31, with a screenshot of the Heads Up tab:**
_"LIMIT POKER NEEDS TO BE ADDED TO THE GAME VARIATIONS FILTER."_

That tab's Games row read `NLH | PLO 4c | PLO 5c | PLO 6c | 6+`. It now reads
`NLH | PLO 4c | PLO 5c | PLO 6c | PLO Hi/Lo | 6+ | FLH | FLO8`.

## Why a chip on its own would have been a bug

`advancedFilterSpec` records three separate times that **a chip whose key
nothing can produce empties the tab when it is ticked**. An FLH chip and an
"OMAHA High" chip were both deleted for exactly that. Limit tournaments did not
exist — `canRunAsTournament('flh')` returned false — so a Limit chip on the
Heads Up tab would have been the fourth instance of the same defect, shipped
deliberately.

So limit had to become a game a tournament can _be_ first.

## Why the old exclusion was wrong

The note in `tournamentFromTableConfig` said limit "raises stakes on a bet-size
ladder, and every blind structure here is a no-limit/pot-limit blind ladder.
Offering them would deal limit and escalate it like no-limit."

The engine it was describing disagrees:

- `fixedLimitBetSize(bigBlind, stage)` derives the whole bet ladder **from the
  big blind** — small bet = BB preflop and flop, big bet = 2x BB on turn and
  river (`server/src/engine/BettingStructure.ts`). There is no second ladder to
  author.
- `TournamentManagerBase` rewrites `tables.small_blind` / `big_blind` on every
  level change, so the limits escalate with the level automatically and exactly.
- A blind ladder **is** a limit ladder in fixed-limit poker: a level posting
  50/100 is a 100/200 limit game. That is the convention `BettingStructure`'s own
  header documents and `stakesLabel()` already prints.

Everything else was already built: the fixed-limit betting rules, the wager cap,
the client `ActionPanel` fixed-limit branch, the horse action path
(`ServerTableEngineTurns` `horseFlBetSize` / `isFixedLimitCapped`), the seat
caps, the rake schedule and the BBJ qualifying hands. The only thing missing was
permission.

## What changed

**New: `src/config/tournamentVariants.ts`** — one catalogue, read by everything.

The variant map moved out of `lib/tournamentFromTableConfig` (which imports
PayoutEngine and the blind ladders) so the lobby's filter spec can read the same
list without dragging the tournament-building graph into a module whose header
insists it is pure data. `canRunAsTournament` is re-exported from its old home,
so `TableConfigPage` and the tests keep their import path.

- `flh` and `flo8` added to the catalogue.
- The Games rows on **MTT**, **Heads Up** and **Spins** are now _derived_ from
  it. Adding a variant is one map entry and the chip follows.

**Three defects the derivation exposed and fixed:**

1. **Heads Up had no PLO Hi/Lo chip** while a PLO8 Sit & Go was creatable — the
   documented reverse defect ("a producible variant with no chip is deleted the
   moment a player ticks any other chip"). Now present.
2. **`TournamentConfig.gameVariant` omitted `PLO6`** while 6,028 PLO6
   tournaments were live and `buildTournamentConfig` was already emitting
   `'PLO6'`. It compiled only because that function ends in `as TournamentConfig`.
   The union is now the same type the map is keyed to.
3. **`CreateTournamentModal` could not create PLO6 at all**, and offered PLO8 and
   Short Deck for the **Spin** format — games the spin catalogue does not sell
   and the Spins board has no chip for. The dropdown is derived now, and narrows
   to `SPIN_GAME_TYPES` when the format is a Spin.

**The spin catalogue is enforced where spins are authored.** `SPIN_GAME_TYPES`
advertises four games; nothing stopped the create-table form building a Short
Deck or PLO8 Spin. The "3 Players (Spins)" option is hidden outside the
catalogue, and `buildTournamentConfig` independently downgrades such a config to
a plain three-handed Sit & Go — the same game, sold as what it is — for a
restored draft or a saved template that carries `isSpins: true` past the screen.

**`TOURNEY_VARIANT_KEYS` learnt `FLH` / `FLO8`** (plus the legacy
`LIMIT_HOLDEM` / `LIMIT_OMAHA` spellings). Without them `variantDisplay` falls
through to its raw-enum fallback and prints `"FLH"` as _both_ the short and the
long label — the identical defect that map already records for `OFC_PINEAPPLE`.

## Two pinned assertions were deliberately reversed

CLAUDE.md rule 8 says a test that pins replaced behaviour is updated in the same
commit, not left for someone else:

- `tests/unit/TournamentFromTableConfig.test.ts` — `canRunAsTournament('flh')`
  and `('flo8')` were pinned `false`.
- `tests/unit/variantSeatingAndTournamentKeys.test.ts` — same pair.

Both now assert `true`, each with the reasoning above written beside it, and
`pineapple` stays pinned `false` (its discard street still has no tournament
timing path).

## New coverage

`tests/unit/limitInGameVariations.test.ts` pins Dan's ask **and** the invariant
that keeps it honest, in both directions:

- every chip on MTT / Heads Up is a game a tournament can be;
- every game a tournament can be has a chip on both tabs;
- the Spins row is exactly the spin catalogue;
- no chip label is missing or leaking its raw key.

The invariant is the valuable half. It fails for a variant added with no chip
and for a chip with no variant, forever, in either direction.

`tests/unit/TournamentFromTableConfig.test.ts` gains a `spin catalogue` block
covering the independent downgrade.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/` — 472 files, 6,711 tests, all passing.
- `npx vitest run tests/ --exclude 'tests/unit/**'` — 235 files, 3,305 tests, all
  passing.
- `tsc -b && vite build` — built in 17.19s. The post-build asset chain
  (`optimize-dist-media`, which installs sharp on demand) was cut off by the
  session shell rather than by an error; CI's Production Build check runs it end
  to end.

## Not changed, on purpose

- **Pineapple stays out of tournaments.** Its discard street has no tournament
  timing path and no PINEAPPLE tournament has ever been played. The MTT tab keeps
  a `pineapple` chip because one legacy `OFC_PINEAPPLE` row is live and would
  otherwise be deleted from the board by any other chip.
- **The MTT tab still says OMAHA where the other tabs say PLO.** That wording
  predates this change and is preserved as a label override rather than quietly
  normalised by the refactor that derived the row.
