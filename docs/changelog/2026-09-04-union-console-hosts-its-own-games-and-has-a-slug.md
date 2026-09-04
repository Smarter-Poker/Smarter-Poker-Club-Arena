# 2026-09-04 - The union console hosts its own games, stays on its own page, and has a slug

Branch: `fix/union-create-table-in-union-context`. Reported by Dan, with screenshots.

## What Dan hit

On `/unions/fade0000-0000-0000-0000-000000000001/table-management?create=table`
(Midway Union), pressing a variant card ("CREATE NLH") threw him out of the
union onto `/clubs/club-jaqk/create-table/nlh`, which then failed to render
("Table Config Could Not Render", after two cache-busting reloads). Above the
cards, a "Host Club" dropdown offered Club JAQK and Shark Club - the two clubs
that, being inside the union, are precisely the ones that cannot build their
own games. And the address bar carried the union's UUID where every club URL
carries a slug.

## What was wrong

1. **The selector navigated away.** `CreateTablePage` is embedded in Table
   Management, but selecting a variant always ran
   `navigate('/clubs/<host>/create-table/<variant>')`. `<host>` was a member
   club's UUID, `SlugEnforcer` then rewrote it to `club-jaqk`, and the operator
   was on a member club's page with a union nowhere in sight. The render fault
   on arrival is the stale-chunk path in `lazyWithRetry` (both screenshots
   carry `_cb=`; the direct route renders clean today) - a full-page route
   change is exactly when a tab holding an old `index.html` asks for a chunk
   that no longer exists. Staying on the page removes the route change.
2. **The hosts were the wrong clubs.** The union branch of
   `GameManagementPage.load` built its host list from `union_clubs` - the
   MEMBER clubs - and let the operator switch between them. A union has a club
   row of its own (same id, `is_union = true`; Midway's holds 87,131 tables
   and every live one), and that row is what the union's games are written
   against. `fn_can_create_games` on it: union owner and admins, yes.
3. **No union slug existed.** `clubs.slug` has existed for a long time;
   `unions` had no such column. Midway's `midway-union` lived only on its
   house club row, and a union created through `manage-union.js` gets no
   house club row at all.

## What changed

- **`unions.slug`** (migration `20260904210000_a_union_has_a_slug.sql`,
  applied to production 2026-09-04 in one transaction). Unique, lower-case
  `[a-z0-9-]`, never a UUID, never `create`. `fn_unions_set_slug` fills it
  from the name on insert or when cleared, suffixing `-2`, `-3` on collision.
  Backfill kept the house club row's slug where one existed, so Midway is
  `midway-union` in both namespaces. Probed in a rolled-back transaction
  first (three synthetic inserts: duplicate name, `Create`, a UUID-shaped
  name) before applying.
- **`useUnionRouteId()`** resolves `/unions/:unionId` - slug or UUID - to the
  UUID every query needs, and hands back `unionRef` (the URL form) for links.
  All seven pages on union routes use it: Detail, Operations (dashboard),
  Games, Data, Statements, Settlement, Table Management. `SlugEnforcer`
  rewrites `/unions/<uuid>` to `/unions/<slug>` in one hop, and a house club
  row reached via `/clubs/<uuid>` now lands on `/unions/<slug>` directly
  instead of via a second redirect. `UnionService` selects and maps `slug`;
  the union list, the clubs page and create-union navigate by it.
- **Table Management hosts one club: the one you opened.** In union scope the
  host is the union's own club row; the "Host Club" `<select>` is gone and a
  static "Host: Midway Union" label stands in its place. Member clubs still
  name the rows they host on the board (labels, not hosts). A union with no
  house club row sees an explicit empty state rather than a member club
  offered as a stand-in.
- **The create flow stays on the page.** Picking a variant sets
  `?create=table&game=<variant>`; `TableConfigPage` now accepts
  `clubIdOverride` / `gameTypeOverride` / `onExit` and renders inside the
  creator deck with a back control to the variant list. Save, tournament
  creation and an access refusal all return to the board and refresh it.
  Club-scope Table Management gets the same embed, so the two consoles do not
  drift. The routed `/clubs/:clubId/create-table/:gameType` page is
  unchanged for everyone who arrives by URL.

## Tests

- `tests/unit/gameManagementPhase5Wiring.test.ts`: the pin on the host-club
  switch confirmation moved to two new pins - no `changeHostClub`, no host
  `<select>`, the house-row query, and the in-page create flow.
- `tests/components/SlugEnforcer.test.tsx`: two new cases for the union slug
  rewrite (with search string preserved) and the one-hop house-row redirect.

## Not done here

- `manage-union.js` (World Hub) still does not create a house club row for a
  new union, so a new union cannot host games until that exists. That is a
  money-bearing row (wallets, rake) and a separate change.
- `HomePage` / `NotificationService` still build `/unions/<union_id>` from
  club rows; those resolve through one `SlugEnforcer` redirect.
