# Ads audit: what the sweep found, and the reporting it forced

**2026-08-28.** A full pass over the house-ad system after four surfaces went
live in one day. Findings first, then the two that were worth fixing on the
spot.

---

## The sweep

| #   | Finding                                               | Verdict                                                                                                                                                                       |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CI red on the ads PR                                  | **Not the ads.** `main` itself was red — `tournamentRakeAndBreaks` pinned a method that had moved. Another agent fixed it in #1551; this branch just needed `main` merged in. |
| 2   | `fn_ad_cap_status` called by nothing                  | **Real, mine.** Dead code the same day it shipped. **This row first said "now consumed", which was false** — see the correction below.                                        |
| 3   | Admin rollup is slot-blind                            | **Real.** Fixed here. See below.                                                                                                                                              |
| 4   | `ad_event` rollup capped at 50,000 rows               | **Real.** Fixed here. See below.                                                                                                                                              |
| 5   | `ad_event.slot` had no CHECK                          | **Real.** Fixed here.                                                                                                                                                         |
| 6   | PR #903's Hub rail uses the blocked session accessor  | **Not a bug.** Verified live: it logs. Three impressions landed from `/hub/promotions` at 04:03 UTC.                                                                          |
| 7   | Two Hub ad clients on `main`                          | **Real, open.** Duplication, not breakage. Both surfaces work; both write `hub_promotions`, so the data cannot tell them apart.                                               |
| 8   | `LobbyAdStrip` dismiss from #1540                     | **Correct.** State-only, expires with the page load, logs a `dismiss` for HOUSE ads only. Exactly the shape #1505 asked for.                                                  |
| 9   | Club Arena still expands `{clubId}` itself            | **Harmless, redundant.** The resolver expands it first, so the client's `replace` finds nothing. Two authorities for one decision is worth collapsing eventually.             |
| 10  | Two migration files share the `20260828032000` prefix | **Cosmetic.** Applied versions differ; file ordering is ambiguous but nothing reads it.                                                                                       |

No stubs, no TODOs, no unreachable components in the ad surface area.

---

## Fixed: the panel could not tell you which surface works

The rollup in `/api/club-arena/house-ads` aggregated `ad_event` by `ad_id`
alone:

```js
const row = (stats[e.ad_id] ||= { impressions: 0, clicks: 0, dismisses: 0 });
```

Correct when one slot existed. `bbj_running` now runs on **four** surfaces, and
the panel reported one blended number for all of them. An operator reading a
poor rate could not tell whether the lobby was carrying the campaign or dragging
it down — and the obvious action, turning the campaign off, could be exactly
wrong.

The first real breakdown, minutes after shipping it:

```
slot             ad                impressions  clicks
hub_promotions   spins_jackpot           3        1
hub_promotions   bbj_running             3        0
lobby_strip      spins_jackpot          48        0
lobby_strip      bbj_running            36        2
lobby_strip      referral_invite        29        0
```

Small samples, but that is the comparison nobody could make this morning.

## Fixed: the count had a ceiling and no way to say so

The same route read `.limit(50000)` and tallied in JavaScript. This table logs
an impression per ad per page load, so 50,000 arrives. PostgREST would return
the first 50,000 and the route would report the total with complete confidence,
under-counting a little more every day and never saying so.

`fn_ad_stats()` counts in Postgres: no ceiling, nothing to truncate, and a row
per ad per slot. It also returns `last_event_at`, so a surface that has
**stopped** reporting is as visible as one that never started.

`stats` still goes `null` on any failure and still renders as a dash. A
confident zero reads as "this campaign got no clicks" when the truth is "we
could not count" — the exact lie this panel exists to avoid.

## Fixed: a slot in the event log must be a slot that exists

`ad_placement.slot` has had a CHECK naming the five legal surfaces since Phase

1. `ad_event.slot` — the column every report reads — had none.

Three clients across two repos write it by hand:

```
AdService.logEvent(adId, slot, ...)     Club Arena
logHubAdEvent(adId, eventType)          World Hub strip
logEvent(adId, slot, eventType)         World Hub rail
```

One typo — `lobby-strip`, a stale constant — and the writes keep succeeding
while that surface's rollup silently splits in two. Nothing goes red; the
numbers just quietly stop adding up.

The migration verifies every existing row is already valid _before_ adding the
constraint, and aborts with a count if any is not: a constraint that would
retroactively reject real data is a question to answer, not a thing to widen
until it fits.

## Correction: `fn_ad_cap_status` was NOT consumed, and never should have been

The audit row above originally read "now consumed". It was not. I wired
`fn_ad_stats` and reported both as done, which is the same confident-claim
failure the whole system exists to end — worse here, because it was a claim
about a fix for exactly that class of bug.

Chasing it down showed the function was the wrong shape anyway. It reports on
**the caller's own** impressions: right for a player debugging their own
screen, useless in a staff-only panel, where it would have answered "is this
one staff member capped". So it was never going to be wired, and the honest
correction is not to force a caller on it.

`20260828055000` replaces it with `fn_ad_suppression()`, which counts **people**
per placement over the rolling 24h window:

```
ad                slot             cap   served  capped
diamonds_store    lobby_strip       3      5       2
spins_jackpot     hub_promotions    3      2       1
referral_invite   session_summary   1      1       1
```

That last row is the point: a placement with a cap of 1 has already gone silent
for the only person who ever saw it. The panel now shows "N Of M Capped Out"
beside a placement, and only when N is above zero — a "0 Capped" on every row
would be noise.

A silent surface finally has three distinguishable causes instead of one
silence: no placement (already shown as "Not Placed"), no audience match
(served and capped both zero while the campaign is live), or everyone capped
(capped high, served flat).

## The cap index no longer matched the cap query

`idx_ad_event_cap` was `(user_id, ad_id, created_at DESC)` — built for the
Phase 1 predicate. The per-surface fix added `AND e.slot = pl.slot` and left
the index behind, so `slot` and `event_type` were filtered after the fetch, on
every candidate advert on every page load of every surface.

Rebuilt as `(user_id, ad_id, slot, event_type, created_at DESC)`, which is the
predicate exactly. Trivial at 160 rows; the cheapest possible moment to fix it
is before the table is large enough for anyone to notice.

## Why `fn_ad_stats` and `fn_ad_suppression` are staff-only

`ad_event` deliberately has no SELECT policy — one player must never be able to
enumerate another's viewing history. A `SECURITY DEFINER` function granted to
`authenticated` hands back exactly that in aggregate, so both functions are
granted to `service_role` alone and both migrations assert it. The admin API is
the only caller, and it authorises itself against
`profiles.role IN ('admin','super_admin')` before it ever runs one.

## Verification

```
npx tsc --noEmit                      clean
npx vitest run                        504 files, 0 failures
node --test house-ads-hub-promotions  13 passed
fn_ad_stats()                         9 rows across 2 slots, matching ad_event exactly
```

## Left open, deliberately

**Two Hub ad clients.** Mine (`hubAds.js`, the strip on `/hub`) and #903's
(`adService.js`, the rail on `/hub/promotions`). The surfaces are
complementary; the duplicated client is debt. Worth collapsing onto one, but
not by deleting another agent's merged work without a decision.

**`table_between_hands`** stays unwired. An advert near the felt competes with
the game itself.
