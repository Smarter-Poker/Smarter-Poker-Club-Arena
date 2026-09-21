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

## Inventory after #4696 (find-generic-surfaces.mjs)

221 spoken for, 12 to go:

| surface | why it is still on the list |
| --- | --- |
| `ClubAdvertisePage` | its console version needs the sponsor pricing and country targeting `#4711` also dropped (`AdCampaignService`); redo it after the ads owner re-lands (worktree `ads-self`, `agent/cowork-ads12`) |
| `PokerArenaLandingPage` | public landing page; two importers; never rebuilt |
| `LeaderboardSettlementCard`, `StatCard` | now owned by the leaderboard (`#4521`) and cinematic Stats (`#4974`) re-lands; score 3 to 4, cosmetic |
| eight `DEAD?` rows | zero importers (`MiniStatsCard`, `PremiumCard`, `RatingModal`, `ReportPlayerModal`, `SpectatorOverlay`, `FAQPanel`, `Card`, `StatCard`); dead code, delete rather than rebuild |

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
