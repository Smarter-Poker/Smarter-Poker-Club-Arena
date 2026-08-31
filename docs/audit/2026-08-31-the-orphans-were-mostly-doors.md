# The Orphans Were Mostly Doors

**Date:** 2026-08-31 · **Phase:** 7 of 8 · **PR:** see the changelog

## The number was wrong

Phase 2 built `everyRouteIsReachableLaw.test.ts` and it reported the truth it was
asked for: 24 routes exist that no navigation surface links to. That figure then
travelled through two handoffs as **"24 built pages reachable from nothing, about
9,900 lines, including UnionDashboard at 3,105"** — and it is wrong, because the
ratchet counts ROUTES and the sentence describes PAGES.

Reading what each of the 24 actually renders:

| What it really is                                          | Count |
| ---------------------------------------------------------- | ----- |
| A legacy redirect. No page at all                          | 12    |
| A second door onto a component already reachable elsewhere | 3     |
| A real page with no door                                   | **9** |

`UnionDashboardPage` is the clearest case. Its 3,130 lines have never been
invisible: they serve at `/unions/:unionId/operations`, which the unions surface
links. What was orphaned was `union-dashboard`, the unparameterised twin that
guessed a union for itself. The same is true of `union-games`, and of
`clubs/:clubId/dashboard`, which rendered the identical `ClubDataPage` that
`clubs/:clubId/data` renders from the operations rail.

The twelve redirects are not pages either. Four (`agent-management`, `players`,
`data`, `invite`) go through `LegacyClubToolRedirect`, which resolves the
visitor's club and forwards to the club-scoped tool. Four `messages/*` routes
forward to the World Hub messenger. Three are plain `<Navigate>`. One,
`notification-center`, was retired by Dan on 2026-08-25 with the note _"we need
ONE DISPLAY"_ — it has been a redirect ever since and was still being counted as
an orphaned product page.

**Being unreachable from navigation is the POINT of a legacy redirect.** Nothing
should link to an old URL. Filing them as orphaned product pages did not just
inflate the number; one entry was factually false. `agent-management` was
recorded as _"renders RateAuditPage, which also owns /rate-audit"_, and it has
not rendered `RateAuditPage` for some time.

This is the same failure this eight-phase effort keeps finding, in a new place: a
mechanism that measured honestly, and a description of its output that nobody
re-checked.

## What the database said about the nine

The pages carry no evidence about whether anyone wants them. Their tables do.

| Page                  | Lines | Its data, counted in production                      |
| --------------------- | ----- | ---------------------------------------------------- |
| `AgentDashboardPage`  | 1,546 | `agent_commissions` **1,490,109** rows, `agents` 113 |
| `SuperAgentDashboard` | 546   | same network, club-scoped                            |
| `WaitlistPage`        | 313   | `table_waitlist` **10,055** rows                     |
| `RakebackDashboard`   | 535   | `rakeback_periods` **4,428** rows                    |
| `AntiCheatPage`       | 1,175 | `anti_cheat_flags` 12, `anti_cheat_events` 6         |
| `PlayerSessionsPage`  | 1,482 | reads `club_members`, `chip_transactions`            |
| `XMTTPage`            | 551   | `tournaments` 7                                      |
| `FlashPoolPage`       | 450   | `flash_pools` 4                                      |
| `ReportPlayerPage`    | 174   | `user_reports` **0**                                 |

Two rows decided most of the phase.

**1,490,109 commission rows against 113 agents, and no door.** The agent system is
not a prototype; it is one of the busiest things in the database, and the only
way to look at it was to know the URL.

**Zero reports, ever.** `ReportPlayerPage` writes `user_reports` and
`clubs/:clubId/reports` reads it — and that review page IS reachable from the
operations rail. So the club had a moderation queue that could never receive
anything, because the form had no link. The count is the proof: not "rarely
used", **never used, not once**.

## The decisions

Dan's calls, 2026-08-31:

| Page                                                | Call                                             |
| --------------------------------------------------- | ------------------------------------------------ |
| `agent-dashboard`, `clubs/:clubId/agent-dashboard`  | **Connect both**                                 |
| `anti-cheat`                                        | **Connect**                                      |
| `report/:playerId`                                  | **Connect**                                      |
| `rakeback-dashboard`, `player-sessions`, `waitlist` | **Retire as redirects**                          |
| `xmtt`, `flash-pool`                                | **Parked** — a launch decision, not a wiring one |

The three retirements follow the ruling Dan already made for
`notification-center`: one display per thing. `RakebackDashboard` was a second
rakeback view beside `/rakeback`. `PlayerSessionsPage` was a global twin of
`clubs/:clubId/members` that resolved a club for itself — which is exactly what
`LegacyClubToolRedirect` does for the other legacy operator URLs, so it joined
them rather than keeping a second answer to the same question. `WaitlistPage` was
a second view of a queue that 10,055 rows say is joined from the lobby and table.

Nothing was deleted. Every retirement is a redirect, so bookmarks and old push
payloads still land somewhere real.

## Anti-cheat needed a club before it could have a door

`AntiCheatPage` was global. It took its club from `?club=`, and failing that from
whichever `club_members` row came back first. That is a reasonable guess for a
typed URL and the wrong answer the moment the page is opened from a particular
club's operations rail.

So it gained `clubs/:clubId/anti-cheat`, and the page now reads the route param
first. The bare `/anti-cheat` becomes a `LegacyClubToolRedirect` like the four
before it. Every club tool in this codebase is club-scoped in its URL; this one
now is too.

## Verification

Each connection was proven by breaking it. Removing the Report button, the two
operations-registry entries, or the hamburger entry each turns
`everyRouteIsReachableLaw` red, naming the exact route that lost its door, and
restoring it turns it green. A page is only connected if the ratchet can tell
when it stops being connected.

`globalHeaderRouteAudit` pins three exact route counts and moved 126→127,
118→119, 119→120 for the one route added. Updated in the same commit, per
CLAUDE.md §5.8.

Client suite 746 files / 10,485 tests pass. `tsc --noEmit` exit 0. Ten house
gates OK.

## The ratchet

**24 → 2.** The ceiling assertion falls to 2, and what remains is honest: `xmtt`
and `flash-pool`, both real, both built, both parked by name.

The list's other entries are now described by what they are — legacy redirects
and retired duplicates — rather than filed under a label that made the estate
look like it had ten thousand lines of invisible product. It had about 6,300, and
most of it now has a door.
