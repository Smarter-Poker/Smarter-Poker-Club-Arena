# The all-phase sweep: every operations page, line by line

Dan's instruction after phase 8: go through it all line by line and leave
nothing unfinished. Every page in `src/config/clubOperationsNavigation.ts` was
mapped to its component through `App.tsx` and read against seven defect shapes:
a write that cannot see its own refusal, a read whose error is discarded, a
route param used as a uuid, `.single()`, a success toast that is not
conditional on the write, a stub, and a hardcoded display value.

**Twelve pages were clean on all seven** and are named here so nobody re-audits
them: the Trade cashier, Club Data, Financials, Insurance, Bomb Pot, Finance
Overview, Control Overview, Dashboard, Overview, Disputes, Agent Team, Table
Management, and the member detail page. Two cross-cutting results worth having:
**there is not a single `.single()`** in any of the 23 page components or the
services they call, and **no page hands a raw route param to a uuid column**.

What follows is what was not clean.

## Writes that could not see their own refusal

Under RLS a write that matches no row returns 204 with `error` null. Four of
these existed, and in three of them the UI then removed the row from the screen.

- **`BlacklistManagerPage` — lifting an exclusion.** `DELETE` with no
  `.select()`, followed by a local filter that removed the entry from the
  operator's list. The exclusion vanished from the screen and the player stayed
  excluded in the database, and the optimistic filter replaced the read that
  would have corrected it. The returned row is the proof now.
- **`BlacklistManagerPage` — Clear Expired.** Same shape; the button appeared
  simply not to work.
- **`ClubAnnouncementsPage` — pin.** Reloaded the list and toasted "Announcement
  pinned" over a row whose pin had not moved, so the reload repainted the OLD
  state under a success message.
- **`ClubAnnouncementsPage` — delete.** Removed the notice from local state and
  toasted "Announcement deleted"; the notice stayed live for every player.
- **`ClubsService.delete` — the club itself.** Two deletes, neither asking for
  what it removed, and the page then toasted "Club deleted successfully" and
  navigated to `/clubs` - away from the only screen that could have shown the
  club still sitting there. The club delete now requires a row back; the member
  sweep may legitimately remove none, so it reports rather than assumes.

## Success messages that were not conditional on success

- **`ReportReviewPage`.** `toast.success('Player action taken')` fired **before
  the RPC was issued**. On a refusal the operator saw "Player action taken" and
  then "Failed to update report", and the first is the one they act on. The
  optimistic row update stays - it is rolled back - but a toast cannot be rolled
  back, so it waits for the answer.
- **`ClubMembersPage` — export.** `exportToCSV` returns early and writes no file
  when there are no rows, so "0 Players Exported" was a success message for a
  download that never started.

## Reads whose failure was rendered as a verdict

- **`AntiCheatPage`.** The page carries `loadError` precisely for this - its own
  comment says _"'Nothing found' and 'the read failed' used to render
  identically here, and the second one printed the words 'Club Is Clean'"_ - but
  only `init` ever set it. A failed flags or events read still painted a clean
  queue. Both catches set it now.
- **`SuperAgentDashboard`.** A failed load left `agent` null and rendered
  **"You Are Not An Agent In This Club"** - an accusation, for a network blip.
  The two states are separated.
- **`CashierPage` — union owner.** `retryFetch` _returns_ the result with
  `error` set rather than throwing, so reading only `data` made a failed union
  lookup identical to "you are not the union owner": the operator silently lost
  Mint gating and the distribute path. It still fails closed; it now says so.
- **`CashierPage` — recipient list.** A failed page read looked like "that was
  the last page", so the list an operator picks a chip recipient from ended
  early, or empty, with nothing on screen. It refuses to offer a partial list.
- **`PromotionsPage` — referral code.** The error was never read, and the
  fallback put `user.id` into the invite link - which is the exact bug the
  comment above it describes as fixed: _"the code it displayed matched no
  player, so redemption refused it as an unknown inviter"_. No fallback now; an
  unknown player number means no link rather than a wrong one.
- **`ClubRulesPage`** (club read and role read) and **`ClubAnnouncementsPage`**
  (role read): both fail closed and both said nothing.

## Figures that were invented in the browser

- **`SettlementPage` — Active Players.** `totalPlayers: 0` was hardcoded at all
  three construction sites, so the tile read a confident nought for every club
  and every period. `settlement_periods` carries no player count; the type
  admits null and the tile renders a dash.
- **`SettlementPage` — player rakeback.** `a.totalRakeGenerated * 0.1`, a flat
  tenth invented in the browser and rendered per agent as though the platform
  had computed it. It uses the agent's own `commissionRate`, and where that is
  unknown the figure is null rather than a plausible-looking guess.
- **`SettlementPage` — the realtime handler.** The initial load was fixed in
  phase 7 to use `getCurrentPeriodForClub`, with a comment explaining that the
  unscoped call returns the newest open period _on the platform_. The realtime
  path still called the unscoped one, so the first `settlement_periods` event
  re-headed the page with somebody else's week.

## And a queue that was never this club's

`ReportReviewPage` sits at `/clubs/:clubId/reports`, heads itself with the
club's name and three counts, and called `fn_list_player_reports({ p_status })`

- **a function that takes no club argument**. `clubId` was used only as an `if`
  gate before the call. An operator running four clubs saw one pooled queue under
  all four headers, and each header's counts described the pool.

`20260905194441` gives it `p_club_id`, narrowed through `fn_club_scope_ids` -
the same way the cashier, the vault and the roster read "this club". The
moderation gate is untouched, so nothing new is exposed; a count presented as
this club's is now this club's. The unscoped single-argument form is dropped
rather than left reachable.

## Recorded, not fixed

`resolveClubUUID` **returns its input unchanged when the lookup fails**
(`clubIdResolver.ts`), so its failure path can still hand a slug to a uuid
column. Every page that matters guards it with an `isUUID` check or uses the
strict variant; the ones that only check truthiness are listed in the sweep
notes. One consequence worth knowing: the "must not silently widen" guard in
`PromotionsPage` can never fire, because the resolver never returns a falsy
value. Changing the resolver's contract touches every caller in the app and is
its own piece of work.

## Verified

- Full suite green: 13,699 tests, `tsc` clean.
- All ten Supabase and copy gates pass against production:
  `check-migrations-applied`, `check-definer-authorization`,
  `check-telemetry-exposure`, `check-required-columns`,
  `check-phantom-columns`, `audit-live-definer-exposure`,
  `check-discarded-read-then-write`, `check-ui-text`, `check-title-case`,
  `check-painted-text-case`.
- The discarded-error ratchet caught three improvements and their baselines came
  down in the same commit: `ClubRulesPage` 2 to 0, `ClubAnnouncementsPage` 2 to
  1, `PromotionsPage` 1 to 0.
