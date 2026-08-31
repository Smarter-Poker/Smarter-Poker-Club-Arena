# 2026-09-01 — config that lies

Five findings from a sweep of configuration that reads as authoritative and is
not. One gate added, one gate taught to see a whole class of failure it was
blind to, four dead objects retired as unapplied migrations, one latent alarm
re-verified and pinned.

## Shipped

### A parity gate between the database mirrors and the code

`scripts/ci/check-db-mirror-parity.mjs`. Every parity gate in this repo compared
a file to a file. Four production tables exist for no purpose except to be a
copy of the code, and nothing compared any of them to it:

| table              | mirrors         | who reads the mirror                                                              |
| ------------------ | --------------- | --------------------------------------------------------------------------------- |
| `ca_rake_schedule` | `RAKE_SCHEDULE` | `fn_effective_rake_cap`, i.e. the rake-law alarm                                  |
| `ca_rake_tier`     | `STAKES_TIERS`  | `fn_effective_rake_cap` fallback                                                  |
| `bbj_stakes_tiers` | `STAKES_TIERS`  | nothing — its only enforcement was a sentence in another script's failure message |
| `spin_tier_spec`   | `SPIN_TIERS`    | `fn_spin_fairness_check`                                                          |

The gate reads all four over PostgREST with the service key, diffs them
structurally against the arrays parsed out of the TypeScript, and probes
`fn_effective_rake_cap` against the engine's own cap rule at 35 stakes — which
is the check that catches DB _arithmetic_ drifting while every row still
matches. It runs in CI: `ci.yml` already passes `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` to four other steps, so no new secret. Without
credentials it skips loudly rather than reporting a pass it did not earn.

`tests/config/dbMirrorParityRule.test.ts` pins the other half of the chain: the
gate restates the engine's cap rule in JavaScript, and this asserts that
restatement equals the real `getRakeConfig` across the probe grid and a dense
sweep. Gate: production == the rule. Test: the rule == the engine.

### The migrations gate can see a data-only migration

`check-migrations-applied.mjs` verified that objects a branch's migrations
_declare_ exist in production. A migration whose payload is a `DELETE` or an
`UPDATE` declares nothing and passed green having never run — which is exactly
how the 5/5 rake row shipped in code and not in the database, for hours, with
every gate green.

It now also asks the production migration ledger (via the existing
`fn_ca_applied_migrations` RPC) whether each migration this branch _adds_ was
ever applied. What it still cannot do is verify the payload _did_ what it
claims: `public.exec_sql` is permanently disabled on this project by design, so
CI has no channel to run a migration's own `DO $$ ... RAISE EXCEPTION`
post-apply assertions against production, and re-creating one would hand
arbitrary SQL execution to any holder of the service key. Those assertions stay
where they already work — inside the migration, at apply time.

A migration meant to ship unapplied now says so in a way a tool can read:
`-- @unapplied: <reason>`. Every one is printed in a loud block in the CI log.

### Dead config retired (all four migrations are `@unapplied`)

- `vip_pricing` — 9 rows, all `is_active = true`, priced for bronze/silver/gold
  when the live vocabulary is lifetime/monthly/NULL, and read by nothing (its
  only reader `fn_purchase_vip_card` no longer exists). Set inactive plus a
  comment; the prices are kept because they are the only record of what a VIP
  card was meant to cost.
- `feature_pricing.vip_tiers_included` — deliberately **not** cleared and not
  dropped. Both destroy the only record of an intended entitlement, and the
  danger is that the column is silent, not that it exists. It now says in the
  schema that nothing reads it and that its values name a vocabulary no account
  holds. The product question goes to Dan.
- `tournaments.blind_speed` — `'standard'` on all 54,260 rows, and `'standard'`
  is not a key of `BLIND_STRUCTURES`. No reader anywhere, checked in both
  directions. The `DEFAULT` is dropped so new rows stop repeating the claim;
  nothing is backfilled, because there is nothing to backfill from.
- `ca_rake_tier.min_bb` and `bbj_stakes_tiers.min_bb` — commented as dead data.
  Tier selection is by `max_bb` on both sides, and honouring `min_bb` would
  leave every gap in the ladder with no tier at all.
- `PAYOUT_STRUCTURES.THREE` in `server/src/services/TournamentRecurringService.ts`
  — deleted. Zero references; `FIVE` has sixteen and `NINE` has five.

### The seat law survives an update

`20260901093000_the_seat_law_survives_an_update.sql` (`@unapplied`). The cash
seat law is enforced on INSERT only, by design, so nothing stops `max_players`
being raised past it afterwards. The new `BEFORE UPDATE OF max_players` trigger
refuses a change only when it is both illegal **and** larger than what was
there, so shrinking is always allowed and a table already outside the law stays
repairable rather than frozen by its own guard. It also moves the caps into
`fn_cash_seat_cap(text)` so the database stops carrying a second copy of them.

## Deliberately not changed

- **`fn_effective_rake_cap`'s 15-BB bound is not an opinion any more, and this
  was re-verified rather than taken on trust.** The engine acquired the same
  bound on 2026-08-31 (`UNSCHEDULED_CAP_BB`, derived from `RAKE_SCHEDULE`, and
  `unscheduledCapFor` in the pricing path), and `fn_unscheduled_cap_bb()`
  derives it the same way from `ca_rake_schedule` rather than hard-coding 15.
  All 35 cap probes agree against production today. The finding was real when it
  was written and is now closed; what was missing was anything to _stop_ it
  reopening, which is what the new gate is.
- **The `plo4` table at 9 seats was not touched.** No production writes.
  Re-measured before writing the guard: it is `closed` with zero occupied seats,
  so the "a hand might be in flight" objection does not apply — but repairing a
  specific row with 7,199 hands behind it is Dan's call, and it is in the pull
  request.
- **The database's copy of the seat law is still unguarded.** `check-seat-law-parity.mjs`
  holds the client, the server and `HorseFleetManager` together; the SQL copy is
  a fourth that nothing compares. This pull request reduces the database to one
  copy but does not add the gate — CI has no channel to read `pg_proc`.
