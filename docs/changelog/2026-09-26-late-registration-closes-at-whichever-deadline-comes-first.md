# Late Registration Closes At Whichever Deadline Comes First (2026-09-26)

## The Finding

While resolving a chip-conservation breach, "Sunday Funday Six-Card Closer"
(`c7f21a83-367c-459e-9639-067fa92516f5`, PLO6 freezeout) was found RUNNING at
level 3 on one table five days after its 2026-09-21 04:00 UTC start, still
answering `fn_tournament_late_registration_open = true`. It carries
`late_reg_levels 9` and `late_reg_mins 90`, so its advertised window closed at
05:30 UTC that night. On 2026-09-26 03:46 UTC, 53 of 338 RUNNING tournaments
answered open although their own clock deadline had passed.

Since #5253/#5268 a satellite delivery into a RUNNING target seats the winner
in the same transaction, so this answer admits real players.

## Every Decider, And How Each Decided (Before)

| Decider                                                                                                                                                                                                                     | Where                | Rule before                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------- |
| `fn_tournament_late_registration_open`                                                                                                                                                                                      | DB                   | Level cap only when one exists; clock only without a level cap |
| Wallet, ticket and horse registration doors, `fn_ensure_late_registration_capacity`, `fn_award_satellite_seat`, `fn_deliver_satellite_ticket_exact`, `fn_settle_satellite_tournament` gate, `fn_ca_settle_satellite_cohort` | DB                   | Delegate to the predicate above                                |
| GameServer late-ticket horse discovery                                                                                                                                                                                      | Engine               | Calls the predicate above                                      |
| `TournamentBrainContext.lateRegistrationOpen`                                                                                                                                                                               | Engine (horse brain) | Mirror of the predicate: level first, clock as fallback        |
| `tournamentEntryWindowOpen`, `lateRegEndMs` (lobby, HUD, info panel, ticker, club home, filters)                                                                                                                            | Client               | Mirror of the predicate: level first, clock as fallback        |
| `fn_close_tournament_entry_window`, `trg_tournament_pool_finalization_window_guard`                                                                                                                                         | DB                   | Pool-finalization schedule: level first, clock as fallback     |

## The Rule, From The Code's Own Intent

`late_reg_mins` is derived from the same ladder as `late_reg_levels` by every
producer (`mttLateRegistrationMinutes`, `lateRegLevelsForMinutes`: "an event
never runs late registration longer than the hour it advertised"). None of the
106 REGISTERING events carrying both has a clock shorter than its level window.
`fn_thaw_platform_checkpointed` deliberately never shifts
`started_at + late_reg_mins` across the hourly break, so the configured clock is
a wall-clock deadline by design and nothing needs deriving.

So late registration is open only while every configured window is open: the
level cap, when configured, AND the clock, when configured. Whichever deadline
passes first closes it. Levels-only and clock-only events answer exactly as
before.

## The Fix

- `20260926035534`: `fn_tournament_late_registration_open` requires both
  windows. One `CREATE OR REPLACE`, byte preimage and ACL asserted, post-apply
  assertions that no RUNNING tournament admits past its clock and that the
  Closer reports closed. Every door that delegates to it agrees automatically.
- Engine: `TournamentBrainContext.lateRegistrationOpen` mirrors the new rule.
  Blind acceleration still follows the manager's own entry-close state.
- Client: `tournamentEntryWindowOpen` requires both windows, and `lateRegEndMs`
  reports the earlier of the level estimate and the clock.

## What A Closed Target Does To A Satellite Winner

Both delivery authorities already classify a RUNNING target the predicate
calls closed as `delivery_kind 'cash'`: the winner is paid the funded ticket
value instead of a seat. Proved on a PostgreSQL 17 copy of the production
catalog (byte-identical `fn_settle_satellite_tournament`, gate and predicate):
with the old predicate the settlement picked the seat path for a target five
days past its clock; with the new one it completed with `cash`, the winner's
wallet went 200.00 to 300.00, and the target roster was untouched.

## The Deliberate Boundary

`fn_close_tournament_entry_window` and the pool-finalization guard keep their
schedule. Switching them now would, at the next blind transition, finalize the
pools of the 53 stalled events, open add-on periods in 24 of them and wedge 25
rebuy events on the finalization guard: changes to running tournaments this
fix must not make. Their disagreement is one-directional and safe: a pool can
stay unfinalized after admission has closed, never the reverse, because the
predicate refuses a finalized pool. Re-entry and rebuy windows
(`fn_ca_tournament_rebuy_window`) are a separate contract and are unchanged.

## Regression Protection

- `scripts/ci/test-late-registration-clock.py` (CI, accounting PostgreSQL job):
  production's installed predicate and its three real dependencies in owned
  PG17. RED asserts the old predicate admits exactly the four defect shapes;
  GREEN applies the migration from its file and checks 18 shapes, including
  past-clock-early-level (closed), inside both windows (open) and level cap
  inside the clock (closed); preimage drift and a second apply are refused.
- `tests/unit/tournamentEntryWindowProjection.test.ts` and
  `server/src/services/TournamentBrainContextCache.test.ts`: fail on the old
  source, pass on the new. Two old pins encoded the defect and are replaced in
  the same commit: "keeps a level window open through a long break"
  (`tournamentEntryWindowProjection`) and "uses the level window when both
  windows are configured" (`lobbyMttTitle`, which expected the LATER close).
  A new pin keeps the level window when it is the earlier deadline.
