# The six tournament detail tabs, read line by line

**Date:** 2026-08-29

`BlindsTab`, `TablesTab`, `UnionsTab`, `RewardsTab`, `SatellitesTab` and
`DetailOverviewTab` had been confirmed free of `.single()` and of TODO markers,
and never actually read for logic, wiring or accessibility. This is that read.
Every item below was live in production.

## The three worst

### 1. `BLIND_LEVEL_CHANGE` carries a display level. All three readers thought it was an index.

`TournamentTimerService.handleLevelChange` computes
`const displayLevel = newLevel + 1`, writes the raw 0-based `newLevel` to
`tournaments.current_level`, and emits **`displayLevel`** on the bus. Two units,
one name, undocumented — and each of the three consumers carried a comment
asserting the opposite ("TournamentTimerService writes one variable to both").
So did `tests/unit/currentLevelIsAnIndex.test.ts`, which is how the belief kept
being confirmed.

| Reader              | What it did                                     | Effect                                                                                                              |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TournamentDetails` | wrote the payload straight into `current_level` | corrupted the shared tournament object **every tab reads**, so the whole page ran a level ahead until the next poll |
| `TournamentClock`   | added one to an already-1-based number          | the projector clock in front of the room flashed **LEVEL 7** on the way into level 6                                |
| `BlindsTab`         | indexed the structure with it                   | next level's blinds, next level's duration, and the level after that advertised as "Next"                           |

All three only misbehave between an advance and the next poll, which is why
three separate people read it as flicker rather than as one bug. The
2026-08-26 fix to `TournamentClock` is instructive: it turned a clock that
flashed one level _backwards_ into one that flashed one level _forwards_. Same
shape, other direction — indistinguishable from a fix if you only saw it once.

The contract is now on the payload type in `src/core/MasterBus.ts`, where a
reader finds it without tracing the emitter.

### 2. The satellite mapper read five columns that do not exist

Duplicated byte for byte in `SatellitesTab` and `DetailOverviewTab`, so every
bug shipped twice:

| Read                        | Reality                                        | Consequence                                                                |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `sat.guarantee`             | column is `guaranteed_prize`                   | **every satellite card ever rendered showed a prize pool of 0**            |
| `sat.buy_in`                | stored split as `buy_in_amount` + `buy_in_fee` | **and a buy-in of 0**                                                      |
| `sat.blind_duration`        | no such column                                 | no speed badge, ever                                                       |
| `sat.is_satellite`          | no such column                                 | the type test was always false                                             |
| `blindStructure: 'regular'` | hardcoded                                      | every satellite claimed to be regular speed; the card _prints_ this string |

`buy_in` and `is_satellite` were not found by reading. They were found by a test
case that checks every selected column against
`scripts/ci/supabase-columns-manifest.json` — written for the first three, and
it immediately caught two more that I had carried forward into the rewrite by
hand. A column name that looks right is not a column.

Also fixed in the same rewrite (`src/components/tournament/details/useSatellites.ts`,
now the single source for both surfaces):

- `if (!tournament?.id) return;` sat before the `try/finally` with `loading`
  initialised `true`, so a tournament with no id showed **"Loading
  Satellites..." for ever**;
- `select('*')` pulled 100+ columns per row for a card that renders fifteen;
- **N+1**: each card ran its own `tournament_players` lookup, so ten satellites
  cost eleven round trips while the parent held the viewer's id the whole time.
  One `.in()` query answers all of them and the card takes the answer via a new
  `knownRegistration` prop. `null` means the batch failed, which is _not_ "not
  registered" — the card falls back to its own lookup rather than render a live
  Register button at someone already in (the 2026-08-25 rule);
- the mapper ran inside `.map()` in the JSX, handing every `memo`-wrapped card a
  fresh object on every parent render — and the Detail tab re-renders **once a
  second**;
- no retry on error;
- none of `late_reg_levels` / `late_reg_mins` were passed, so `hasLateReg` was
  always false and **no satellite card has ever shown a late-registration
  countdown**, though `select('*')` had already paid to fetch them.

### 3. RewardsTab could not see its own query failures

```ts
const [live, claimed] = await Promise.all([...]);
setLedger({ liveHeads: (live.data || []).map(...), ..., loaded: true });
```

A Supabase query builder **resolves** with `{data: null, error}` — it does not
reject. Only `.data` was destructured, so the `catch` below could never fire for
a query error: an RLS denial coalesced to `[]`, set `loaded: true`, and rendered
**"The Bounty Pool Is Not Funded Yet"** as a confident factual statement about a
funded pool, with nothing in Sentry.

Both queries were also unbounded, which is not unlimited: PostgREST caps at
1,000 rows silently. This tab's own header cites 9,011 and 6,790 rows, and the
branch these arrays serve is exactly the one where the totals are derived from
the heads themselves.

Now paged via `.range()`, throwing on `error`, with a `failed` flag so a read
failure renders as a read failure.

## The rest

**UnionsTab** — the entrant query had the same silent 1,000-row cap; past that,
players fell through to the membership-inference path and were labelled "By
Membership" though their entered club id existed and had simply not been
fetched. Now paged. A failed `unions` name lookup was the one error path in the
file that did not call `reportError`; it does now. And `candidateClubIds` was
seeded from every `tournament_players` row rather than from the entrants, so a
re-entry event fetched clubs for players the tab will never render.

**DetailOverviewTab** —
`backgroundColor: 'var(--surface)'` on both Band 4 panels referenced a token
that **is defined nowhere in this repo**, so they had no background and the
wrapper's `rgba(255,255,255,0.05)` — meant to show through a 1px gap as a
hairline — washed the whole band. `style={{ padding: 0 }}` on the panel beat
`.dov-info`'s own padding _and_ its `@media (max-width: 400px)` override, so the
band's phone tuning was dead, and a hardcoded `padding: 16` replaced the 9px
phones were meant to get. All nine inline style objects are in the stylesheet
now, where a media query can reach them. The empty state read "NO SATELITTES
AVAILABLE FOR THIS TOURNAMENT" — two misspellings, shouted, against the Title
Case rule the file follows everywhere else — and there was no error branch at
all, so a failed fetch rendered the empty state and told the player as fact that
the event has no satellites.

The final-table deal panel had **two definitions of "still in" on one screen**:
`field.alive` counts with the shared `isPlayerLive`, while the vote button
tested `status === 'playing'`. A player at a final table with status
`registered` was inside the denominator — their vote counted towards unanimity —
but had no button to cast it with, so the deal could never pass. And the
15-second vote poll was gated on `final_table_deal_enabled && isRunning` while
the panel additionally needs one table left, so a 500-runner event polled from
level one for hours for a number nothing was reading. It now waits, drops
responses a newer request has overtaken, and reports its errors instead of
leaving "0/6 Votes" standing as fact.

**BlindsTab** — the one-second tick had an empty dependency array and no status
check, so a COMPLETED event re-rendered the tab once a second for ever to
recompute figures it does not render. `tournamentEventBridge` emits
`TOURNAMENT_BREAK` and `BREAK_START` from the same branch and both are
subscribed, so the break handler ran twice and its
`Date.now() + minutes` fallback computed a different end time on the second
call; it keeps the first answer now. And 3,079 production rows have
`current_level` past the last published level, where clamping alone printed the
last published blinds and the words "Final Level" as though that were what is
being dealt — it says "Past The Published Structure" instead.

**TablesTab** — `key={line.table.id}` on a list that explicitly handles a table
with no id, so two such rows collided on `undefined`.
`seatCountIsFallback` was computed, stored on every line and documented in the
interface, and read by nothing: a count taken from a possibly-stale
`tables.current_players` looked identical to one derived from live entries. It
is labelled "Reported" now. Unused `TournamentEntry` import removed.

**Accessibility** — five bare `tl-meter` divs across the six tabs had no `role`,
no `aria-value*` and were not hidden either, so a screen reader announced an
empty group. Each duplicates a figure printed right beside it, so they are
`aria-hidden` rather than given a second voice for the same number.

## Tests

`tests/unit/tournamentDetailTabFixes.test.ts`, 37 cases, one per bug.

`tests/unit/currentLevelIsAnIndex.test.ts` **required the wrong behaviour** and
is corrected in this commit, per the rule that a test pinning behaviour you
replace is updated alongside it. Its header stated the false premise that
started all of this, and its `TournamentClock` case asserted the `+ 1`. Both
fixed, and a case added for the third consumer it never covered.

Full suite: 564 files / 8,690 passing. `npx tsc --noEmit` exit 0.

## Not done

- `TablesTab`'s `React.memo` is defeated: `lines` is rebuilt from `entries` on
  every chip tick, so all rows re-render. No pagination on a 200-table event
  either.
- `DetailOverviewTab`'s `level` memo calls `getCurrentLevelState()`, which
  re-parses `blind_structure` from JSON **every second**.
- `UnionsTab` reloads its whole 4-to-16-query sweep on every new registration,
  because `entrantKey` changes.
- The Spin level-duration disagreement between `level.remaining` (from the
  service, which falls back to a hardcoded 10 minutes) and `level.duration`
  (normalised by the page) is real and untouched: on a Spin storing
  `duration: 180` the hero meter reads −233%, clamps to 0, and sits empty for
  seven minutes of a three-minute level.
