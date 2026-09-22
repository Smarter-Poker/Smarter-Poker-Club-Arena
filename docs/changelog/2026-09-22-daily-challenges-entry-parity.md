# Every Daily Challenges Entry Keeps The Club

Phase 4 of the Daily Challenges programme, from the entry-surface audit. Every
door into `/challenges` now keeps the club the player is standing in, the Home
tile's intent warms the route shell App mounts, the completion toast opens the
page it names, the route shell paints the accent of the page that replaces it,
and Go Back on a cold deep link has somewhere to go. The pins are in
`tests/daily-challenge-entry-parity.test.ts`, one test per fix, and the tap
itself is exercised in `tests/unit/ChallengeToastListener.test.tsx`.

**Club Detail.** The Daily Challenges card in `src/pages/ClubDetailPage.tsx`
called `navigate('/challenges')`, so the challenges page opened with no club
and its Back To Arena door resolved to Home. It now calls
`navigate(withClubContext('/challenges', clubId))` with the route id the page's
other club links already use (`/clubs/${clubId}/...`), so a player who came from
Deep Stack Society goes back to Deep Stack Society. The card's copy moved from
the off-schema grey `#8a9aaa` to the schema muted ink `#9aa5b3`.

**Wallet.** The More Ways To Earn Daily Challenges door in
`src/pages/PlayerWalletPage.tsx` now navigates to
`withClubContext('/challenges', linkClubId)`, where `linkClubId` is the
`?club=` value exactly as the URL spelled it, else the club the store
remembers. Only this door changed. The Rakeback, Bonuses, Promotions,
Achievements and VIP Bonuses doors still navigate without the club and are left
for their own pass.

**Chunk preload.** `src/App.tsx` lazy-loads the route shell
`components/challenges/DailyChallengesRoute`, and the shell lazy-loads the
page. The `/challenges` intent in `src/utils/ChunkPreloader.ts` warmed only the
page, so a tap on the Home tile after a hover or touch still met a cold shell
and App's generic spinner before the painted loading master. The intent now
warms the page in the background and returns the shell import, the same shape
as the `/table/` entry, and the map's comment now says which lazy call each
import mirrors.

**Rewards workspace.** The Rewards Center cards in
`src/pages/workspaces/ArenaWorkspacePages.tsx` linked to bare paths while the
section rail beside them stamped the club. `WorkspacePage` now reads
`routeClubId` from `useClubWorkspace()`, the rail's own source, and links each
card to `withClubContext(item.path, routeClubId)`. `withClubContext` returns a
path that is not about one club unchanged (legal, help, search, friends, unions
and every `/clubs/...` tool), so the Community, Legal and club operations
workspaces that share the component keep their links, and a club-scoped card
anywhere gains the club only when the URL names one.

**Completion toast.** The toast says "Open Daily Challenges To Claim Your
Reward" but was not a door. `src/components/notifications/ChallengeToastListener.tsx`
now passes the Toast API's click handler, `success(message, undefined, onClick)`,
so the default duration stands and a tap navigates to
`withClubContext('/challenges', readClubContextParam(location.search))`. The
club is read at the tap, because a toast can outlive the page it arrived on. The
listener is mounted in `App.tsx`, which `main.tsx` renders inside
`BrowserRouter`, so the router hooks are in scope.

**Route shell accent.** `src/components/challenges/DailyChallengesRouteFallback.module.css`
hard-coded the daily cyan `#55e8ff` and the monthly gold `#ffc93c`, while the
page resolves both through `--realism-cyan` and `--realism-gold`, declared on
`:root` in `src/styles/club-engine.css`, which `main.tsx` imports globally. The
live cyan is `#00d4ff`, so the shell handed over to the page with a visible
accent swap. The shell now uses `var(--realism-cyan, #55e8ff)` and
`var(--realism-gold, #ffc93c)`, and its glows are
`color-mix(in srgb, var(--cycle-color) 20%, transparent)` and the same at 24%,
the alphas they had before. The monthly glow therefore follows the gold accent
instead of the brass rgba it used. Weekly `#c8d5da` stays in step with the
page's own literal.

**Crash fallback Go Back.** On a cold deep link there is no history entry
behind the page, so `window.history.back()` did nothing. The crash fallback in
`src/components/challenges/DailyChallengesRouteFallback.tsx` keeps
`window.history.back()` when `window.history.length > 1` and otherwise
navigates to the club home, ``routeClubId ? `/clubs/${routeClubId}` : '/'``,
with `routeClubId` from `useClubWorkspace()`, the page's own source.
`ClubWorkspaceContext` is already in the entry bundle through `AppLayout`, so
the route shell chunk gains no module.
