# A limit table that promised what it could not pay

Third pass of the game-creation audit. The cash side this time —
`TableConfigPage` and one engine function. Four controls wrote settings the
engine then ignored or mishandled, which is worse than a missing feature: the
owner advertises it and the players never see it.

Everything here was verified against **this** worktree at `origin/main` and
against the live schema. Several findings from the first sweep turned out to be
**already fixed upstream** and are listed at the bottom so nobody re-fixes them.

## 1. The 7-2 bounty was offered on four games that could never pay it

```ts
const SEVEN_DEUCE_VARIANTS = new Set(['nlh', 'nlhe', 'flh', 'limit_holdem', 'pineapple']);
```

The engine's gate is a string equality:

```ts
const sevenDeuceIsNlh = (this.tableInfo?.game_variant || 'nlh') === 'nlh';
```

So `nlhe`, `flh`, `limit_holdem` and `pineapple` all failed it. The toggle
rendered on a Fixed Limit Hold'em and a Pineapple table, wrote
`seven_deuce_enabled: true`, and the bounty was never paid. This is the same
shape as the PLO and short-deck removal the file already records — those were
taken out of the set and these four were left in.

The set is now exactly `['nlh']`. **FLH is a legitimate candidate** — it is
Hold'em and it has deuces — but making it pay is an engine change to a
settlement path with its own tests, not a set entry. Until someone makes that
change, the honest UI is the one that offers only what pays.

## 2. Straddle was offered on fixed-limit tables

`HandController` posts a straddle by assigning `state.currentBet = straddleAmount`
with no structure branch, while a legal fixed-limit wager for the same street is
exactly `fixedLimitBetSize(bigBlind, stage)`. A straddle is also none of
bet / raise / full-raise all-in, so `fixedLimitWagerCount` does not count it
against the four-wager cap — the street silently gains a betting round the cap
exists to prevent.

Hidden on limit tables, and `auto_utg_straddle` / `voluntary_straddle` /
`straddle_enabled` are forced false on the write, so a template saved on a
no-limit table cannot carry a stale `true` onto a limit one.

## 3. Cap was offered on fixed-limit tables

`ServerTableEngineTurns` assigns the mandatory fixed size and **then** clamps it:

```ts
amount = isFixedLimit ? flBetSize : Math.max(state.minRaise, amount);
...
amount = Math.min(amount, capRemaining);
```

A fixed-limit bet is legal only at exactly `flBetSize`, so a capped limit table
can emit an action the validator refuses. Hidden and forced off, same as
straddle.

## 4. A bomb pot could change the betting structure under the players

`ServerTableEngineDealing` says it plainly where it applies the override:
"Everything downstream — evaluator, hole-card count, **betting structure**,
horse equity, hand history — reads the HAND's variant". `resolveBombPotVariant`
checked the variant NAME against a whitelist and nothing else, so a `plo4` bomb
on a Fixed Limit Hold'em table dealt one **pot-limit** hand at a table every
seated player had sat down at for limit: pot-limit sizing, no four-wager cap, a
raise slider on a felt that has none. Nothing warned them and nothing in the
hand history explained it afterwards.

Fixed in the **engine**, not only the form, because that column can be written
by any writer: the override may not cross the fixed-limit line in either
direction. The no-limit ↔ pot-limit swap is untouched — an NLH table whose bombs
are PLO4 double boards is the classic bomb pot and stays exactly as it was. My
first attempt refused _any_ structure change and broke that classic; the pinned
test caught it, which is the test doing its job.

## Already fixed upstream — do not chase these again

The first sweep read the shared clone, which was 100+ commits behind
`origin/main`. All four of these are already correct:

- **Run It Multi-Times "None".** The page writes all three RIT columns from one
  expression (`run_it_twice`, `allow_run_it_twice`, `run_it_twice_enabled`), so
  the owner's choice is honoured. 900 of 973 live cash tables still carry
  `run_it_twice_enabled: false` beside `run_it_twice: true` — those rows predate
  the fix or came from another writer. **Whether to backfill them is Dan's
  call**, not an agent's: it would turn Run It Twice off on live tables whose
  owners may never have touched the control.
- **AutoStart above the seat cap.** Already clamped to `seatCap`, commented
  "NEVER ABOVE THE SEAT COUNT (2026-08-31 audit)". No live row violates it.
- **The generic save error.** Already surfaces `error.message`, so the DB
  guard's specific refusals reach the owner.
- **"Table created and started!"** Already reads "Table created. It is open in
  your club lobby." — the row is inserted `status: 'waiting'`.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/` — 475 files, 6,740 tests, all passing.
- `npx vitest run tests/ --exclude 'tests/unit/**'` — 235 files, 3,305 tests,
  all passing.
- `server`: `npx vitest run` — 269 files, 3,067 tests, all passing.
- One pinned assertion was deliberately updated in the same commit:
  `oneTableWriter.test.ts` matched the exact old `cap_bb` expression; it now
  asserts the rule including the `!limitGame` guard.

## New coverage

`tests/unit/fixedLimitTableOffersOnlyWhatItHonours.test.ts` — the seven-deuce
set is exactly what the engine settles on, and each of the three controls is
both hidden and forced off in the written row.

`server/src/engine/BombPotScheduler.test.ts` gains two cases: the fixed-limit
line is not crossed in either direction, and the classic no-limit-table /
pot-limit-bomb combination still works.
