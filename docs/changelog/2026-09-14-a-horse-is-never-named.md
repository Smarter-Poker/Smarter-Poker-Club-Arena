# A horse is never named

Dan, 2026-09-14, binding: "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY." This
closes the one thing CLAUDE.md 10.5 still allowed on the client - showing
`is_horse` as data, a badge, a column, a roster field or a toggle. Every
rendered reveal, toggle, label, badge, filter and export column has been
removed from the web client. Totals and lists still include every player;
horses count everywhere, as 10.5 already required - only the client's ability
to say WHICH rows are horses is gone.

## What was revealed, and where

- `src/pages/club/ClubDashboard.tsx` - a "Hide Horses" checkbox on the club
  leaderboard (shown only when a horse was in the top 100), an "H" badge with
  `title="Horse"` on each horse's leaderboard row and again on each horse's
  members-tab row, "People (Horses Hidden)" / "Person-Hands (Horses Hidden)"
  captions when the filter was on, an empty-leaderboard message that read
  "Every Player With Hands ... Is A Horse", an `is_horse` column in the
  members CSV export, and a `leaderboard-people` filename variant for the
  filtered leaderboard export.
- `src/utils/clubDashboard.ts` - `rankPlayers` took a `hideHorses` argument and
  filtered the ranked list by it; `leaderboardToCsv` carried an `is_horse`
  header and column.
- `src/pages/club/ClubDataPage.tsx` - a "Hide Horses" / "People Only" chip on
  the Players tab (title: "N Of The Loaded Rows Are House Horses"), a gold
  "Horse" tag beside a horse's name, a "People" vs "Players" relabelling and
  an "Of The Rows Loaded" scope note on the totals strip when filtered, and an
  `is_horse` column in the full players CSV export (`playersToCsv`).
- `src/pages/BlacklistManagerPage.tsx` - the club-exclusion member picker
  appended " (Horse)" to a selected member's name and showed a "Horse" tag
  beside a horse in the search results.
- `src/pages/CashierTradePage.tsx` - the downline roster appended " (Horse)"
  after a horse's role.
- `src/lib/cashierRoster.ts` - `DownlineRow.isHorse`, mapped from the RPC row
  and consumed only by the CashierTradePage suffix above; nothing else read
  it, so the field is gone with the suffix.

## What changed

Every item above is deleted, not hidden behind a flag: the `hideHorses` /
`horsesLoaded` state, the toggles, the badges, the CSV columns and filename
variants, and the now-orphaned `.horseTag` / `.totalsScope` CSS rules in
`ClubDataPage.module.css` and `BlacklistManagerPage.module.css`. Totals
(`playerTotals`, `rankedPlayers`, the members list) always cover every
loaded row now; `rankPlayers` and `leaderboardToCsv` no longer take or emit a
horse flag at all.

`is_horse` / `isHorse` stay as plumbing in exactly the places nothing renders
them: the `TopPlayer` / `ClubMemberRow` type fields and RPC mappings in
`ClubDashboard.tsx` (never read after the badges were removed), the
`is_horse` field on `TableOperationsPanel.tsx`'s seated-player type (never
printed), `TablePage.tsx`'s `isHorse` derived from `horse_id` on seat models
(no renderer consumes it), and `FriendSuggestionService.ts`'s `is_horse` read,
which keeps horses out of friend suggestions without showing anyone anything.
`scripts/ci/check-horses-are-players.mjs`'s REGISTER lost the two entries that
justified the (now-deleted) client toggles as identification exclusions; the
remaining entries are all server/engine-side and untouched.

## What the law pins

`tests/a-horse-is-never-named.law.test.ts` scans every `.tsx` file under
`src/pages/**` and `src/components/**` and fails on: the literal phrases
`Hide Horses`, `Horses Hidden`, `People Only`, `title="Horse"`, `(Horse)`; the
identifier `hideHorses` anywhere; `is_horse`/`isHorse` quoted as a bare CSV
header cell; and `is_horse`/`isHorse` reached through a dot inside a same-line
JSX `{...}` span (a condition, ternary or attribute value). A type member, a
plain object-literal mapping, a Supabase service call
(`.select`/`.eq`/`.rpc`/`.from`), and a comment are explicitly exempt - the
plumbing this changelog names above.

`tests/a-horse-is-named-only-to-those-entitled.law.test.ts`'s fourth test
previously required `ClubDataPage.tsx` to contain `is_horse`/`horseTag`/
`hideHorses` lines (proving the database-masked flag was painted for staff and
never derived from a username). That premise is superseded; the test now
asserts the opposite - the page contains none of those, for anyone. Its first
three tests, which pin the database's own `fn_can_see_horse_flag` masking of
the four RPCs that once leaked it unmasked, are untouched: that masking is a
data-access decision, separate from and unaffected by this ruling about what
the client paints.

## The second ruling of the day: an internal tool is not a surface

Dan, 2026-09-14: "THESE POP UPS OR EVENT LOGS (IF INTERNAL USE ONLY) DO NOT
NEED DYNAMIC IMAGES AND POP UPS."

A page no player and no club operator can reach is a tool for the house: the
QA scenario harness (`/sim`), the bus event log (`/dev/bus`), the platform's
own engine, analytics and house-ads dashboards, and everything under
`src/pages/dev/`. They are still bound by the copy laws and the colour
schema; they are not worth a round of painted art. `INTERNAL_ONLY` in
`.claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs` carries
the list and the scanner now reports them as spoken for, so no future wave
hands one to an agent. A CLUB owner is a customer: every operator page they
open stays in the sweep.

Nothing already built is being torn out - the ones that were rebuilt before
the ruling are green and shipped - but no further art is spent there.
