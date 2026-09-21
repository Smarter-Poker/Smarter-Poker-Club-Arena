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
`kit/`). Re-run 2026-09-21 on `be423c8b72`: **229 spoken for, 4 to go.**

It said twelve until the scanner was taught two things it had been guessing at
(#5046). Nine of the twelve cannot be reached from the app entry at all, and
the repo already writes that down in
`tests/every-file-under-src-is-reachable.law.test.ts`; the scanner reads that
law now and holds those nine off the sweep with the reader that keeps each one.
The tenth, `src/components/common/Card.tsx`, printed `DEAD?` because the
importer count only ever read `.tsx` and every barrel in this tree is a `.ts` -
so a component re-exported by `components/common/index.ts` and by nothing else
counted zero importers. It is reachable and it is a real candidate.

| surface                          | score | state                                                                                                                                                                                                              |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClubAdvertisePage`              | 34    | **UNBLOCKED as of 2026-09-21.** The previous copy of this file said it waits on the ads owner re-landing `AdCampaignService`; that landed, and `src/services/AdCampaignService.ts` is on `main` today. Rebuild it. |
| `PokerArenaLandingPage`          | 16    | the public landing page at `/`, lazy in `App.tsx` **and** in `entry-server.tsx`'s prerender map, so a rebuild has to be checked in the prerendered HTML as well as in the browser. Never rebuilt.                  |
| `src/components/common/Card.tsx` | 6     | the design-system Card primitive, reachable through `components/common/index.ts`. Find what still renders it before repainting: a primitive is not a surface, and no console surface uses it.                      |
| `LeaderboardSettlementCard`      | 3     | one importer (`LeaderboardPage`), cosmetic                                                                                                                                                                         |

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
