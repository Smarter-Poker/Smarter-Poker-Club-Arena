# 2026-08-26 — audit of the Antigravity create/join club redesign

Session: Cowork (Claude). Scope: everything PRs #1343 (redesign club flow 2)
and #1351 (JoinClubModal cyberpunk module) touched. Shipped as **PR #1377**
(main `ae0bfef9ba`), synced to World Hub `20086b30e2`, verified serving on
production `/api/health`.

## Verdict on the redesign

Moving create/join into modals is right, and the modal code itself is decent
(collision-retry create, canonical 5-digit codes, storage-safe logo prefix).
What broke was everything that pointed AT the deleted page and two guards
that did not survive the refactor into ClubsService.

## Fixed

1. **NoClubsEmpty → blank screen.** `setActiveTab('create')` targeted a tab
   that no longer renders. The one screen a clubless user sees led nowhere.
   Now opens CreateClubModal; the dead `'create'` Tab variant is deleted.
2. **/clubs/create fell through to `clubs/:clubId`** with clubId="create"
   (hamburger menu, CreateUnionPage, bookmarks). Redirect added in App.tsx to
   `/?create=club`; the lobby opens CreateClubModal on that param; both live
   links updated.
3. **Shared join links died silently.** `/clubs-list?c=&ref=` was parsed into
   state nothing read while an effect stripped the URL. The deep link is now
   captured once and opens JoinClubModal prefilled, referral parked for
   redemption.
4. **Invite-link paste detection was dead code.** It lived in onChange behind
   `maxLength={6}` — the paste was truncated before the regex ran. Moved to
   onPaste, which sees the whole clipboard.
5. **4-club limit failed open again on create** (a count error skipped the
   check; fn_join_club's owner branch never re-checks). Fails closed in
   ClubsService.createClub. The pinning test #1343 deleted is restored
   against the service.
6. **Orphan cleanup lost in the refactor.** A failed owner join left a
   members-less club squatting on its name forever. Restored in
   ClubsService.create, with test.
7. **Third spelling of the club-code rule.** JoinClubModal hand-rolled
   parseInt + range; now imports clubCode.ts. Test moved from HomePage's
   (unused) import to the modal, where the join UI actually lives.
8. **Enter-key double-join** re-entry guard; **lookup failure no longer
   reported as "invalid code"**; dead imports/state/LOGO_PRESETS swept from
   CreateClubModal and ClubsPage.

## Verified

`npx tsc --noEmit` clean; full `npx vitest run tests/` 449 files / 7212 tests
green in the worktree before push; CI green; Build for World Hub Sync
succeeded for `ae0bfef9ba`; production health served `20086b30` (the sync
commit of this build) at 2026-08-27T01:36Z.

## Known context for the next agent

- The Mac canonical clone `~/Documents/club-arena` has `core.bare=true` set,
  so its on-disk working files are stale and `git status` fails there. Work
  from worktrees (agent-workspace.sh) — the stale tree cost this session its
  first hour of audit against wrong file versions.
- The join path's 4-club limit still fails open client-side by design
  (fn_join_club re-enforces it server-side); only the create path fails
  closed, because nothing server-side backs it.
