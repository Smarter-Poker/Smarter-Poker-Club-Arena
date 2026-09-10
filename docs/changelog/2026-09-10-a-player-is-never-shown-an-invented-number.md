# A player is never shown an invented number (audit CL-1, CL-38)

**Branch:** `fix/no-fabricated-data-and-no-dead-code`
**Law:** `tests/a-player-is-never-shown-an-invented-number.law.test.ts`

## What was wrong

`src/components/table/SessionAnalytics.tsx`, mounted by `TableModalsLayer`
behind the "Detailed Analytics" button on the in-game stats card, showed a
player a four-tab record of their own session. One tab (Overview) read
`SessionStatsService`. The other three were invented on every open:

| tab       | what it showed                                  | where the number came from                                                                                         |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Positions | hands played per position                       | `handsPlayed / 7 + random(3)`                                                                                      |
| Positions | hands won and win rate per position             | `hands x (0.2 + random x 0.3)`                                                                                     |
| Positions | net chips per position                          | `round((random - 0.45) x profitLoss / 7)` - does not sum to the session P&L, can show a winning position as losing |
| Actions   | fold / call / raise / all-in frequencies        | pure `Math.random()` with an empty dependency array                                                                |
| Pots      | five "biggest pots", won or lost, with hand ids | `500 + random x 3000`, coin flip, `Date.now()`                                                                     |

`src/components/replay/SessionReplay.tsx` carried a second generator,
`generateMockActions`: 50 hand actions with random types, random `Player1..6`
names and random amounts. Nothing imported the component, but the generator
was live code one import away from rendering invented hand history as a
replay.

## What changed

- `SessionAnalytics` now renders only what `SessionStatsService` records:
  session P&L, BB won, the stack trajectory sparkline, hands, hands won,
  hands per hour, VPIP, PFR and BB/100. The three invented tabs and the tab
  strip are gone, and so is their CSS. The service does not record the hero's
  position or per-street actions, so there is no honest per-position or
  per-action view to show; the panel does not pretend otherwise. If those are
  wanted, `recordHand` has to be given the position and the hero's actions
  first, and the views come back fed from that record.
- `SessionReplay.tsx` and `SessionReplay.css` are deleted. Zero importers,
  and the only thing distinctive about the file was the generator.

## The law

`tests/a-player-is-never-shown-an-invented-number.law.test.ts`:

1. A file under `src/components` or `src/pages` may call `Math.random()`
   only if it is on the test's allowlist with one of four non-data reasons:
   animation geometry, a client-side identifier, retry jitter, or a pick the
   player asked for. Twenty-six files are listed, each with its reason.
2. The allowlist has no ghosts: a listed file must exist and must still call
   `Math.random()`.
3. No render surface carries a sample-data generator or a mock / fake / dummy
   data constant (`generateMock*`, `mockData*`, `MOCK_*`, and so on). A
   component with no real data renders an honest empty or unavailable state.
4. `SessionAnalytics` imports `SessionStatsService`, contains no
   `Math.random()` or `Date.now()`, none of the three old tab names, and is
   still mounted by `TableModalsLayer`. `SessionReplay` stays deleted.

## Verification

- `npx vitest run tests/a-player-is-never-shown-an-invented-number.law.test.ts tests/law-registry.law.test.ts`: green.
- `npx tsc --noEmit -p tsconfig.app.json`: clean.
