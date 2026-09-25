# HANDOFF: the #ClubArenaConsole sweep (2026-09-21)

Tracked in the repo because the untracked copy in the canonical clone was
archived out from under the last owner (10.87 rule 2 archives every untracked
file it finds). Dated claims; re-check each with one call before acting.

## State

- **PR #4696** `feat/console-wave7-felt-and-the-rest`, head `1713fa015c`
  (plus this file). It carries the whole sweep: waves 1 to 7, the horse
  package (`#4697`, closed and folded), and the tournament lobby.
- **Why the whole sweep is in one PR.** `#4711` (2026-09-16) restored a
  September 13 tree and dropped 147 console surfaces from `main`. The re-land
  is a three-way merge per file with the restore commit as the base, so every
  post-restore change on `main` sits on the console render. Full account:
  `docs/changelog/2026-09-20-the-console-comes-back-and-the-tournament-lobby-joins-it.md`.
- **Standard and kit:** `.claude/skills/club-arena-console/SKILL.md` v1.5.0,
  with traps 7.11b to 7.13 and the three 2026-09-14 rulings (Title Case on
  data, a horse is never named, internal tools are not surfaces).

## Inventory after #4696

`node .claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs`
(the path, because the last copy of this file said `kit/` and there is no
`kit/`). Re-run 2026-09-22: **233 spoken for, 1 to go.**

It said twelve until the scanner was taught two things it had been guessing at
(#5046). Nine of the twelve cannot be reached from the app entry at all, and
the repo already writes that down in
`tests/every-file-under-src-is-reachable.law.test.ts`; the scanner reads that
law now and holds those nine off the sweep with the reader that keeps each one.
The tenth, `src/components/common/Card.tsx`, printed `DEAD?` because the
importer count only ever read `.tsx` and every barrel in this tree is a `.ts` -
so a component re-exported by `components/common/index.ts` and by nothing else
counted zero importers.

**The bottom two rows closed on 2026-09-22, and neither was a rebuild.** Both
were the inventory reporting work that did not exist; full account in
[`changelog/2026-09-22-the-inventory-was-scoring-the-standard-against-itself.md`](./changelog/2026-09-22-the-inventory-was-scoring-the-standard-against-itself.md).
**No source under `src/` changed for either.** `ClubAdvertisePage` closed the
same day under `#5083`, so **`PokerArenaLandingPage` is the only row left in the
whole sweep.**

| surface                              | score | state                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`ClubAdvertisePage`~~              | 0     | **DONE 2026-09-22, `#5083`** - rebuilt on the console by the ads owner. (It read 33 here for a few hours: 34 before the zeroing fix below, less one `box-shadow: none`. Its thirteen real corners and seven real gradients were never hidden by that fix.)                                                                                                                                                                                                              |
| `PokerArenaLandingPage`              | 16    | **THE LAST ROW IN THE SWEEP.** The public landing page at `/`, lazy in `App.tsx` **and** in `entry-server.tsx`'s prerender map, so a rebuild has to be checked in the prerendered HTML as well as in the browser. Never rebuilt.                                                                                                                                                                                                                                        |
| ~~`src/components/common/Card.tsx`~~ | 0     | **RULED OFF, 2026-09-22.** Not a surface: nothing renders any of its six exports. The three `<StatCard` sites in the tree are three different components (`ProfilePage:197` and `ClubDetailPage:241` define their own; `components/stats/StatCard.tsx` is a separate file). Its only importer is the `components/common` barrel; the barrel's only importer is `main.tsx:55` taking `ErrorBoundary` alone. Retiring it is the right answer and is NOT free - see below. |
| ~~`LeaderboardSettlementCard`~~      | 0     | **ALREADY ON THE STANDARD.** It renders inside `LeaderboardPage`'s `<SpadeConsole>` (`#4521`, `15477de6f1`) and owns no frame, like `BBJBasicPanel`. Its whole score of 3 was `border-radius: 0` plus `box-shadow: none` - the 3.5 idiom for refusing a chassis, counted as chrome. Scorer fixed at the root; it now judges declaration VALUES.                                                                                                                         |

### The open follow-up: retiring `common/Card`

Deleting `Card.tsx` is trivial. Deleting `Card.css` is not, and that is why it
did not ship with the ruling. It is a **global** sheet and still the only
declaration of properties five live surfaces inherit without redeclaring:
`flex-direction: column` and `gap: 8px` on `.stat-card` for
`stats/BankrollTracker`, `stats/StatCard` and `SuperAgentDashboard`, and
`gap: 12px` (plus `padding-bottom` and `border-bottom` for the second) on
`.card-header` for `stats/PositionWinRates` and `admin/EngineDashboard`. Pull
the file and three stat grids flip from column to row. It is also pinned into
the entry chunk by `scripts/ci/entry-chunk-baseline.json`, which is how a dead
stylesheet still ships to every player.

So the retirement is: re-home those declarations into the five sheets that need
them, re-render those five surfaces, drop `Card.tsx` and its barrel line, delete
`Card.css`, restamp the entry-chunk baseline. A CSS de-orphaning pass with five
surfaces to review - not a console sweep row.

The nine unreachable files the scanner prints under the table - `ClubDetailPage`
(1,986 lines, no route, not in the prerender map), `MiniStatsCard`,
`PremiumCard`, `RatingModal`, `ReportPlayerModal`, `SpectatorOverlay`,
`FAQPanel`, `StatCard`, `TableOperationsPanel` - are **neither sweep work nor a
deletion instruction.** Each sits in the reachability law's `RETAINED` map with
the test, law or CI script that still reads it by path, and that law is
explicit: removing one means retargeting its reader in the same commit.
`ClubDetailPage` is the tempting one, and the operator workspace at
`/hub/club-arena/clubs/:club/operations` did replace it, but three tests read it
by path today.

## What not to redo

- `ThemeSettingsModal` and the studio baselines: `#4805` re-landed the console
  studio with Linux screenshots; take `main`'s.
- `DiamondCrashPage`, `DiamondPlinkoPage`, `BonusSetup`: the Diamond owner's
  live workstream (eight post-restore commits); take `main`'s.
- The tournament details page (`/tournaments/:id`, seven tabs) wears the
  approved "premium tournament console" shells (`#1947`); it is on approved
  art, not generic.

## Rendering

The harness runs on the Mac with the Playwright Chromium already installed
(`~/Library/Caches/ms-playwright/chromium-1208`); `harness/run-shots.sh` is
written for the Linux path, so on the Mac set `CHROME` to that binary and run
`vite --port 5199` + `.shot.mjs` the same way. Harness copies never get
committed; the tournament lobby fixture rows live only in the changelog's
before/after sheet.

## Delivery

Per `PUBLISHING.md`: required checks on the final head, protected squash
merge, `publish-club-arena.yml`, then both `build-info.json` endpoints
reporting the squash SHA. Nothing is live until that last read.
