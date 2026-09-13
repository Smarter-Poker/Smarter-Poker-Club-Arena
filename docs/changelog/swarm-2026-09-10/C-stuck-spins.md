# C — Stuck Spins: root cause, engine loop, money, repair (ANALYSIS ONLY, nothing applied)

Project kuklfnapbkmacvwxktbh, measured 2026-09-10 03:09–03:25 UTC. Every write below ran inside a `DO … RAISE EXCEPTION 'PROBE_ROLLED_BACK'` block and returned the exception (rolled back). Nothing committed.

## 0. TL;DR

- **106** Spins (not 128) are stuck: `variant='spin'`, `status='REGISTERING'`, `max_players=3`, 3 seated+paid `tournament_players` (status `playing`, on the table), one open `tournament_launch_receipts` row, 1 `spin_reserve_ledger` `contribution`, 0 `jackpot_draw`, 0 `spin_draw_receipts`. Two clubs. **All 106 have `tournaments.spin_multiplier = 0`.**
- **Root cause (D1):** `fn_spin_draw_and_settle_atomic` (migration `20260909183856_spin_draw_books_one_funded_rule_receipt`, deployed 09-09 ~18:38 UTC) treats `spin_multiplier IS NOT NULL` as "a multiplier was already projected, refuse to redraw". But `tournaments.spin_multiplier` has **column DEFAULT 0**, and the creator every Spin now goes through, `fn_create_seat_first_game_atomic` (migration `20260908130000_seat_first_board_creation_is_one_transaction`), **omits `spin_multiplier` from its INSERT** even though the engine passes `spin_multiplier: null` in `p_config` (TournamentRecurringService.ts:4834). So every Spin created since 09-08 13:00 UTC carries `0`, and every launch since the atomic function went live is refused with `projected_spin_draw_has_no_funding_proof`. **Zero Spins have launched since 2026-09-09 11:44 UTC** (last `started_at`); `spin_draw_receipts` is empty (the atomic function has never succeeded in production). Every other reader on the platform (`fn_spin_tournament_contract_is_draw`, `fn_spin_repair_missing_multiplier`, `fn_spin_sweep_unbooked`, the old `fn_spin_draw_and_settle`) uses `COALESCE(spin_multiplier,0) > 0` as "drawn"; the new function is the odd one out.
- **Second defect (D2, probe-confirmed):** the atomic function's `at_draw` branch never stamps `tournaments.spin_multiplier / prize_pool / spin_locked_tiers` (the engine comment at TournamentManagerBase.ts:3438-3441 says "the atomic database authority already owns and stamped" them — it does not; the old `fn_spin_draw_and_settle` did). Fixing D1 alone would move the money (jackpot_draw + receipt) and then stall one step later: trigger `zzz_spin_ladder_is_the_drawn_one` refuses the engine's presentation patch with `23514 A booked Spin keeps its original multiplier`, and `proveTournamentLaunchSetup` (TournamentManagerBase.ts:2847-2861) refuses `rowMultiplier !== bookedMultiplier`. Probe 2 reproduced both halves.
- **Loop:** engine tries the RPC 3× (250/500 ms backoff), stands down (`running=false`), and `discoverSeatFirstStarts` (1 s interval) stops the not-running manager and starts a fresh one → 3 calls per ~3.6 s per Spin → 106 Spins ≈ 87 calls/s. `pg_stat_statements`: 163,460 calls, 8.24 ms mean, 1,347 s total CPU so far.
- **Chips:** 7,872.00 debited from 243 wallets (318 entries, all horse accounts — no human money, but the whole Spin product is dead for humans). 7,242.24 sits in the two reserve pools as `spin_entry` contributions, 629.76 is booked rake (`rake_records`, `treasury_credited=false`; escrow `fee_balance`). Escrow `prize_balance` = 0 on all 106.
- **Recommendation:** fix the function (DDL, orchestrator) — D1 + D2 together — and let the engine's existing loop launch all 106 through the platform's own draw/settle path. No data repair, no refund, no manual money movement. Also patch the creator to write `spin_multiplier = NULL` explicitly (D3, follow-up) so the column default can never leak again. Refund/cancel (option b) is not needed: pools hold 24k/56k chips, worst case draw 100×100 = 10,000 is affordable.

---

## 1. Population and causal chain (evidence)

### 1.1 The 106

```
np tps      nlr nlr_open nlease ncontrib ndraw nrcpt nent has_mult(=0) count  created (UTC 09-09)
3  playing  1   1        0      1        0     0     3    true         65     09:12:37 – 11:16:33
3  playing  1   1        1      1        0     0     3    true         41     09:12:37 – 11:44:33
```

(`nlease` 0/1 only reflects lease churn at the instant of the read; leases are re-acquired every few seconds — the launch receipt `lease_generation` changed between my probes.)

- Both clubs: `2a1132b9-…` (club-owned pool, 56 spins, gross 4,290) and `fade0000-…0001` (union pool, 50 spins, gross 3,582). Buy-ins 1/2/3/5/10/20/50/100, `spin_type='standard'`, `is_premium_spin=false`, `buy_in_fee=0`, `prize_pool = 3×buy_in` (set by the seat/escrow path, not a draw).
- Timeline: tournaments created 09-09 09:12–11:44; seats bought 09-09 22:04 → 09-10 03:04 (`registered_at` = contribution `created_at`, same transaction — `fn_spin_book_entry` runs on the third paid seat); launch receipts claimed 09-09 23:38 → 09-10 03:04; entitlements at registration. `tournaments.updated_at` is never maintained (= `created_at`).
- Spin starts per hour on 09-09: 06:00 310, 07:00 318, 08:00 333, 09:00 322, 10:00 163, 11:00 **5**, then **0** forever. Last `jackpot_draw` 11:44:07. No Spin has been created since 11:44:33 either — the 106 stuck boards "cover" every price point for the recycler (`ensureBoardOpen`), so no replacement boards appear.
- `spin_multiplier` distribution on the 106: **all exactly 0** (`column_default = 0`, nullable). Live board: 106 × {zero, no draw}; 22 × {positive, draw} (older bucket, see §6); **0 × {positive, no draw}** — the case the gate was written for does not exist on the live board.
- They never had a `jackpot_draw`: `chip_ledger` for the 106 holds only `tournament_buyin` (318 rows, 7,872.00) and `spin_entry` (106 rows, 7,242.24) legs; no `spin_prize` leg ever existed. No function in `pg_proc` contains `DELETE FROM spin_reserve_ledger` (checked), and `spin_reserve_receipt_is_immutable` forbids it. Crons `spin_sweep_unbooked` (_/5), `spin_repair_missing_multiplier` (_/15), `ca-spin-return-unawarded-draws-15m`, `spin_chip_conservation_hourly`, `spin_fairness_check_hourly`, `spin_unpaid_check` only touch RUNNING/COMPLETED/CANCELLED spins — none writes a REGISTERING row.

### 1.2 Who put `0` there

Writers of `tournaments.spin_multiplier` in `pg_proc`: only `fn_spin_draw_and_settle` (old, stamps the drawn value) and `fn_spin_repair_missing_multiplier` (RUNNING/COMPLETED only). Nothing writes 0. It is the **column default**:

- Engine `TournamentRecurringService.ts:4799-4861` (commit 1695880b, the deployed `engine_version`) builds `spinRow` with `spin_multiplier: null` (line 4834, comment: "NULL until start … A NULL here is what start's draw path keys on") and passes it to `supabase.rpc('fn_create_seat_first_game_atomic', …)` (line 3112).
- `fn_create_seat_first_game_atomic` validates `NULLIF(p_config->>'spin_multiplier','') IS NOT NULL → SEAT_FIRST_CREATE_INVALID_CONFIG` (i.e. only NULL is accepted) and then `INSERT INTO public.tournaments (id, club_id, …, short_description)` **without `spin_multiplier`** → DEFAULT 0. (Before 09-08 13:00 the engine inserted the row through PostgREST with the explicit NULL.)
- Between 09-08 13:00 and 09-09 11:44 this was harmless: the old draw path (`fn_spin_draw_multiplier` + `fn_spin_settle_game` + row write from the engine, or `fn_spin_draw_and_settle`) overwrote 0 at start (27,567 COMPLETED spins in 5 days, all with a positive multiplier).
- `20260909183856_spin_draw_books_one_funded_rule_receipt` (PR #4000, repo file `20260909174722_…`) introduced `fn_spin_draw_and_settle_atomic` with:
  ```
  ELSE
    IF v_t.spin_multiplier IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'projected_spin_draw_has_no_funding_proof');
  ```
  Its proof harness (`scripts/dev/fixtures/spin-funding/proof-bootstrap.sql`, `probe-spin-funding-pg17.py`) builds a bare `tournaments` table with **no default** on `spin_multiplier`, so the 36 isolated checks passed against NULL and never met production's `DEFAULT 0`.
- Same NULL-vs-0 slip in the same PR family: `fn_spin_expire_unfilled` (`20260909193534`) skips any board with `spin_multiplier IS NOT NULL` → with DEFAULT 0 it now skips every board (unfilled-board expiry is silently off). Not part of this incident, flagged for the same fix.

### 1.3 Probe 1 (rolled back) — the gate is the 0, and the rest of the path works

On `a9c5e229-001b-4a49-af0a-f1b703f29dfa` (10-chip PLO5, club fade0000…, union pool), with a manifest built in SQL to be content-identical to `spinRuleManifest(10, 1000)` at engine commit 1695880b (generated with the engine's own `SpinDrawReceipt.ts` via tsx to cross-check: freq 10,000,000, weight 27,600,000 = 3×(1−0.08)×freq ✓):

| step | call                                                                                                                                                                                         | result                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `fn_spin_draw_and_settle_atomic(id, launch_id, lease_generation, real manifest)`                                                                                                             | `{"ok":false,"reason":"projected_spin_draw_has_no_funding_proof"}` — the real manifest is not the problem                                                                                                                                                                    |
| 2    | `UPDATE tournaments SET spin_multiplier = NULL`                                                                                                                                              | **refused**: `P0404 Spin … tournament contract must equal its one immutable reserve draw` (trigger `spin_tournament_contract_is_draw`: once a `contribution` row exists, the only allowed multiplier is the one `jackpot_draw`). A data-only "null it" repair is impossible. |
| 3    | `fn_spin_draw_multiplier(club, 10, tiers, 0.08, 0)` → 2×; `fn_spin_settle_game(id, club, 10, 3, 2, 0.08)`; `UPDATE tournaments SET spin_multiplier=2, prize_pool=20, spin_locked_tiers='[]'` | all ok: pool 56,546.52 → 56,526.52; escrow `reserve_in` 0→20, `prize_balance` 0→20; ledger `jackpot_draw −20 (2×)`; chip leg `spin_prize spin_reserve→prize_liability 20`; row stamp accepted by the trigger                                                                 |
| 4    | atomic function again                                                                                                                                                                        | `ok:true, replay:false, rule_provenance:"legacy_projection", multiplier 2, prize_pool 20, pool_covered 20, operator_shortfall 0`, 1 `spin_draw_receipts` row                                                                                                                 |

### 1.4 Probe 2 (rolled back) — D2: the row must be stamped or the launch stalls one step later

Emulating "D1 fixed, `at_draw` branch as written" (jackpot_draw + receipt exist, row still `spin_multiplier=0`), as the engine identity (`request.jwt.claims role=service_role`, set locally in the probe):

|     | write                                                                                                                                                                                  | result                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | engine `spinPresentationPatch` (`is_premium_spin, blind_structure, payout_structure, spin_reveal_lag_ms, spin_reveal_at`, TournamentManagerBase.ts:3444-3494) on the **unstamped** row | **refused** `23514 A booked Spin keeps its original multiplier` (`zzz_spin_ladder_is_the_drawn_one`: receipt present, `NEW.spin_multiplier (0) IS DISTINCT FROM booked (2)`) |
| b   | `UPDATE tournaments SET spin_multiplier=2, prize_pool=20, spin_locked_tiers='[]'`                                                                                                      | ok                                                                                                                                                                           |
| c   | the same presentation patch on the **stamped** row                                                                                                                                     | ok                                                                                                                                                                           |

And even if (a) passed, `proveTournamentLaunchSetup` (TournamentManagerBase.ts:2838-2861) reads the row back and refuses when `rowMultiplier !== bookedMultiplier` or `prize_pool !== buy_in×multiplier`. So the atomic function must stamp the row itself, exactly as the retired `fn_spin_draw_and_settle` did (`UPDATE public.tournaments SET spin_multiplier = v_booked_multiplier, prize_pool = v_booked_draw, spin_locked_tiers = v_locked`), plus `blind_structure`/`payout_structure` from the drawn tier so `zzz_spin_ladder_is_the_drawn_one` does not fire a false "ladder overwritten" critical alert on ≥10× draws (`spin_payout_ladder` matches `SPIN_TIERS` exactly today, checked).

## 2. What a healthy launch writes, in order (atomic protocol, engine 1695880b)

1. Third paid seat (`fn_take_seat_and_buy_in` → `fn_spin_book_entry`): `wallet_transactions` debit ×3, `chip_ledger player_wallet→prize_liability` ×3, `tournament_refund_entitlements` ×3, `tournament_escrow` (`gross_in=3b, fee_entries_in=0.08·3b, reserve_out=0.92·3b`), `spin_bonus_pools.balance += 0.92·3b`, `spin_reserve_ledger contribution`, `chip_ledger spin_entry prize_liability→spin_reserve`, `rake_records` (`fn_spin_book_entry`). **Present on all 106.**
2. `fn_begin_tournament_launch_atomic` → `tournament_launch_receipts` (launch_id, lease_generation, `completed_at NULL`). **Present.**
3. `fn_spin_draw_and_settle_atomic`: lease/receipt/escrow/entitlement proofs → manifest validation → `fn_spin_book_entry` replay (`already_booked`) → `fn_spin_draw_multiplier` (draw, pool row locked) → `fn_spin_settle_game` (`spin_bonus_pools.balance −= prize`, `spin_reserve_ledger jackpot_draw`, `chip_ledger spin_prize spin_reserve→prize_liability`, escrow `reserve_in/prize_balance += prize`) → `spin_draw_receipts` insert → return receipt. **Missing on all 106 — refused at the `IS NOT NULL` gate before any write.** (And, per D2, it would not stamp the tournament row even when it succeeds.)
4. Engine: reveal packet, `spinPresentationPatch` on `tournaments`, seat/table proofs, `proveTournamentLaunchSetup`, `fn_complete_tournament_launch_atomic` (status RUNNING, `completed_at`).

`fn_prove_played_spin_launch_recovery` is only consulted when exactly 2 players are `registered/playing` (one busted seat on a dealt Spin); not relevant to the 106 (all 3 `playing`).

## 3. Engine side — the loop (commit 1695880b = deployed `engine_version`; the Mac checkout is at 09-06, files read with `git show 1695880b:…`)

- `server/src/tournament/TournamentManagerBase.ts:3312-3348` — `for (let attempt = 1; attempt <= 3 && !fundedSpin; attempt++)` calls `supabase.rpc('fn_spin_draw_and_settle_atomic', …)` (line 3314); any `error || !data?.ok` is thrown and caught (3320-3336), backoff `250 * attempt` ms (3333); after 3 failures `reportError(… 'Tournament.spin_draw_unavailable')` and `this.running = false; return;` (3339-3348). **Every reason is treated as retryable**, including the deterministic ones (`projected_spin_draw_has_no_funding_proof`, `spin_rule_manifest_invalid`, `invalid_spin_contract`, `spin_field_unproven`, `spin_paid_entry_unproven`, `spin_entry_escrow_unproven`, `legacy_spin_rules_unproven`, `spin_receipt_roster_mismatch`).
- `server/src/GameServer.ts:6434-6562` `discoverSeatFirstStarts()`: every `SEAT_FIRST_START_INTERVAL = 1000` ms (line 243, "ONE SECOND, not five") it lists REGISTERING spins, counts paid seats, and for a full board: `if (held && !held.isRunning()) await this.stopTournamentManagerIfOwned(…)` (6534-6540) then `ensureTournamentManagerAdmission(id, 'start', …)` (6544-6552). The comment at 6430-6432 says this is deliberate: "deleting it here just lets the retry happen in 5s instead of 3 minutes. start() itself re-validates … a game that stood down for a real reason stands down again." There is no per-tournament backoff, no failure counter, no terminal state. The 3-minute watchdog (`seat_first_fully_paid_never_started`, GameServer.ts:4919-5010, `SEAT_FIRST_START_STALL_MS`) also re-arms indefinitely.
- Arithmetic: 3 RPCs per `start()`; `start()` reruns after the 1 s sleep plus ~2.5 s of proofs/lease work ⇒ ~3 calls / 3.6 s / spin × 106 ≈ 87/s — matches the observed 121k/30 min.

### Proposed engine change (not applied)

1. In `TournamentManagerBase.ts:3320-3336`, classify the RPC result: a returned `data.reason` in a **terminal set** {`projected_spin_draw_has_no_funding_proof`, `spin_rule_manifest_invalid`, `invalid_spin_contract`, `legacy_spin_rules_unproven`, `spin_receipt_roster_mismatch`, `spin_paid_entry_unproven`, `spin_entry_escrow_unproven`, `spin_field_unproven`} is deterministic for this launch state — break out of the 3-attempt loop immediately, `reportError` with the reason, call a new `fn_raise_server_financial_alert('critical','spin_launch_parked', …)` once, and **park** the tournament: e.g. write `engine_tournament_leases`-independent state such as a `tournament_launch_receipts` note or a new `spin_launch_parks(tournament_id, reason, parked_until)` row. Keep the transient set (`launch_lease_lost`, `launch_receipt_state_mismatch`, `entry_purchases_frozen`, RPC transport errors) on the existing 250/500 ms retry.
2. In `GameServer.ts:6534-6552` (and the 4973 watchdog), skip a parked id until `parked_until` (exponential: 30 s → 1 min → 5 min → 15 min cap), and never more than one `start()` per parked id per window. A `Map<string,{until:number,strikes:number}>` in-process is enough for the loop; the DB row is for observability and restarts.
3. Never auto-refund from the engine on a terminal reason: parking + alert is the whole action (CLAUDE.md 10.9 — money decisions are a migration with a receipt).

## 4. Money

|                                                       | club 2a1132b9 (club pool) | union fade0000 (union pool) | total        |
| ----------------------------------------------------- | ------------------------- | --------------------------- | ------------ |
| stuck spins                                           | 56                        | 50                          | 106          |
| gross debited (3×buy_in)                              | 4,290.00                  | 3,582.00                    | **7,872.00** |
| in reserve pool (`spin_entry`, 92%)                   | 3,946.80                  | 3,295.44                    | 7,242.24     |
| rake booked (`rake_records`/escrow `fee_balance`, 8%) | 343.20                    | 286.56                      | 629.76       |
| pool balance now                                      | 23,993.48                 | 56,546.52                   |              |

Where it sits: `chip_ledger`: 318 × `tournament_buyin player_wallet→prize_liability` (7,872.00) and 106 × `spin_entry prize_liability→spin_reserve` (7,242.24). `tournament_escrow`: `gross_in` 7,872, `reserve_out` 7,242.24, `fee_balance` 629.76, `prize_balance` 0, `reserve_in` 0. Entitlements: 318 `wallet_charge/tournament_buyin`, `refund_prize = gross`, none tranched — a refund path is fully available if ever needed. Players: 243 distinct, **all `profiles.is_horse = true`** (still players per CLAUDE.md 10.5 — treated identically).

Affordability for option (a): worst possible draw is 100× on a 100 buy-in = 10,000 chips; pools hold 23,993 / 56,546; `fn_spin_draw_multiplier` locks unaffordable tiers per draw anyway (`v_bal + contrib < prize → locked`), and `fn_spin_settle_game` raises `P0404` on any shortfall.

## 5. Repair options

### (a) RECOMMENDED — fix the authority, let the platform launch them (no manual money movement)

DDL for the orchestrator (`C-stuck-spins.sql`, DRAFT block): replace `fn_spin_draw_and_settle_atomic` with two changes only:

1. gate `IF COALESCE(v_t.spin_multiplier, 0) > 0 THEN … projected_spin_draw_has_no_funding_proof` (D1);
2. in the `at_draw` branch, after `spin_draw_receipts` is inserted, `UPDATE public.tournaments SET spin_multiplier = v_multiplier, prize_pool = v_prize, spin_locked_tiers = v_locked, blind_structure = v_blinds::text, payout_structure = v_payouts::text WHERE id = p_tournament_id` with a read-back assertion (D2) — the stamp the retired `fn_spin_draw_and_settle` performed plus the tier's blinds/payouts, validated by `spin_tournament_contract_is_draw` (must equal the one `jackpot_draw`) and `zzz_spin_ladder_is_the_drawn_one` (must equal the receipt). **Do not** write `is_premium_spin`: `fn_satellite_target_contract_is_immutable` freezes it once `entry_contract_locked` (true on every funded Spin). The engine's presentation patch does write it (TournamentManagerBase.ts:3445) and would be refused on a 100× draw (1008/10M) — a separate rare defect, noted in §6.

Behaviour identity: (1) differs from the old predicate only for rows with `spin_multiplier = 0`; `0` is never a drawn value (all tiers ≥ 2; `fn_spin_settle_game` rejects `<= 0`; the contract trigger, `fn_spin_repair_missing_multiplier` and `fn_spin_sweep_unbooked` all already read `COALESCE(...,0) <= 0` as undrawn), and no live row has {positive, no draw}. (2) adds the row stamp inside the same transaction; on failure the whole draw rolls back (no money moves without the row), which is strictly safer than today.

Effect: the engine's existing loop (unchanged) launches the 106 on its next pass — draw + settle + receipt + stamp + presentation + RUNNING — and the loop stops by itself. New boards get created as the stuck ones clear. Cost: a ~28 s PostgREST reload for the DDL; 106 draws against the two pools within about a minute (expected total prize ≈ 2.76 × buy_in × 106 ≈ 20.5k chips gross across both pools, funded by their balances; fine).

Follow-ups (same migration or next): D3 `fn_create_seat_first_game_atomic` — add `spin_multiplier, spin_locked_tiers` to the INSERT with explicit `NULL, NULL` (creator honours the config it validated); optionally `ALTER TABLE public.tournaments ALTER COLUMN spin_multiplier SET DEFAULT NULL` (no rewrite) — check `fn_spin_expire_unfilled` (`IS NOT NULL` → same COALESCE fix) and any client `> 0` gates (they handle both).

Migration self-test assertions (run inside the migration transaction, on `a9c5e229-…` or any of the 106, then `RAISE` to roll back in a dry-run before the real apply):

- before: `spin_multiplier = 0`, no `jackpot_draw`, no receipt, launch receipt open, lease heartbeat < 30 s;
- the new function called with the engine's manifest (built as in the probe) returns `ok=true, replay=false, rule_provenance='at_draw', operator_shortfall=0, pool_covered = prize_pool = round(buy_in×multiplier,2)`;
- after: exactly 1 `jackpot_draw` (`-amount = prize`, `multiplier = multiplier`), 1 `spin_draw_receipts`, `tournaments.spin_multiplier = multiplier`, `prize_pool = prize`, `spin_locked_tiers` not null, `blind_structure/payout_structure` = tier's; escrow `reserve_in = prize_balance = prize`; pool balance delta `= -prize`; `chip_ledger spin_prize` leg = prize; a second call returns the same receipt with `replay=true`;
- a row with `spin_multiplier > 0` and no `jackpot_draw` (construct in the dry-run only) still gets `projected_spin_draw_has_no_funding_proof`.
  Note: the stamp writes `blind_structure/payout_structure`, which `fn_guard_managed_game_lifecycle` protects for non-engine callers once players exist; the self-test must run with `request.jwt.claims` role `service_role` (as the engine does), exactly as probe 2 did.

### (b) NOT recommended — refund the 3 entries and cancel

Path exists and is idempotent: `atomic_cancel_tournament(p_tournament_id, p_admin_id)` (writes `tournament_spin_cancellation_unwinds`, `contribution_reversal` on the reserve ledger, `tournament_refund_tranches` against the 318 entitlements, `fn_ca_tournament_cancellation_receipt`). Cost: 106 cancellations × 3 refunds, reverses 7,242.24 out of the pools plus 629.76 rake, destroys 106 games the players paid for (Dan 2026-08-19: "TOURNAMENTS RUN. THEY DO NOT CANCEL"), and does nothing about the next Spin — which stalls identically until the function is fixed anyway. Only justified if the orchestrator refuses to change the function; then probe it first with `atomic_cancel_tournament` inside a rolled-back DO on one id.

### (c) NOT possible — data-only repair

`UPDATE tournaments SET spin_multiplier = NULL` is refused by `spin_tournament_contract_is_draw` once a contribution exists (probe 1 step 2). Pre-drawing via `fn_spin_draw_multiplier`+`fn_spin_settle_game`+row stamp from a migration (probe 1 step 3) does launch the 106 through the `legacy_projection` branch **without DDL**, but it draws outside the atomic authority and leaves the root cause in place (every new board still carries 0). Keep as an emergency fallback only.

## 6. Out of scope, noted

- 22 older Spins (created 09-08 12:45–14:44) are `REGISTERING` with a positive multiplier, a `jackpot_draw`, eliminated players, **no launch receipt**: played-but-never-RUNNING games from the 09-08 cutover; 1,296 gross, 864 in escrow `prize_balance`. They are not part of this loop (paid live seats < 3 so the fast lane ignores them). Separate repair.
- `fn_spin_expire_unfilled` is effectively disabled by the same NULL/0 slip.
- 100× draws: the engine's `spinPresentationPatch` sets `is_premium_spin = true`, which `fn_satellite_target_contract_is_immutable` refuses after the first funded entry (`entry_contract_locked`). Expected once per ~10,000 spins; the launch would stand down at the presentation write with the money already drawn. Fix on the engine side (drop `is_premium_spin` from the patch, or exempt it in the trigger).
- `rake_records.metadata.treasury_credited = false` on all 106 — expected until settlement; will clear on launch/settle.

## 7. Rollback

- Function fix: `CREATE OR REPLACE` back to the original body (pasted in the ROLLBACK section of `C-stuck-spins.sql`; md5 of the live definition `1c911e3ada50ffe0493b9b375e3fa9ae`, creator `92cbf5680d78bdbaa4309412b3d19dfd`). Any Spin launched in between keeps its immutable receipt/ledger rows and completes normally under either definition (the `legacy_projection` branch replays them).
- Engine change: revert the commit; the loop returns to today's behaviour.
