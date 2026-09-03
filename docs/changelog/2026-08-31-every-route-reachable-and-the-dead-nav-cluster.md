# 2026-08-31 — Phase 2: The Inverse Route Audit, And A Dead Navigation Cluster

Phase 1 of the navigation law proved every MENU ENTRY reaches a real route.
This is the other direction, which nothing had ever asserted: every declared
ROUTE must be reachable from somewhere a player can click.

## 1. Breadcrumbs was not a hole — it was dead code

The known gap entering this phase was that `Breadcrumbs` takes its labels from
callers, so `check-nav-title-case.mjs` cannot reach them. The intended fix was
to case them at render.

Checked first: **Breadcrumbs has never been imported by any page in the entire
git history.** Its only reference was the barrel `src/components/navigation/
index.ts` — and that barrel has no importers either. The same is true of the
other two things it exports, `SideNav` and `NavItem`: zero non-self references
anywhere in `src/`, `tests/` or `server/`.

So the hole was closed by removing the surface. Deleted (7 files):
`Breadcrumbs.tsx/.css`, `SideNav.tsx/.css`, `NavItem.tsx/.css`, `index.ts`.
Adding title-casing to a component nobody renders would have been ceremony.

`tests/footer-clearance.test.ts` walks that directory but filters for `TabBar`
specifically, so it is unaffected — verified, not assumed.

## 2. Every route is now reachable, or explicitly justified

`tests/unit/everyRouteIsReachableLaw.test.ts` computes the reachable set as the
union of the navigation registries (**called**, not grepped) and every
`navigate()` / `to=` / `href=` target in `src/`.

Calling the builders matters: a static scan alone reports 85 of 126 routes
reachable; calling them finds **91**. The six-route difference is exactly the
club-operations family composed through `clubPath('/finance')`, which no regex
can resolve. That is pinned by its own assertion so the analysis cannot quietly
degrade back to grep accuracy.

**Result: 126 declared routes, 91 reachable, 35 not.**

## 3. A ratchet, not a pass/fail

Connecting or retiring the 35 is a product decision, so they are listed in
`ALLOWED_ORPHANS` with an honest reason each, in three groups:

- **External entry points** (2) — `share/hand/:handId` is built by
  `ShareableHighlight` for links sent off-platform; `clubs/create` is a legacy
  redirect to `/?create=club`, kept so old links resolve.
- **Developer and diagnostic surfaces** (9) — the `dev/*` showcases, `replay`,
  `sim`, `health`, `engine`. Never advertised to players.
- **ORPHANED PRODUCT PAGES (24)** — real, finished features with no door.
  Marked as queued work, _not_ as acceptable. Includes `union-dashboard`
  (3,105 lines), `agent-dashboard` (1,544), `player-sessions` (1,482),
  `anti-cheat` (1,175), `union-games` (643), `xmtt` (551),
  `rakeback-dashboard` (535), `flash-pool` (450).

The test then asserts two things that make the list one-way:

1. **No new orphans.** A route added with no way in fails immediately, while
   the person who added it still has the context.
2. **No stale entries.** An allowlisted route must still exist AND still be
   unreachable. Connect one and its entry must be deleted in the same change.

## Verification

All three failure directions proven by seeding each and confirming red:

- added a route with no inbound link -> **fails**
- allowlisted a route that does not exist -> **fails**
- connected an allowlisted orphan without removing its entry -> **fails**
- restored -> **passes** (5 tests)

Also: `navigationSurfacesLaw` updated (it named Breadcrumbs as a live surface)
and green at 7 tests; `tsc --noEmit` exit 0; full suite green.

## What this sets up

Phase 7 works the 24 orphaned product pages down. Every one connected or
retired deletes a line from `ALLOWED_ORPHANS`, and the ratchet guarantees the
number cannot go back up in the meantime.
