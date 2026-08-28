# The Action Bar Never Leaves The Top

**2026-08-28** — Dan, verbatim:

> NOTICE HOW IM INSIDE THE LOBBY FROM THE + BUTTON SCREEN AND HAVE GONE TO
> MTT. IF I CLICK A LOBBY OR GO TO REGISTER A TOURNAMENT, MY ACTION BAR
> DISAPPEARS AND THE PAGE GETS LOST. YOU HAVE TO FIX THIS SO THAT IF YOU ARE ON
> A PAGE THROUGH THE + BUTTON, THAT YOUR ACTION BAR STAYS AT THE TOP 100% OF
> THE TIME.

## What was happening

The action bar lives inside `MultiTablePage`, and `MultiTablePage` collapses
itself to `display: none` on any route that is not `/table/:tableId`. So "the
bar stays at the top" and "the route does not leave `/table/*`" are the same
requirement.

The in-tab lobby had exactly one guard against leaving:

```tsx
<div className="multi-table-page__lobby-tab" onClickCapture={handleLobbyLinkCapture}>
```

`handleLobbyLinkCapture` reads `e.target.closest('a')` and rewrites clicks on
`<a href="/tournaments/:id">` into an in-tab drill-in.

**It was written against a lobby whose rows were anchors. They are not any
more.** `src/components/lobby/LobbyTable.tsx` contains no `<a>` and no `<Link>`
at all — every row, every Details button, every Register callback is a `<div>`
or `<button>` whose handler calls `navigate()` imperatively. An imperative
navigate produces no anchor click, so the capture handler never ran. It had
silently stopped guarding anything, and nothing anywhere said so.

The route then changed to `/tournaments/:id`, the container hid itself, and the
bar, the tab strip and the Take Seat button went with it — while the player's
other tables were still dealing. That is the screenshot Dan sent.

Twelve separate call sites reached that state. The worst of them:

| Where                                    | What the player did                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| `ClubHomePage.tsx` `openTournamentLobby` | Tapped any MTT row in the schedule                              |
| `ClubHomePage.tsx` `onViewTable`         | Tapped a row's Details button                                   |
| `ClubHomePage.tsx` (post-register)       | Confirmed Sign Up                                               |
| `useTournamentRegistration.ts`           | Registered, seat not confirmed — fires up to 3.6s AFTER the tap |
| `TournamentLobbyCard.tsx` (x3)           | Tapped a satellite inside the tournament page                   |
| `TournamentDetails.tsx`                  | Hit "Back To Clubs" on a 404 tournament                         |

Note the satellite cards: the drilled-in tournament branch of `renderLobbyTab`
had **no** capture handler at all, so that whole surface was unguarded even for
real anchors.

## The fix

A DOM click guard cannot be the answer, because the thing it is guarding
against is not a DOM click.

**1. `src/context/InTabLobbyContext.tsx` (new).** A context the embedded lobby
subtree provides, and `useAppNavigate` — a drop-in replacement for
`useNavigate` — consults. Inside the in-tab lobby a `/tournaments/:id`
destination is handed to the container to render in the tab. Outside it, the
hook returns react-router's `useNavigate` unchanged, so the same components keep
working on their own routes.

Interception is deliberately narrow:

- **`/table/:id` still navigates for real.** That is how a player takes a seat
  from the lobby (the route effect converts the lobby tab in place). Rewriting
  it would cost someone a seat, which is strictly worse than the bug.
- **A numeric `navigate(-1)` passes straight through**, so browser Back works.
- **A search-only `navigate({ search })` passes through** — it is editing the
  current URL, not leaving.
- **At the table cap it yields.** `openTournamentTab` now returns a boolean;
  false means "no room", and the caller falls through to a real navigation. A
  player who cannot open a tab must still be able to read the tournament.

Swapped in at: `ClubHomePage`, `HomePage`, `TournamentDetails`,
`TournamentLobbyCard`, `useTournamentRegistration`.

**2. Both lobby-tab branches wrapped**, in the provider and in the click
capture. The capture stays as a second net for the genuine
`<Link to="/tournaments/:id">` anchors that still exist in `GameLobbyPanel`
("Open Full Tournament Lobby", and the "Return To Tournament" plaque CTA), which
no navigate hook can see because react-router handles them itself. Neither
mechanism alone covers the screen; together they cover all of it.

**3. A route-level backstop.** `useAppNavigate` stops this at the source, which
is where it should be stopped — no flash, no history entry, no unmount. But
"100%" is a promise about every call site that exists today _and_ every one
somebody adds next month, and an inventory of call sites is exactly the kind of
thing that goes stale silently. This bug **is** a stale inventory. So the route
itself is the last line: land on `/tournaments/:id` with tables open and the
container claims it back, `replace`, to the table the player was last on. Inert
when nothing is running, and it yields at the cap like everything else.

**4. `handleLobbyLinkCapture` now delegates to `openTournamentTab`** instead of
inlining its own `setTables`. There were two ways to do one thing and only one
of them focused the tab it filled.

**5. In the tab, the "Tournament Not Found" screen no longer offers "Back To
Clubs"** — a real anchor to a route outside `/table/*`. One 404 satellite and
everything was gone. `MultiTablePage`'s own "← Lobby" pill is the way back
there; on the real route the link is unchanged.

## Pinned

`tests/action-bar-never-leaves.law.test.ts` — nine pins. Every in-tab surface
must navigate through `useAppNavigate` and must not import `useNavigate`; the
rewrite must be `/tournaments/` only; numeric navigates pass through; both
branches carry the provider and the capture; the backstop exists and is inert
with no tables open.

The last pin is a **tripwire on the assumption that rotted**: if `LobbyTable`
ever gains real `<Link>` rows again, the click-capture path becomes load-bearing
once more and the comments calling it a secondary net become wrong. Update them
deliberately — do not let the two drift apart a second time.

## Also fixed on the way past

`tests/unit/addTableResolvesClubOnDemand.test.ts` pinned the select list as the
literal `'id, club_id'` and had gone red when the quick-join work added
`tournament_id` to the same query — a red test guarding a column that was never
what the test is about. Repinned on what it means: the handler must QUERY
`tables` for a club id rather than wait on the async ref. An extra column cannot
reintroduce that race; a missing `club_id` still fails.

## Verified

- `npx tsc --noEmit` clean
- `npx eslint` on all touched files: 0 errors
- Full vitest suite green (root suite plus all 8 shards of
  `tests/{unit,components,hooks,integration,utils,styles,config}`)
- `npx vite build` clean
