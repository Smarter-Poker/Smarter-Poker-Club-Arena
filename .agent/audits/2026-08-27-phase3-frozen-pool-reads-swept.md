# Phase-3 sweep — the same bug, eleven more times: balances read off a frozen pool

Date: 2026-08-27 · Agent: cowork-mobile · Scope: CA client + server, World Hub API, Supabase

Follow-on to the phase-2 audit (PR #1424), which retired the nightly
reconciler's per-wallet check of the FROZEN `public.wallets` pool. Dan: "look
for any other similar bugs, gaps, stubs, errors, regressions or wiring issues
like the ones you just caught."

## The headline: CLAUDE.md 11.5 said "nothing reads it". Eleven sites did.

`public.wallets` has taken no write since **2026-08-21 00:59 UTC**. Measured on
production during this sweep:

|                    | frozen `wallets` | live pool                                    |
| ------------------ | ---------------- | -------------------------------------------- |
| PLAYER total       | 732,581,244.32   | 121,018,710.03 (`club_members.chip_balance`) |
| one sampled player | 3,313,727.73     | 34,818.60                                    |
| last write         | 2026-08-21 00:59 | seconds ago                                  |

The frozen pool holds **six times the chips that exist**, and the sampled
player's figure was **95x** their real balance.

### Why six days of reads went unnoticed

The deprecated-table gate (`scripts/ci/check-deprecated-tables.mjs`) was built
after five features read dead tables and rendered zeros. `wallets` defeats that
detector twice over:

1. it is not registered, and
2. **it still HOLDS numbers**, so its reads never produce the tell-tale zero.
   They produce stale, plausible, correctly-formatted lies.

A DB-level sweep for the same shape (`pg_stat_user_tables`: read, never
written) initially returned EMPTY — because the first version of that query
filtered `n_live_tup > 0`, and planner stats report the frozen table as 0 rows
while it holds 1,852. The detector was fixed and control-tested against the
known-bad table before its result was trusted. Corrected, it surfaced
`wallets` at 8,501 reads / 0 writes.

## Sites fixed (all repointed to the live pools)

| Site                                       | What it did wrong                                                                                | Severity                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `WalletService.getBalances`                | fed `useWalletStore` -> `useCanAfford` and PlayerWalletPage's "Playable Now" / "Chips In Escrow" | HIGH — a play-affordability gate on 6-day-old numbers                                     |
| `WalletService.readPlayerBalance` fallback | on RPC failure answered from the frozen pool                                                     | HIGH — a confident wrong number can authorise a spend                                     |
| `WalletService.ensureWalletsExist`         | upserted rows INTO the frozen pool                                                               | MED — a money path writing the dead pool (11.5 forbids); harmless only because it wrote 0 |
| `ChipTransferModal`                        | showed an agent each recipient's frozen balance                                                  | HIGH — the number an agent reads when deciding how much to send                           |
| `ChipFlowService.transferChips`            | post-transfer "final balances"                                                                   | MED                                                                                       |
| `ChipFlowService` union->club allocation   | returned owner balance                                                                           | MED                                                                                       |
| `ChipFlowService.resetBalance`             | read frozen, then deducted against it                                                            | HIGH — reset the wrong amount                                                             |
| `ChipFlowService.auditTotals`              | SUMMED the frozen pool                                                                           | HIGH — the one function whose job is "how many chips exist" reported 6x                   |
| `SettingsPage` data export                 | exported frozen rows as the player's own record                                                  | MED                                                                                       |

Live mapping used throughout, verified against the schema and the server money
paths: PLAYER -> `club_members.chip_balance` (+`locked_chips` at tables),
PROMO -> `club_members.promo_balance`, BUSINESS -> `agents.agent_wallet_balance`;
`fn_player_spendable_balance` remains the only answer to "what can this player
SPEND at this table".

## Two defects found in MY OWN patch, by the house rules

1. **Unordered paging.** `auditTotals` pages with `.range()`; my first version
   had no `.order()`, so rows could be served twice or skipped across pages —
   in a function that sums chips. `tests/unit/clubMemberStatus.test.ts` (written
   after ten horses vanished from a cashier) caught it. Now ordered by the
   composite key. A second round of that rule fired on the _comment_ I wrote to
   explain the fix: it contained the text ".range()" and a semicolon, and the
   rule reads a chain by slicing to the next semicolon. Prose moved above the
   statement.
2. **`?? 0` on an unknown balance.** `TablePage`'s bust-rebuy read did
   `setBustWalletBalance(r.balance ?? 0)`, collapsing "could not find out" into
   "you have no chips" — the exact defect the 2026-08-25 audit removed from the
   tournament sign-up gate, surviving at a site that audit did not reach. It
   matters more now that `readPlayerBalance` answers null instead of a stale
   number. The state was already typed `number | null`; the `?? 0` was the only
   thing stopping the dialog saying "unknown".

## Durable guards (the half that outlives this PR)

- `wallets` added to the CI deprecated-table gate. **Proven to bite**: a probe
  file reintroducing the read exits 1 and names the replacement; removing it
  exits 0.
- `wallets` registered in the DB `deprecated_tables` registry (migration
  `register_wallets_as_deprecated_table`), so the schema carries the same fact.
- New `tests/unit/BalancesComeFromTheLivePool.test.ts` (7 specs) pins the
  behaviour. **Mutation-tested**: reverting the multi-club sum to a single row
  turns it red.
- Two source-pinning specs in `tourneyUxSweep20260825` updated in the same
  commit (they pinned the deleted fallback); their INTENT was verified to still
  hold — `signUpDialog` treats null as unknown and does not disable Confirm.

## Checked and found HEALTHY (not fixed, because not broken)

- `check-stranded-writers`, `check-phantom-tables`, `check-phantom-columns`,
  `check-bus-wiring`: all pass.
- `blacklists` — 7,191 reads, 0 rows. NOT a dead table: `BlacklistManagerPage`
  inserts/deletes it and three enforcement points read it. Zero rows means
  nobody has been blacklisted yet.
- `messages` — 0 rows, 1,484 reads. Has a matching writer
  (`PlayerStatusService`). An unused feature, not a broken one.
- Config/reference tables read-but-rarely-written (`feature_pricing`,
  `training_achievement_definitions`, `daily_challenge_catalog`,
  `tournament_schedules`, `solver_manifest`, `autofix_config`) — correct by
  design.
- No `it.skip`/`describe.skip` hiding unbuilt features (all skips are
  conditional e2e guards), no `not implemented` stubs, no empty catch blocks in
  `src/services` or `server/src/engine`.

## OPEN — measured, deliberately not fixed here

- **`union_clubs`: 6,590,684 reads, 2 rows, 0 writes.** Read from ~20 sites
  including `HorseOrchestrator` (x3), which runs continuously server-side. Not
  a dead table — a hot-path re-query of a 2-row mapping. A caching fix is a
  real win but is engine-touching design work, and does not belong bundled into
  a money-path PR. Recommended as its own task.
- **Seat exit #15448** (from phase 2): 55 chips left the felt uncredited via a
  direct postgres-role write. Returning them is a financial decision — Dan's.
- **585 authenticated-executable SECURITY DEFINER functions** (61 anon). Needs
  a per-function audit with call-site evidence, batched; a blanket revoke would
  break legitimately public reads.
