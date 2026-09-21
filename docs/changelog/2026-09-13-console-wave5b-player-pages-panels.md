# 2026-09-13 - #ClubArenaConsole wave 5b: player pages and panels

Batch b5 of the console sweep. Fourteen generic surfaces rebuilt on Dan's
approved spade master (`src/components/console/SpadeConsole`), rendered
before and after at 393px with the harness in
`.claude/skills/club-arena-console/harness/`. Nothing in the shared kit
(`SpadeConsole.*`, `metallic-popups.css`, `utils/format.ts`) was touched.

## Surfaces

| Surface                                            | Chassis                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pages/ReportPlayerPage`                           | one console, Cancel / Submit Report on the plates; success state flat cap + lit word    |
| `pages/SimPage`                                    | stepper console (Prev / Next plates, Reset a lit word) + event-log console; felt kept   |
| `pages/BadBeatJackpotPage`                         | club-buttons hero kept; The Pools, Jackpot Rules (BBJRulesPanel) and Winners consoles   |
| `components/bbj/BBJRulesPanel`                     | own console; the three pages are lit words; tables print between engraved rules         |
| `components/bbj/BBJBasicPanel`                     | rows on the BBJInfoModal console's glass (no frame of its own)                          |
| `components/bbj/BBJQualifyingHands`                | rows on the glass, real card art kept                                                   |
| `components/bbj/BBJRecentHits`                     | rows on the glass; Show More a lit word; avatar sizes pinned in px kept                 |
| `components/leaderboard/LeaderboardSettlementCard` | console per state; the state word in the pill slot; 0-2 actions as lit words            |
| `components/leaderboard/LeaderboardCard`           | standings printed on the promotions console's glass; `card` variant paints nothing now  |
| `components/gameplay/PlayerNotesPanel`             | editor: Cancel / Save Note plates (flat cap + lit word without `onClose`); library rows |
| `components/stats/BenchmarkPanel`                  | console; the p10..p90 track is the one drawn thing, an engraved groove                  |
| `components/stats/NemesisPanel`                    | console; nemesis and target side by side on the glass; full list as rows                |
| `components/stats/LeakPanel`                       | console; severity as a lit word (red / blue / muted)                                    |
| `components/stats/StatsShareCard`                  | console; the canvas is the card, Share Or Save Image a lit word                         |

## Rules applied while there

- No decimal on a forward-facing figure: `LeaderboardCard` scores and prizes
  print through `compactChips`; `NemesisPanel` net chips likewise;
  `BBJRecentHits` payouts print `6,240` not `6,240.00`; the jackpot page's
  "Your Contribution" rounds. Percentage rates keep their one decimal.
- `LeaderboardCard` printed a bare `0` for a place with no prize
  (`{entry.prize && ...}`); it is a ternary now.
- `club-engine.css` turns every `<table>` into a nowrap scroll box on a phone;
  the three console tables (`.bbj-rules__table`, `.bbj-basic__table`,
  `.nemesis-table`) restate `display: table; white-space: normal` so they fit
  the frame instead of sliding off it.
- `StatsShareCard`'s three status notes are Title Cased.
- SimPage's felt rail was brown (`#7a5a2a`); it is black with a lit edge.

## Found, not fixed (outside this batch's files)

- `TableModalsLayer.tsx` wraps `PlayerNotesPanel` in `.player-notes-overlay` /
  `.player-notes-modal` and its own `.modal-close` button. Neither class is
  defined in any stylesheet, so the overlay has no position and no backdrop,
  and the wrapper's close glyph sits beside the panel's own Cancel.
- `StatsShareCard`'s canvas still draws the exported PNG in the old cyan
  rounded-rect style; that is the image a player shares, not a UI surface,
  and repainting it is a separate decision.
