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
`kit/`). Re-run 2026-09-21 on `be423c8b72`: **221 spoken for, 12 to go**, and
nine of the twelve are dead code.

| surface                     | score | state                                                                                                                                                                                                                                    |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClubDetailPage`            | 137   | **DEAD.** 1,986 lines, zero importers, no route in `App.tsx`, not in the prerender map. The operator workspace moved to `/hub/club-arena/clubs/:club/operations` and its 26 sub pages; this is what it replaced. Delete, do not rebuild. |
| `ClubAdvertisePage`         | 34    | **UNBLOCKED as of 2026-09-21.** The previous copy of this file said it waits on the ads owner re-landing `AdCampaignService`; that landed - `src/services/AdCampaignService.ts` is on `main` today. Rebuild it.                          |
| `PokerArenaLandingPage`     | 16    | public landing page at `/`, lazy in `App.tsx` and in `entry-server.tsx`'s prerender map, so a rebuild has to be checked in the prerendered HTML too. Never rebuilt.                                                                      |
| `LeaderboardSettlementCard` | 3     | one importer (`LeaderboardPage`), cosmetic                                                                                                                                                                                               |
| eight `DEAD?` rows          | 4-18  | zero importers: `MiniStatsCard`, `PremiumCard`, `RatingModal`, `ReportPlayerModal`, `SpectatorOverlay`, `FAQPanel`, `Card`, `StatCard`. Delete rather than rebuild.                                                                      |

`StatCard` appears in the old copy of this table twice, once as owned by the
cinematic Stats re-land and once as dead. The scanner says zero importers; the
cinematic re-land owns a different file. Treat it as dead and check the
importer count in one call before deleting it.

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
