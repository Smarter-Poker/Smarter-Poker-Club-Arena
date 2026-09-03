# In-Tab Lobby, Round 2 — The Audit Of My Own Fix

**2026-08-28** — a line-by-line audit of the round 1 action-bar fix
(`2026-08-28-action-bar-never-leaves-the-top.md`, PR #1696) and the surface
around it. Round 1 generalised the **mechanism** correctly — a context beats a
DOM click-capture — but kept the old guard's **scope**, and lost data on the way
through. This is everything that found.

---

## 1. I broke the WATCH button. (regression, mine)

`TournamentLobbyCard` opens a running event's table by navigating to
`/tournaments/<id>?watch=1`; `TournamentDetails` consumes `watch=1` and opens
the featured table.

Round 1's interception took `match[1]` — the id — and **threw the query string
away**. In the tab the parameter never arrived, so a button labelled **Watch**
opened a details page and stopped. On the real route it still worked, which is
exactly how this kind of bug survives a demo.

- `InTabTournamentTarget` is now `{ tournamentId, search }`, and
  `tournamentTargetFromTo` parses both shapes call sites use (a string path and
  a `{ pathname, search }` object), normalising a missing `?`.
- Both entry points — the hook and the click-capture — parse through **that one
  function**, so an anchor and an imperative navigate can no longer disagree
  about a destination.
- `TournamentDetails` takes `searchOverride`. On the real route the query is
  `location.search`; embedded it cannot be, because the URL there belongs to
  `/table/:tableId`. One rule for both mounts: _the query that addressed this
  page_.
- Embedded, consuming the intent no longer calls `navigate({ search })`. That
  resolves its missing pathname from the **current** location, so in-tab it
  would have rewritten the table's URL and wiped the `?name=&stakes=&code=`
  MultiTablePage reads to name a tab it has not built yet. Latent, not live —
  fixed before it became live.

## 2. A seated player was being thrown off their table with no gesture at all

The worst thing in the audit, and it predates round 1.

`ClubHomePage.loadClubData` navigates to `/invite/:clubId` when it concludes you
are not a member. Two of its three checks concluded that **from a failure**:

- `getAuthUser()` returns `{ user: null }` both when you are signed out _and_
  when its 5-second `getUser()` times out. The null was acted on.
- `memberResult.error` was **never inspected**. PostgREST returns `data: null`
  for a 500, a statement timeout or an RLS hiccup — all read as "not a member".

And this is not a mount-only load: it re-runs on tab refocus, on realtime
resubscribe, and on a 90-second interval — and the lobby tab **never unmounts**,
so it ran for the whole session, including while the player was on a felt.

Net effect: heads-up in a hand, background the app to answer a text, come back,
Supabase blips — and the whole app navigates to a "Join This Club" page while
your tables deal on invisibly behind it. Nobody clicked anything.

The fix is the rule this same file already documents forty lines below, for the
union cascade: **downgrade only on positive evidence of absence.**

- `getAuthUser` now returns `failed: true` on the timeout/throw path. A missing
  user is a fact; a failed read is not evidence of anything.
- Both membership reads check `error` and report it instead of bouncing.
- All `/invite` redirects go through `bounceToInvite`, which **in the tab
  renders a panel instead of routing away** — "You Are Not In This Club / Your
  Games Are Still Running", with Retry and a deliberate Join button. Leaving the
  felt becomes the player's choice rather than something that happens to them.

## 3. An ad row decided where the router went

`ads.target_url` is free text typed into the admin panel, read out as
`String(r.target_url)`, and handed straight to `navigate(path)` by both ad
surfaces. Nothing validated it — although `isSafeAdImage`'s own docstring
already claimed _"a destination is checked before a browser is sent to it"_.

That bought two things: an off-site destination reached from a control players
trust because it sits inside the club lobby, and — in the tab — a collapsed
action bar mid-hand. The lobby strip rotates every 7 seconds, so the destination
under the player's thumb changes while they read it.

`isSafeAdTarget` is the sibling that docstring promised: rooted, same-origin,
rejecting `//host`, `javascript:`, and the backslash forms browsers normalise
toward `//`. Validated **after** `{clubId}` substitution, so a template cannot
smuggle a destination past the check.

## 4. The drill-in had no way back

`lobbyTournamentId` was one scalar, overwritten on every drill-in. Tapping a
satellite from a Main Event **erased the Main**: "← Lobby" jumped all the way
out to the schedule, and browser Back was dead too because an in-tab drill-in
pushes no history entry. On the real route Back did this correctly — the in-tab
version was a downgrade in the exact flow it exists to serve.

Now a stack, with three helpers as its only writers so the scalar and the stack
cannot disagree. The pill reads **← Back** at depth and **← Lobby** at the
bottom, because calling the parent event "Lobby" was a lie that cost the player
the page they wanted. Re-opening the event already on screen is a no-op rather
than a second entry, so one back press leaves one page.

`TournamentDetails` is keyed on the tournament id, so switching events remounts
it — without that, React reuses the instance and the old event's fetch can land
last and paint over the new one.

## 5. The `+` button showed a tournament

`OPEN_LOBBY_TAB` focused an existing lobby tab and left `lobbyTournamentId`
alone. So "+" — a button whose entire meaning is _show me the games_ — reopened
whatever tournament page the tab was parked on, and if that tab was already
active it did nothing visible at all, which reads as the button being broken.
Pressing "+" is a request for the lobby; it now gives you the lobby.

## 6. Remaining escapes closed

- **The provider now wraps the whole container**, not just the lobby tab.
  `TournamentLobbyModal` renders `TournamentDetails` (and its satellites) from
  inside `TablePage` — outside round 1's provider — so a satellite tap on the
  felt did a real route change and was only recovered by the backstop, after the
  flash and by yanking the player off their table.
- **The bare `/tournaments` list has its own backstop.**
  `matchPath('/tournaments/:tournamentId')` does not match it, and
  `TournamentStartingTicker` — an app-root marquee over every table — falls back
  to exactly that when it cannot resolve an id. (A `session_summary` house ad
  ships pointing there too.)
- **The club error panel's "Back To Clubs" is hidden in the tab**, the same
  guard `TournamentDetails` already had. That panel is reachable in-tab
  precisely when the load is flaky, so its one obvious button was an exit.
- **Drill-ins use a functional `setTables`.** Two in one tick — a double tap, or
  the capture and the backstop both firing — lost one.

---

## Verified

- `tsc --noEmit` clean; `eslint` on all eight touched files: **0 errors**
- **556 test files, 8,535 tests, all passing**
- `npm run build` clean, `behind-main=0`

New tests: `tests/unit/inTabTournamentTarget.test.ts` (behavioural — the query
string, and what the parser must _not_ claim) and
`tests/unit/adTargetIsNotAnOpenRedirect.test.ts`. `action-bar-never-leaves.law.test.ts`
gains two describe blocks pinning every item above.

One existing pin was updated in this commit rather than worked around:
`houseAds.test.ts` asserted the literal `Boolean(ad.targetUrl)`. Its intent —
"not activatable when there is nowhere to go" — is what the change strengthens
to "nowhere **safe** to go", so the pin now follows the intent.

## Still open, deliberately

`ClubBottomNav` renders six `<Link>`s inside the in-tab lobby (Profile,
Players, Cashier, Market, Data, Stats) and every one leaves `/table/*`. Those
destinations have no in-tab renderer, so honouring the law for them means
either an in-tab router or a globally pinned action bar — a real piece of
design, not a patch. `MultiTablePage` currently documents them as an explicit
user choice, and the `LiveTablesBar` dock brings the player back. Flagged rather
than half-fixed.
