# 2026-08-27 — House Ads Phase 2: the Hub gets an ad surface, and two "bugs" that were not

World Hub PR #903 (`feat/hub-promotions-surface`). Follows House Ads Phase 1.
No Club Arena code changed in this pass — the code half of this work landed in
the World Hub repo, and this file is here because `docs/changelog/` lives here
and because the next ads agent will look here first.

---

## What I was told to fix first, and why I did not fix it

The Phase 2 brief opened with two suspected P0 defects and an instruction I want
to quote, because it is the reason this section exists rather than a diff:
_"PROVE which it is. A rolled-back transaction or a local click with the network
tab open is evidence; reasoning is not."_

Both turned out to be false alarms. Shipping a speculative fix for either would
have changed working code on a hunch and put a plausible-looking commit between
the next agent and the truth.

### P0-A — 84 impressions, 0 clicks, 0 dismisses

**0 dismisses is correct and is not a bug.** `AdService.logDismiss` exists and
has **zero callers** in `src/` or `tests/`. No dismiss control is rendered
anywhere in the product. The event type is unreachable by design, so the count
can only ever be zero.

Whether one should exist is a **product call for Dan**, not an agent's: he ruled
on 2026-08-27 that everyone sees ads, and a dismiss button is the beginning of an
argument about that. It is written down here rather than built.

**0 clicks has no defect in the click path.** Four independent things were
checked, and the write path is whole:

| suspected cause                                | what was actually found                                                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ad_event` CHECK rejects `click`               | It does not. `ad_event_event_type_check` allows `impression`, `click`, `dismiss`.                                                                                                                                                               |
| RLS refuses the insert                         | It does not. A probe run **inside a transaction that was deliberately aborted** (CLAUDE.md 11.5), as the real user `47965354` who owns 92 of the impressions, returned `CLICK INSERT ACCEPTED under RLS as authenticated`. Nothing was written. |
| The insert is lost to the unload               | It is not. `LobbyAdStrip.handleActivate` logs the click _before_ navigating, and `ClubHomePage.tsx:4019` passes `onNavigate={(path) => navigate(path)}` — react-router, client-side, **no document unload**. The in-flight insert survives.     |
| The target is a 404, so nobody completes a tap | It is not. `/vip`, `/cashier`, `/invite` and `/tournaments` all exist as children of `path="/"` in `App.tsx`.                                                                                                                                   |

What is left is the honest answer: **nobody tapped it.** A grey house rail that
rotates every seven seconds, sorted last behind club and union notices, seen by
four people. That is a plausible zero, not a broken one.

### P0-B — `vip_upsell` carries the highest weight (120) and has 0 impressions

**Also not a bug.** The `non_vip` predicate in `fn_resolve_ads` is correct. Every
one of the four users who has ever seen an ad is `is_vip = true`, and
`vip_upsell` is the only campaign with `audience = 'non_vip'`, so the resolver
was right to withhold it from all of them, every time.

The predicate is not structurally dead either — `profiles` holds **269**
`is_vip = false` rows against 754 VIP. The campaign will serve the moment a
non-VIP player opens a lobby. Confirmed separately that the resolver returns
exactly the five `all` campaigns and omits `vip_upsell` when `auth.uid()` is
null, which is the signed-out case behaving as documented.

---

## What actually shipped: `hub_promotions`

The World Hub had **no ad surface at all**. The slot has been in the
`ad_placement` CHECK constraint since Phase 1 and all six campaigns already
carried a `hub_promotions` placement with a correct Hub-relative `target_url`
(`/hub/vip-membership`, `/hub/diamond-store`, `/hub/daily-tournaments`,
`/hub/club-arena/invite`, `/hub/club-arena/`) — every one of which resolves to a
real page. What was missing was anything that rendered them. All 131 rows in
`ad_event` came from Club Arena's lobby strip.

Three files, in the World Hub repo:

- **`src/services/adService.js`** — the Hub's own resolver and logger.
  Deliberately a **separate file** from this repo's `src/services/AdService.ts`,
  and it does not import across repos: Club Arena is a Vite SPA and the Hub is
  Next.js, and coupling two build systems to save forty lines is a bad trade.
  What they share is the part that matters — the same `fn_resolve_ads` and the
  same `ad_event` table — so one query still answers "which slot converts best"
  across both surfaces.
- **`src/components/ads/HubPromoRail.jsx`** — the surface. Renders nothing when
  there is nothing; labels every card `SMARTER.POKER`, because everything below
  it on that page was written by a venue, a tour or a series and a player must
  be able to tell who is speaking.
- **`pages/hub/promotions.js`** — mounts the rail **above** the venue feed, so it
  still renders while that feed is loading, has failed, or is empty. Those are
  exactly the states where the page otherwise shows a player nothing at all.

Rules kept, deliberately:

- **No targeting in the client.** Audience, club scoping, flight dates and the
  24-hour frequency cap stay inside `fn_resolve_ads`. The browser renders what it
  is handed and reports what happened; it decides nothing. A future paid
  advertiser cannot be billed for impressions a browser served itself.
- **No VIP suppression**, per Dan, same day.
- **Impressions de-duplicate per page-load, not per render** — the same unit
  Club Arena counts. Counting renders would divide every campaign's
  click-through rate by a number that means nothing, and would make the two
  surfaces incomparable, which defeats the point of sharing the table.
- **The click is logged before a client-side `next/link` navigation.** If anyone
  ever converts those to full-page `<a href>` loads, the in-flight insert dies
  with the document and the click-through rate silently becomes zero — the exact
  failure that produces a confident lie on a metrics surface.

## What I could not verify, said plainly

`npx next build` was **not run locally**. The sandbox `/sessions` volume was at
100% with no room for `npm install`, and the mounted host `node_modules` carries
macOS binaries that will not execute on Linux. What was verified: all three files
parse clean through the TypeScript parser in TSX mode, and the immutable-rules
greps are clean on the diff (no `.single()`, no raw `createClient`, no conflict
markers, no unused hook imports, no protected zone touched, no cron governance
file touched). CI's build is therefore the first real build gate on that branch.
Saying so beats claiming a green nobody saw.

## Left open on purpose

- **`spins_jackpot` and `bbj_running` still point at `/`** on the Club Arena
  side. This is not laziness in the seed data: **there is no route to point
  them at.** Spins has no route in `App.tsx` at all, and BBJ is club-scoped at
  `clubs/:clubId/jackpot`, which needs a club id the resolver does not template.
  Their `hub_promotions` placements already override to `/hub/club-arena/`.
  Inventing a route to make a promo look tidy would have been the wrong fix.
- `session_summary`, `empty_state` and `table_between_hands` remain declared and
  unwired. `table_between_hands` is the one that can hurt players and has not
  been touched.
