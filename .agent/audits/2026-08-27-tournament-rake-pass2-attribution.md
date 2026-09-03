# Tournament Rake Deep Audit — Pass 2: Attribution + Creation Caps (2026-08-27)

Continuation of `.agent/audits/2026-08-26-tournament-rake-deep-audit.md`, this
time over every place the first pass had not read line-by-line: the rakeback /
VIP / agent-commission consumers, the weekly union close, tournament creation
(`fn_create_tournament`, schedules, the WH horse-launch endpoint), tickets,
bounty collection, mystery bounty settlement, payout reconciliation, chip
conservation, and the spin sweeps.

## Found and fixed

1. **Tournament fees earned nobody anything.** Three consumers attribute rake
   to the players who generate it, and all three were starved for tournament
   fees because the till paths never write `player_contributions`:
   `trg_award_vip_points_from_rake` ("1 pt per rake chip") read NULL and
   awarded nothing; `RakebackSettlerService` filters
   `player_contributions IS NOT NULL` — even though its own 2026-07-24 fix
   comment says tournament/SNG fee rows are meant to credit agent commissions;
   `player_stats.total_rake` never saw a tournament fee. **Fix:** attribution
   now happens inside `fn_settle_tournament_rake`, at settlement — fees are
   final there (reversals netted), the PK claim makes it exactly-once, and a
   register/unregister loop can no longer farm points or commissions the way
   till-time attribution would have allowed. Per-user net comes from
   `rake_records` metadata; Spin house rake (user-less rows) splits equally
   across the seats, mirroring `fn_union_tournament_rake_by_user`. Horses are
   excluded. VIP points (floor(net), keyed per tournament+user), agent
   commission (`credit_agent_commission_from_rake`, deterministic source_id),
   and `player_stats` (via `apply_rakeback_player_stats`, hands = 0) all land
   in the settle transaction; attribution is best-effort behind an exception
   guard so a failure alerts instead of rolling back the wallet credit.
   Applied going forward only — retro-crediting 60 days of commissions is a
   policy decision deliberately left to Dan.
2. **`fn_create_tournament` breached the cap and broke x5 prices.** Fee was
   `round(total * 0.1)`, so any owner-created event priced 15/25/35/… computed
   an over-cap fee and DIED on the `tournaments_rake_within_10_pct` CHECK with
   a raw SQL error. It also charged SNGs 10% against Dan's 5% Heads-Up rule.
   **Fix:** cents floor; 5% when type = sng; 10% otherwise (spin stays 0).
3. **Every Heads-Up priced from a schedule paid 10% instead of 5%.**
   `ScheduledTournamentService` split all non-spin buy-ins at
   `DEFAULT_RAKE_RATE`. Production carried thousands of 45+5 Heads-Up rows
   until the recurring generator was fixed on 08-25 — but the scheduled path
   was still wrong, and `SNG_RAKE_RATE` lived only inside
   `TournamentRecurringService`. **Fix:** `SNG_RAKE_RATE` moved to
   `config/buyIn.ts` (both mirrors), re-exported for existing importers,
   scheduled sng splits priced with it, and the mirror test pins 50 → 47.50 +
   2.50 and 1 → 0.95 + 0.05 (Dan's own worked example). No open mispriced
   rows remained in the lobby at audit time.
4. **`fn_collect_bounty` paid a head for a ghost** — an eliminated player with
   no `tournament_players` row fell through to the tournament's default
   `bounty_amount`. **Fix:** refuses with `eliminated_player_not_in_tournament`.
5. **`fn_spin_sweep_unbooked` carried its own copy of the Spin rake bands** —
   the three-tables-that-disagree failure mode spinSpec.ts exists to prevent.
   **Fix:** one SQL home, `fn_spin_rake_rate(buy_in)`, asserted against the
   spec bands in the migration.
6. **Club dashboards under-reported tournament rake** — the cash path bumps
   `club_wallets.period/lifetime_rake_collected`; the tournament path never
   did. **Fix:** counters-only bump in the settle transaction (no
   chip_balance movement — the money itself lands in the union rake wallet or
   club treasury as before).

## Checked and found sound

`fn_union_weekly_rakeback_close` (keys on structured columns — unaffected by
the new settlement note format; solvency headroom confirmed; the swept
backlog lands in the current period as a make-good), `fn_union_rake_basis_by_club`
and `fn_union_tournament_rake_by_user` (metadata attribution nets reversals
correctly), tournament tickets (conserving escrow, idempotent, role-gated),
`fn_mystery_bounty_settle` (conserving, idempotent, champion residual),
`fn_collect_bounty` pool math (funded cap + PKO half-split conserve),
`fn_tournament_payout_reconcile` (idempotent keys, no clawback, alert dedupe),
`fn_tournament_payout_sweep`, `fn_upsert_tournament_schedule` (fee derived
downstream), `atomic_distribute_rake` (cash path; distribution legs idempotent).

## Documented, deliberately not changed

- `pages/api/club-arena/horse-launch.js` (WH) authors fee-on-top splits but
  has created zero tournaments ever — dormant; not worth a WH deploy. If it
  is ever revived, derive its splits from the total via `splitBuyIn`.
- `fn_tournament_chip_conservation_check` ignores early-bird bonus chips, so
  early-bird events can read as drifted — advisory-only surface, and the
  per-player bonus is not reconstructible after seating.
- Player rakeback MONEY basis (rakeback_periods) still excludes tournament
  fees. Including them raises club rakeback costs — a policy call for Dan,
  not something to move silently. The stats/commission/VIP wiring above is
  the documented-intent part.
- Historical (pre-2026-08-27) tournaments get no retroactive VIP points or
  agent commissions.

## Verification

Migration `tournament_rake_attribution_and_creation_caps` applied to
production with self-asserting DO blocks (band values, attribution presence,
create-fee fix, ghost guard, sweep single-sourcing). Engine changes shipped
via PR with the mirror test extended (15 tests green) and both tsconfigs
clean. Post-deploy: settlements report `attributed_users`, and
`vip_points_ledger` rows with source_type `tournament_rake` /
`agent_commissions` rows with source_type `tournament_rake_settlement` are
the DB-visible proof the new code is executing.
