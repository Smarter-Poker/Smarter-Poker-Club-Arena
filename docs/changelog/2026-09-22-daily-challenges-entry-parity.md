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

## The lobby tile label prints inside the art's title plate

Rendered on the published bundle at a 393px phone, the Challenge Vault tile's
live label wrapped "Daily Challenges" to two lines and "Open Challenge Vault"
to three, covering the lower 40% of the art; at 1440px the status line sat on
the frame's bottom rail. Two causes. First, the lobby tile images were inline,
so each wrapper's line box added a ~7.7px descender gap: the wrapper measured
64.2x104 instead of the 64.2x96.3 its 2:3 aspect ratio asks for, the four fill
tiles were stretched about 8%, and the native vault render was letterboxed, so
no percentage in the label mapped onto the art. The tile image is now a block,
which makes every wrapper exactly 2:3 (measured 64.2x96.3 at 393px, 160x240 at
1440px). Second, the label was sized by the viewport and allowed to wrap. It
now prints inside the dark leather plate the art paints across its foot (88.5%
to 95.5% of the art's height), sized by the tile's own width through a
container on the wrapper, always on one line; the status joins the title only
where the plate is tall enough for both lines (tiles 140px and wider).

## 200% text no longer splits the page title mid-word

At 200% root text on a 393px phone the hero title rendered at 64px (the mobile
rule's 2rem floor) in a 307px column, and `overflow-wrap: anywhere` broke
"CHALLENGES" into "CHALLENG / ES". The longest title word measures 5.446em in
the hero face, so every title size is now capped at 18cqi of the copy column,
which is its container. The cap only engages when that word would not fit: at
normal text sizes the title is unchanged, and at 200% it measured 55.26px with
the word 301px wide in the 307px column.
