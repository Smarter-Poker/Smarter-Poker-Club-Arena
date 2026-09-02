# 2026-09-02: club boards fill from their own members (PR #2548)

Deep Stack Society (standalone club, 416 member horses) had zero Spins, zero
Heads-Up and a one-horse-per-table cash floor while Shark Club and Club JAQK
ran full. Everything below was found by auditing the engine against that club
and is shipped together because each one alone left the board dark.

## Engine (server/)

- `topUpWithHorses` refused every non-house board outright ("house-only").
  Removed: membership is the boundary, not the house. A club's seat-first
  games top up from that club's own members, a union's from its member clubs.
- Spin and SNG passes shared ONE `BURST` creation budget across the house and
  every owner, and broke out of the owner loop when it ran dry. Midway alone
  spent all 12 every tick ("44 still to fill"), so no club board was ever
  reached. Now one fresh `{ left: BURST }` for the house and for each owner.
  Pinned by `boardBudgetPerOwner.test.ts` and `clubOwnerSngBoards.test.ts`.
- Seat-first human window is 45-90 seconds (Dan 2026-09-01), was fixed.
- Seat-first held-empty share is 0.65 for Spins and Heads-Up, all owners:
  35% open-table rate max (Dan 2026-09-02).
- `createOpenSeatTable` seats openers for club boards too (was gated on
  `isHouseBoard`).
- Fleet: a horse is a candidate only for tables of clubs it is a member of
  (Dan 2026-09-02: "HORSES ARE ASSIGNED TO SPECIFIC CLUBS, NOT GLOBAL"). The
  DB entry gate already refused the buy-in; this stops the fleet wasting its
  seat budget on refused attempts. The 75/25 packing law itself landed on main
  in #2617 (`theFloorIsFull.law.test.ts`) and is taken as-is here.
- Maintenance break: an engine sitting between hands counts as parked
  (`isBetweenHands`), so idle tables no longer wedge the restart gate.

## Deploy workflow

- `auto-deploy-hetzner.yml` waits on wall clock for the next :55 break plus
  the drain window, instead of a fixed poll count that expired before the
  break arrived.

## Client (src/)

- `TournamentStartingTicker` scopes to the club you are standing in (or its
  union), not every membership; a Midway event was being announced in the
  Deep Stack lobby. Scope reads fail closed and report.

## Database (recorded here, applied to production)

- `20260902044316_rake_ledger_club_isolation_hard_guard.sql`: trigger on
  `rake_records` refusing any row whose club is not the owning club (or, for
  union-owned tables, a member club), plus `fn_rake_club_isolation_violations()`.
  Dan's hard rule: no club's data ever enters another club's ledger.
- `20260902052500_healer_time_budgeted_and_owner_fair.sql`: see
  `2026-09-02-healer-time-budget-owner-fair.md`.
