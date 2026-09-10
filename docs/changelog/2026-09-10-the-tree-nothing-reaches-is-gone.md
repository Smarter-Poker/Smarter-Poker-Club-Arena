# The tree nothing reaches is gone (audit CL-55, CL-56, CL-60; CL-30, CL-32, part of CL-57)

**Branch:** `fix/no-dead-code`
**Law:** `tests/every-file-under-src-is-reachable.law.test.ts`

## What was measured

A reachability walk from `index.html` -> `src/main.tsx` (static and dynamic
imports, re-exports, CSS `@import`, `url(/src/...)`, the vite aliases; comments
deliberately NOT stripped, so the walk errs toward "reachable") reached 1,524
of the 1,998 source files under `src/`. 474 were unreachable: 282 ts/tsx/js
(the audit's 286) and 192 CSS files that only they imported.

The existing orphan ratchet (`scripts/ci/report-orphan-modules.mjs`) counts
files nothing imports and stood at 64. It could not see this: 73 of the
orphans were re-export barrels, and about 130 components of one unused
design-system layer (`buttons/`, `badges/`, `cards/`, `forms/`, `modals/`,
`tabs/`, `tooltips/`, `dropdowns/` ...) were imported by those barrels and by
nothing else.

Every unreachable file was then cross-referenced by path against everything
that can break on a deletion: `tests/`, `scripts/`, `.github/`, `server/`,
`e2e-live/`, `docs/laws.d/`, migrations, root config, and every live `src/`
file. 64 had a reader; 410 had none.

## What changed

**Commit 1 (deletions only, 387 files, 30,521 lines):** every unreachable file
with no reader by path. Among them the CL-30 `FriendsList` and CL-32
`PlayerNotes` components (exported by barrels nothing imports; the at-table
notes panel is `gameplay/PlayerNotesPanel`), so their CSS defects are gone
rather than restyled; and the dead second copies of `AddOnModal`,
`CashierModal`, `RebuyModal`, `PlayerCard`, `NotificationDropdown`,
`Dropdown`, `Tabs`, `Tooltip` and `IconButton` from CL-57, with their barrels.
Five CSS files whose only "reference" was a same-basename import from a
different directory, and five files named only in comments of live files, are
included. `BASELINE_ORPHANS` lowered 64 -> 34 in the same commit, as the
script's header asks.

**Commit 2 (four referenced files, readers retargeted in the same commit):**

- `src/ClubArenaRoot.tsx` (CL-60): its header said the World Hub's
  `pages/hub/club-arena/[[...slug]].js` imported it; that file and directory
  were deleted 2026-09-02 and `index.html:98` boots `src/main.tsx`.
  `tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts` now pins
  the one entry.
- `PlayerSessionsPage.tsx`, `RakebackDashboard.tsx`, `WaitlistPage.tsx`
  (+ `.css`) (CL-56): de-routed in `App.tsx` on 2026-08-31 (redirects kept),
  imported by nothing. `tests/e2e-page-load-audit.ts` no longer lists routes
  the router does not serve; the discarded-error ratchet rows are removed;
  `tests/promo-is-owner-money-and-nothing-else-pays-it.law.test.ts` reads the
  one page that still disburses promo chips. `BASELINE_ORPHANS` 34 -> 30.

**Commit 3:** the law and this record.

## What was deliberately NOT deleted (82 files, 17,033 lines)

Each is read by path by a test, a law, a ratchet, a CI script or a
`docs/laws.d` entry, and is listed in the law's `RETAINED` map with that
reader. The three with the most readers:

- `src/pages/ClubDetailPage.tsx` (1,984 lines): five guards read it
  (`promotion-assigns-the-rate.law`, `theArenaIsAlwaysTheAlias.law`,
  `CompleteSetReadsDoNotTruncate`, `discardedErrorReadRatchet`,
  `managedGameLifecycleAuthority`). Retargeting five laws to the live
  equivalent is a judgement per law, not a sweep.
- `src/components/Shell.tsx`: pinned as a menu trigger by
  `approvedHamburgerGearGuard.law` - the law at the centre of the
  2026-09-01 revert war. Not edited on an agent's own authority.
- `src/components/gamification/LuckyDrawWheel.tsx`: dead, but on the
  Math.random allowlist of `a-player-is-never-shown-an-invented-number.law`
  on the `fix/no-fabricated-data-and-no-dead-code` branch. Deleting it here
  would turn that law red the moment both merged. Delete it, its two
  `WHEEL_SPIN_RESULT` subscribers (`PlayerActivityFeed`, `ProfilePage`) and
  its allowlist row together, after both branches land.
- `src/styles/design-system.css`: 47 live stylesheets cite it in comments as
  the token reference. It is not loaded, so those comments already describe
  rules that are not in effect; left for a docs pass.

## Not done, and why

- **CL-57 `tableGeometry` twins:** `utils/tableGeometry.ts` (card
  normalisation + pct-to-px) and `components/table/tableGeometry.ts` (seat
  layout constants) share a name, not a concern. Merging is a rename across
  `TablePage.tsx`, `DealerButton.tsx` and eight tests with no behaviour gain,
  on the most sensitive layout code in the app.
- **CL-57 `ConfettiEffect` twins:** `effects/` (CSS particles, `isActive`)
  and `gamification/` (canvas, `active`) are different animations with
  different props, used by `DailyChallengesPage` and `AchievementsPage`.
  Picking one changes a celebration a player sees; CLAUDE.md 10.6 says
  animations do not regress on an agent's judgement. Dan's pick.
- **CL-57 `PromotionsPage` twins:** `pages/legal/PromotionsPage.tsx` is the
  promotion RULES legal page (`ClubPromotionRulesPage`); it shares a filename
  with the promotions lobby, not a purpose. Not a duplicate.

## Verification

- `npx tsc -b`: clean.
- `npx vite build`: built.
- `npx vitest run tests/`: 1,341 files, 18,2xx tests, green (see the push log).
