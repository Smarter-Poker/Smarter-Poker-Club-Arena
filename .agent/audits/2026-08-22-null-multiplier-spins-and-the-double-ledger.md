# Audit — three spins with no draw, and the phantom prize rows nobody had looked for

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena · **Author:** Claude (Cowork session)
**Handed off by:** `.agent/handoffs/2026-08-22-union-reserve-and-shipping-from-cowork.md`
§3.3, §6.7, §6.8 — plus one finding that document does not contain.

---

## 0. WHAT WAS ASKED, AND WHAT WAS ACTUALLY WRONG

Three items came in. One was already closed, one was a genuine live bug, one
was cleanup — and chasing the live one down surfaced a fourth that is larger
than all three.

| Item                                                           | Status on arrival                                                                                    | Outcome                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **PR #178** — "needs an agent, genuine conflict"               | already **MERGED** 2026-08-22T07:10:50Z as `fix/hero-card-row-assertions`; zero open PRs on the repo | nothing to do                                                  |
| **§6.7** three spins with `spin_multiplier = NULL`             | real, and worse than described                                                                       | root-caused, engine hardened, rows repaired                    |
| **§3.3 / §6.8** `20260821_challenge_rerolls.sql` never applied | real                                                                                                 | **deleted** — see §3 for why applying it would have been wrong |
| **(new)** duplicate prize ledger rows                          | not known                                                                                            | 95 phantom rows / 7,446.45 chips in two days; fixed            |

---

## 1. §6.7 — THE DRAW THAT NEVER HAPPENED

### 1.1 What was found

```
dea62e98  1 Chip Spin PLO4   started 2026-08-21 17:44:24Z   prize_pool 3.00
a374cdd3  2 Chip Spin NLH    started 2026-08-21 17:44:24Z   prize_pool 6.00
78181713  3 Chip Spin NLH    started 2026-08-21 17:44:21Z   prize_pool 9.00
```

All three: `COMPLETED`, three seated players, one table, three paid buy-ins
each, a prize credited to first place — and `spin_multiplier` NULL, no
`spin_reserve_ledger` row, no `rake_records` row. The games ran. The house took
nothing and the reserve saw nothing.

### 1.2 The proof that the Spin block never executed

Not inference — the rows say it directly. Four independent marks:

1. **`prize_pool` is what registration accumulated, not what the draw wrote.**
   `fn_register_*_for_tournament` adds one buy-in per entry, giving exactly
   `seats x buy_in` = 3.00 / 6.00 / 9.00. The engine writes
   `Math.round(buyIn * multiplier * 100) / 100`.
2. **The two decimals.** Postgres `numeric` keeps the scale it is handed. Every
   healthy Spin that hour stores `40`, `3`, `10`; these three store `3.00`,
   `6.00`, `9.00`. Different writer, visible in the column itself.
3. **`starting_chips` is the creation-time placeholder** (300), not the tier
   stack the draw would have set.
4. **`spin_locked_tiers` is NULL**, which only the draw populates.

### 1.3 Root cause: version skew across a restart, not a logic defect

The three were created 17:32:59–17:33:02, stood down at the paid-entry gate
while their batch-mates started at 17:33:32, were funded at 17:43 and started
11 minutes later. `c43d97c9` started at **17:44:23.575 — between two of them —
and drew normally**, and everything from 17:44:37 on drew normally. Two engine
processes were briefly alive at once across a restart, and the older one had no
draw-at-start.

The hourly counts settle it:

```
2026-08-21 13:00  32 started   0 null       17:00  72 started   3 null
2026-08-21 14:00  81 started   0 null       18:00  80 started   0 null
2026-08-21 15:00  91 started   0 null       ...    every hour   0 null
2026-08-21 16:00  84 started   0 null       2026-08-22 17:00 43 started 0 null
```

Three, in one 14-second window, in 28 hours of otherwise clean operation.

### 1.4 The durable defect was not the skew — it was that nothing could repair it

`fn_spin_sweep_unbooked` filtered `COALESCE(spin_multiplier, 0) > 0`. It
therefore skipped **precisely the rows that most needed it**, and `unbooked_24h`
in `v_spin_reserve_health` aged them out after a day. A Spin that ran without a
draw was invisible after 24 hours and unbookable forever. That is the part that
had to change, and it would have been true of the next occurrence whatever
caused it.

Separately, the single `.update()` in `TournamentManagerBase` that carries the
**entire** result of the draw — multiplier, pool, stack, blinds, payout shape —
was fire-and-forget. Its result was never read. A start that lost that one write
produced this exact row state, and said nothing.

### 1.5 What shipped

- **`fn_spin_repair_missing_multiplier(p_lookback_mins)`** reconstructs the
  multiplier from the money that actually moved — `prize_pool / buy_in_amount`
  — and accepts it **only when it lands exactly on a published tier**. That is
  not a guess: it is the ratio the winner was actually paid. When it does not
  land on a tier the row is left alone and a `critical` `financial_alerts` row
  is raised, because inventing a multiplier writes fiction into the money
  ledger. The `UPDATE` is CAS-guarded on `spin_multiplier <= 0` so it can never
  overwrite a real draw.
- **`fn_spin_sweep_unbooked` calls it first**, keeping its signature. The
  deployed World Hub cron (`pages/api/cron/spin-sweep.js`) gains the repair with
  no reader change — the §6.6 ordering lesson applied in the safe direction.
- **`v_spin_reserve_health` gains `null_multiplier_24h`.** Additive; every
  column the deployed reader selects is asserted still present by the
  migration's own post-apply block.
- **The engine now retries and checks that write** three times and reports
  `Tournament.spin_draw_row_write_failed` if it still does not land. The game
  still starts — Dan 2026-08-19, tournaments run, they do not cancel — but it
  is loud, and now repairable.

### 1.6 The three rows

Repaired to `spin_multiplier = 3`, which is what each of them actually paid
(3.00/1.00, 6.00/2.00, 9.00/3.00, and 3 is a published tier). **No money was
moved.** They are 24h past the sweep's 180-minute lookback, so nothing books
them automatically; retroactively moving reserve money is Dan's call, not a
migration's. Production now reports **0** spins in `RUNNING`/`COMPLETED` with a
null multiplier.

---

## 2. THE FINDING THAT WAS NOT IN THE HANDOFF — phantom prize ledger rows

### 2.1 How it surfaced

`a374cdd3`'s winner has **two** `prize` credits of 6.00, 0.93s apart. Widening
the query turned three rows into a pattern.

```
completed tournaments, 2026-08-21 00:00Z onward
  3,587 (tournament, player, amount) prize groups
     95 of them credited TWICE
7,446.45 chips of prize money in the ledger that was never paid
```

Every single one is the same pair, always place 1, 0.06s to 0.7s apart:

```
"Tournament winner prize: 1st place"
"Tournament prize (recovery): position 1 — <name>"
```

SNG, SPIN and MTT alike.

### 2.2 The cause, and the irony of it

Every prize path in the engine is written as two calls:

```
credit_player_wallet(user, amount, key)   -- idempotent
log_wallet_transaction(... 'prize' ...)   -- NOT idempotent, always runs
```

`credit_player_wallet` dedupes correctly: it inserts the key into
`wallet_credit_idempotency` with `ON CONFLICT (key) DO NOTHING` and returns
early when the row already existed. Verified on the incident row — **one**
idempotency row at 18:12:32.553, **two** ledger rows at 18:12:34.090 and
18:12:35.024. Balances are correct. Nothing was minted.

But it `RETURNS void`. The caller cannot tell "I credited" from "someone else
already had", so it logs either way. The 2026-07-28 "A3 FIX" deliberately gave
the stuck-COMPLETING watchdog and the normal finish path the **identical** key
so they would dedupe against each other — and they do, for the credit. The fix
did not remove the double payment; **it converted a double PAYMENT into a
double ENTRY**, silently, and nothing had looked at it since.

The ledger is what profit, rakeback and the leaderboards are computed from, so
"only the ledger" is not a small blast radius.

### 2.3 Why the obvious fix would have been wrong

Returning a boolean and gating the log on it in TypeScript reintroduces the
same class of bug from the other side: every credit site sits inside a 3x retry
loop, so a committed-but-timed-out first attempt makes the second attempt see
`false` and write **no** ledger row at all. Trading duplicates for silent gaps
is not an improvement.

### 2.4 What shipped

- **`fn_credit_player_wallet_once`** — `credit_player_wallet`'s body, returning
  `boolean`. `credit_player_wallet` is now a thin wrapper over it: same name,
  same arity, same `void` return, same grants, so no existing caller changes and
  the crediting rules exist in exactly one place.
- **`fn_credit_and_log`** — performs **both halves under the one key**. It
  credits, and writes the ledger row only if the credit was its own. A retry
  after a committed call is a no-op for both halves, which is the property the
  callers already assumed they had. It refuses to run without a key.
- **Seven engine call sites** converted from the two-call shape:
  `TournamentManagerEliminations` (elimination prize, bounty, late-reg prize
  adjustment, winner prize), `TournamentManager` (satellite cash),
  `tournamentRecovery` (cancel refund, and the recovery payout that produced
  the phantom rows).
- Both new functions are `REVOKE`d from `anon` and `authenticated` and granted
  to `service_role` only — asserted by the migration and pinned by test.

### 2.5 Still open — the 95 rows already written

**Deliberately not touched.** They are an audit record, deleting ledger rows is
irreversible, and which of the pair to keep is a judgement about the books.
Recovering them is a one-statement job once Dan says which way:

```sql
-- the duplicates, newest of each pair, safe to inspect first
WITH t AS (SELECT id FROM tournaments
            WHERE status='COMPLETED' AND ended_at >= '2026-08-21 00:00Z')
SELECT w.related_entity_id, w.user_id, w.amount, count(*) AS n,
       array_agg(w.id ORDER BY w.created_at) AS rows
  FROM wallet_transactions w JOIN t ON t.id = w.related_entity_id
 WHERE w.category='prize' AND w.type='credit'
 GROUP BY 1,2,3 HAVING count(*) > 1;
```

Note the window above is bounded by `ended_at`; the unbounded version times out
because `wallet_transactions` has no index on `(category, created_at)`. Drive
any query on this table from a bounded tournament list and the
`idx_wallet_tx_entity_cat_created` index does the work.

---

## 3. §3.3 — `20260821_challenge_rerolls.sql` was deleted, not applied

The handoff says "apply it or delete it". Applying it was never an option. The
file is an abandoned draft that stops mid-thought:

```sql
    -- We use standard ledger mechanism if possible, or just update profiles diamond_balance
    -- Wait! Diamonds are in profiles or wallets?
    -- Let's check diamond_balances_read_only_to_players.sql or similar.
    -- I will just leave this part out until I verify where diamonds are stored.
END;
```

`fn_reroll_challenge` is declared `RETURNS boolean` and has **no return
statement and no diamond debit**. Applying it would have put a function into
production that takes a challenge id and a diamond cost, charges nothing,
rerolls nothing, and returns NULL. Nothing in the codebase calls it (the
phantom-RPC gate reports 0), so deleting it removes a trap and breaks nothing.

If challenge rerolls are wanted, they are a feature to be written — starting
with the question the file gave up on, which is answerable: diamonds live in
`wallets`, and the storefront mint path is documented in
`.agent/audits/2026-08-20-storefront-diamond-mint-hole.md`.

---

## 4. VERIFICATION

| Check                                             | Result                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/`                           | 233 files, **2,942 passed**, 5 skipped, 0 failed                                                                                             |
| New tests                                         | `prizeLedgerIdempotency.test.ts` (14), `spinNullMultiplierRepair.test.ts` (13)                                                               |
| `npx tsc --noEmit` (client + server)              | no error in any file touched; the 8 remaining are the known stale-`node_modules` phantoms of handoff §2.2 (`react-virtuoso`, `@sentry/node`) |
| `check-migrations-applied.mjs`                    | manifest regenerated, +12 lines, additions only                                                                                              |
| `check-phantom-tables.mjs`                        | 0 tables, 0 rpcs                                                                                                                             |
| `check-phantom-columns.mjs`                       | 0 phantom columns                                                                                                                            |
| Migrations applied to production                  | `credit_player_wallet_once_and_credit_and_log`, `spin_null_multiplier_repair` — both carry post-apply assertion blocks that passed           |
| Spins in RUNNING/COMPLETED with a null multiplier | **0**                                                                                                                                        |

Note on the manifest: `gen-schema-manifest.mjs` regenerated the **schema**
manifest cleanly but its `fn_columns_manifest` RPC timed out, so the columns
manifest is unchanged. That is correct here — these migrations add no table
column. If a future change does, re-run it until that RPC returns.

---

## 5. WHAT THE NEXT AGENT SHOULD PICK UP

1. **Wire the alert.** `v_spin_reserve_health.null_multiplier_24h` exists but
   nothing reads it. World Hub `pages/api/cron/spin-sweep.js` already alerts on
   `shortfall_events` and `unbooked_24h`; add this one beside them. Separate
   repo, separate deploy, small change.
2. **Decide the 95 phantom rows** (§2.5).
3. **Everything still open in the previous handoff** — §6.1 (tournament
   completion card for all spin finishers) is still the top of that list, and
   §6.5 and §6.6 are untouched.

## 6. HOUSEKEEPING OBSERVED, NOT ACTED ON

- `~/Documents/club-arena-2` holds 28 uncommitted files on
  `fix/members-loop-and-union-wallet`. Left alone deliberately: moving an agent
  off its own uncommitted work is what the new guard exists to prevent.
- The World Hub clone is behind on `ci/agent-autopilot` with one unpushed
  commit whose content is already on `main` under a different SHA.
