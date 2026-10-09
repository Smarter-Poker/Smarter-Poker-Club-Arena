# Lightning Phase 12: Responsible Gaming Limits at the Lightning Door, and the Auto-Rebuy Status Line

2026-10-09. Database carry-forward of the Lightning 2.0 handoff, Section 11 Order 2. Migration
`supabase/migrations/20261009143757_lightning_phase_12_responsible_gaming_limits_and_auto_rebuy_.sql`.
Branch `agent/claude-lightning-p12/lightning/rg-limits-db`.

## Item 1: Responsible Gaming Limits, Verified Against the Cash Path

The order was to make Lightning enforce exactly what normal cash enforces, through the same helpers,
and to record any gap rather than invent policy. What PokerIQ-Production carries on 2026-10-09:

| Fact                                 | Evidence                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responsible_gaming_limits` columns  | daily, weekly and monthly deposit limits, `daily_loss_limit`, `session_time_limit_minutes`, `reality_check_interval_minutes`, `self_excluded_until`, `cooling_off_until`; no stake-limit column, no mandated-break column; 0 rows                                                            |
| Cash sit-down, buy-in and rebuy path | `fn_cash_game_join`, `atomic_table_buyin` (and its maintenance gate body), `atomic_table_rebuy` (and its gate body) call no `fn_rg_*` helper and never read `responsible_gaming_limits`                                                                                                      |
| Cash seat door gate                  | only the account-restriction triggers `zz_restriction_seat_guard` / `zz_restriction_seat_revive_guard` (`fn_ca_refuse_restricted_entry` → `fn_ca_player_restricted`, refusing only under `ca_operator_policy.restrictions_enforced`), already mirrored by Lightning legality as `RESTRICTED` |
| `daily_loss_limit`                   | read by no function in the database                                                                                                                                                                                                                                                          |
| `session_time_limit_minutes`         | read only by `fn_rg_should_show_reality_check`, the World Hub's page-load predicate, which writes (force-closes the Hub's `responsible_gaming_sessions` row, appends `reality_check_shown_at`)                                                                                               |
| Deposit limits                       | read only by `fn_rg_check_deposit`, which nothing in the database calls; a rebuy is a club-wallet debit, not a deposit                                                                                                                                                                       |
| Lightning today                      | `fn_rg_require_not_excluded` (self-exclusion, cooling-off) at the pool door, in legality (`RG_EXCLUDED`) and in auto-rebuy before `atomic_table_rebuy`: a superset of cash                                                                                                                   |

So Lightning already enforces everything normal cash enforces, and more. No limit was invented.

### The Gap, Recorded

Stake limits, session-time limits, loss limits and mandated breaks are enforced by no normal cash door
on this platform, so Lightning does not enforce them either. Closing them is a platform decision for
both cash and Lightning at once, through one shared read-only helper (for example a
`fn_rg_require_within_limits(user)` that both `fn_cash_game_join` / `atomic_table_buyin` and the
Lightning doors call). Calling `fn_rg_should_show_reality_check` from the engine path was rejected
because it mutates the Hub's reality-check record. A live proof now pins the parity as containment:
every `fn_rg_*` helper the cash join and buy-in path calls must also be called by
`fn_lightning_pool_enter`, and every one the cash rebuy path calls by `fn_lightning_auto_rebuy`, so the
day cash gains a limit helper the proof turns false until Lightning calls it too.

### What Was Really Missing: the Limit Ends the Session Like Stop Playing

A player whose self-exclusion or cooling-off began mid-session was refused `RG_EXCLUDED` on every
matcher pass and then sat in the pool forever, open and never dealt. Now
`fn_lightning_reap_expired_disconnects` (already in `fn_cash_clusters_tick_all`) also finishes a session
whose player `fn_rg_require_not_excluded` refuses, under the Stop Playing discipline:

- the current hand is never cut short: a player in a live hand or holding a live reservation is skipped
  and exits on the first pass after the hand settles; legality already answers `RG_EXCLUDED` ahead of
  `IN_HAND`, so no new hand is dealt;
- never cashed out: the anchor seat, its chips and the cash session are untouched, exactly as a stop exit;
- the exit carries the distinct `exit_reason` **`rg_limit`**, one `pool_player_left` with reason
  `rg_limit`, and is never counted into `player_expired`;
- a standing Stop Playing request keeps `stop_playing`; frozen Clusters are skipped; SKIP LOCKED and
  per-item isolation as before.

## Item 2: the Auto-Rebuy Status Line

The client read `fn_lightning_config`, which is service_role only, so "Auto-Rebuy: ..." never showed.
`fn_lightning_pool_status(uuid)` (authenticated and service_role, SECURITY DEFINER) now answers one more
read-only key; `fn_lightning_config` keeps its grants.

```json
{
  "players": 0,
  "status": "BUILDING",
  "joinable": false,
  "multi_table_limit": { "desktop": 4, "tablet": 3, "mobile": 2 },
  "auto_rebuy": {
    "enabled": false,
    "trigger": "zero",
    "threshold_bb": 1,
    "threshold_pct": 25,
    "target": "initial",
    "max_count": 3,
    "session_cap": 0,
    "used_count": 0,
    "used_total": 0
  }
}
```

- `enabled`, `trigger` (`zero` | `below_bb` | `below_pct`), `threshold_bb`, `threshold_pct`, `target`
  (`initial` | `max`), `max_count`, `session_cap` (0 = uncapped) are exactly what `fn_lightning_config`
  answers, clamps included.
- `used_count` / `used_total` are the caller's own open pool session's `auto_rebuys` /
  `auto_rebuy_total` in that Cluster, `null` without one (and for a service_role caller).
- The existing keys are unchanged and `cluster_mode` is still never answered.

## Client Contract

- Status line: `Auto-Rebuy: Off` when `auto_rebuy.enabled` is false; otherwise
  `Auto-Rebuy: On (<used_count> of <max_count> used)` (for example "On (2 of 3 used)"), treating a
  `null` `used_count` as 0. A missing `auto_rebuy` key means a pre-Phase-12 database: show nothing.
- Ended notice: `exit_reason` `rg_limit` (from `fn_lightning_reconnect_state` state `ended`, or
  `fn_lightning_session_summary`) is a responsible-gaming ending, distinct from `stop_playing` and
  `disconnect_expired`. The seat pointer stays the player's (VIEW GAME, tap-only).

## Proofs and Tests

- Eight `@live-proof` lines: the reaper's rg*limit arm, grants and kept skips; all four Lightning RG doors
  call `fn_rg_require_not_excluded`; the cash parity containment; legality refuses `RG_EXCLUDED` before
  `IN_HAND`; the pool status shape and grants; `fn_lightning_config`, pool enter, legality and auto-rebuy
  still service_role only; the anti-manipulation pin (no integrity, shadow_comparison or quality* terms in
  the matcher bodies, the tick, the reaper and pool status); Law 10.5.
- Harness `scripts/dev/test-lightning-phase12-rg-limits.sh`: PostgreSQL 17, port 55560, the real chain
  through Phase 11, production's autorevoke trigger and default ACLs, humans and horses in every Cluster,
  applied twice, 10 sections. No predecessor proof is falsified; every Phase 10, Phase 9 remediation and
  Phase 11 proof holds in full (none becomes expected-false).
- Static test `tests/lightning-phase-12-rg-limits.test.ts`; schema fragment
  `scripts/ci/schema-manifest.d/lightning-phase12-rg-limits.json`; CI step on accounting_postgres
  shard 1 after the Phase 11 step.

## Doctrines

- Law 10.5: nothing reads `is_horse` or `horse_id`; a horse with a limit is held and exited exactly as a
  human and reads its own status exactly as a human.
- No money moves: the exit never touches a seat, a chip or a cash session.
- Lightning stays dark; non-Lightning cash play is unchanged.
