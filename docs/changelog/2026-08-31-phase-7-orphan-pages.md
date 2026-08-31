# 2026-08-31 — Phase 7 of 8: the orphaned pages get doors, or stop pretending to be pages

## Connected (4 routes, removed from the allowlist)

| Route                              | Where its door now is                                  |
| ---------------------------------- | ------------------------------------------------------ |
| `agent-dashboard`                  | Hamburger, Club Operations group, staff-gated          |
| `clubs/:clubId/agent-dashboard`    | Operations rail, People & Safety, as **Agent Network** |
| `clubs/:clubId/anti-cheat` _(new)_ | Operations rail, People & Safety, as **Anti-Cheat**    |
| `report/:playerId`                 | **Report** action on the public profile, beside Block  |

## Retired as redirects (6 routes, reclassified)

| Route                     | Redirects to                               | Why                                                         |
| ------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `rakeback-dashboard`      | `/rakeback`                                | Second rakeback display                                     |
| `player-sessions`         | club members, via `LegacyClubToolRedirect` | Global twin of `clubs/:clubId/members`                      |
| `waitlist`                | `/`                                        | The queue is joined from the lobby and table                |
| `union-dashboard`         | `/unions`                                  | `UnionDashboardPage` serves at `unions/:unionId/operations` |
| `union-games`             | `/unions`                                  | `UnionGamesPage` serves at `unions/:unionId/games`          |
| `clubs/:clubId/dashboard` | `clubs/:clubId/data`                       | Rendered the identical `ClubDataPage`                       |

## Reclassified, no code change (12 routes)

Twelve entries were filed as `ORPHANED PRODUCT PAGE` and are legacy redirects
with no page behind them. One reason was false: `agent-management` was recorded
as rendering `RateAuditPage`, which it has not for some time.

## Still orphaned (2)

`xmtt` and `flash-pool` — built, player-facing game modes. Parked by Dan on
2026-08-31 as a launch decision.

## Changed files

| File                                                     | What                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/App.tsx`                                            | 6 routes become redirects; `clubs/:clubId/anti-cheat` added; 3 dead lazy imports removed |
| `src/pages/AntiCheatPage.tsx`                            | Route param now beats the query param and the first-membership guess                     |
| `src/components/navigation/LegacyClubToolRedirect.tsx`   | `destination` accepts `anti-cheat`                                                       |
| `src/config/clubOperationsNavigation.ts`                 | Agent Network and Anti-Cheat entries                                                     |
| `src/config/clubArenaNavigation.ts`                      | Agent Dashboard entry in Club Operations                                                 |
| `src/pages/PublicProfilePage.tsx` + `.css`               | Report action beside Block                                                               |
| `tests/unit/everyRouteIsReachableLaw.test.ts`            | Allowlist rewritten; ceiling 24 → **2**                                                  |
| `tests/unit/globalHeaderRouteAudit.test.ts`              | Three route counts +1 for the new route                                                  |
| `docs/audit/2026-08-31-the-orphans-were-mostly-doors.md` | The record                                                                               |

## Verified

- Every connection proven by removing it: each turns `everyRouteIsReachableLaw`
  red naming the route that lost its door, then green on restore.
- Client suite **746 files / 10,485 tests pass**. `tsc --noEmit` exit 0.
- Ten house gates OK, including both title-case gates over the new nav labels.

## Not done

`XMTTPage` and `FlashPoolPage` remain built and unreachable, by decision. The
ratchet holds them at 2 and will not let the number rise.
