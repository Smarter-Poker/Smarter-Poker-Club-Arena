# 2026-09-02 - Chip Accounting Standard, Lane B: the escrow shadow

**Branch:** `fix/chip-std-escrow`
**Migrations (applied to production 2026-09-02 20:13 and 20:19 UTC, once each):**
`20260903013500_the_escrow_shadow_what_every_tournament_held_versus_what_it_paid`,
`20260903014000_the_shadow_summary_reads_its_own_run`
**Law:** `tests/law/EscrowShadowNeverRefuses.law.test.ts` (row in `docs/LAWS.md`)
**Manifest:** `scripts/ci/schema-manifest.d/chip-std-escrow.json`

## What was asked, what was built

Lane B of `docs/CHIP-ACCOUNTING-STANDARD.md` (3.1 `tournament_escrow`, 3.3 R1,
R4, R5, 5 Lane B) is a real escrow account with `CHECK >= 0`, `prize_pool` as a
derived column, and payouts refused at a constraint. Dan's ruling for this
round: that is HIGH RISK for live play and is not built. What is built is the
SHADOW: the same twelve numbers, computed from evidence rows only, compared to
the counters every hour, filed as incidents, refusing nothing.

Everything below is what was OBSERVED, with the queries.

## Part 1 - what is already live after today's other migrations

Read from the live bodies (`pg_get_functiondef`) of `fn_apply_prize_guarantee`,
`fn_ca_fund_overlay_on_lock` (trigger `zz_ca_fund_overlay_on_lock`, BEFORE
UPDATE OF status on `tournaments`) and `fn_ca_backpay_guarantee_shortfalls`.

**(a) When a guarantee or freeroll pool is raised above contributions today, is
a bank debited in the same transaction and an overlay row written?**

YES, on the lock path. `fn_ca_fund_overlay_on_lock` fires when status leaves
ANNOUNCED/REGISTERING for RUNNING/COMPLETING/COMPLETED. It computes
`shortfall = guaranteed_prize - prize_pool`, locks the bank row (`union_wallets`
for a union event, `clubs.chip_treasury` otherwise) `FOR UPDATE`, debits it,
sets `NEW.prize_pool := pool + shortfall`, and writes one `chip_ledger` row
`category='overlay'`, `union_bank|club_treasury -> prize_liability`, with
`to_entity_id = tournament_id = NEW.id`. All of that is inside the trigger, so
it is the same transaction as the status change. It does NOT write a
`tournament_guarantee_overlays` row; that table belongs to the older
`fn_apply_prize_guarantee` path, whose last row is 2026-09-01 19:50 UTC (source
`late_reg_close`, with a matching `union_wallet_transactions` debit).

The engine still calls `fn_apply_prize_guarantee` at late-reg close
(`server/src/tournament/TournamentManagerBase.ts:4914`). After the lock trigger
has topped the pool up, that call finds `overlay = 0` and only stamps
`prize_pool_finalized`.

Measured, tournaments COMPLETED in the 24h to 20:13 UTC, non-spin
(`ca_escrow_shadow_results`, first run):

```sql
with x as (
 select r.*, round(r.counter_prize_pool - r.prize_in - r.satellite_in, 2) raise,
  (select count(*) from chip_ledger cl where cl.to_entity_id = r.tournament_id
     and cl.category='overlay' and cl.to_type='prize_liability'
     and cl.from_type in ('union_bank','club_treasury')) bank_rows
 from ca_escrow_shadow_results r
 where r.status='COMPLETED' and r.variant <> 'spin')
select count(*) filter (where raise > 0.01) raised_events,
       count(*) filter (where raise > 0.01 and abs(overlay_in - raise) <= 0.01) raised_fully_funded,
       count(*) filter (where raise > 0.01 and bank_rows > 0) raised_with_bank_ledger_row,
       count(*) filter (where raise > 0.01 and ended_at > '2026-09-02 02:00+00') raised_after_fix,
       count(*) filter (where raise > 0.01 and ended_at > '2026-09-02 02:00+00'
                          and abs(overlay_in - raise) <= 0.01) raised_after_fix_funded
from x;
```

|                                                       | events |
| ----------------------------------------------------- | ------ |
| prize_pool raised above contributions (24h)           | 30     |
| ... with a bank debit ledger row of exactly the raise | 25     |
| ... raised after 02:00 UTC (trigger live)             | 25     |
| ... of those, fully funded                            | 24     |

Raise total 3,172.00; per-event overlay evidence total 2,071.00. The five
without a per-event row:

| event                          | ended                    | raise | why there is no per-event row                                                                                                                                                                                     |
| ------------------------------ | ------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Union Grand Championship (NLH) | 00:32                    | 460   | funded by `back_fund_the_six_unfunded_guarantees` at 01:19 with ONE aggregate ledger row (`to_entity_id` = the union, 1,703.00 for six events)                                                                    |
| Union Mystery Bounty (PLO5)    | 00:31                    | 350   | same                                                                                                                                                                                                              |
| Evening Mystery Bounty (PLO5)  | 00:32                    | 175   | same                                                                                                                                                                                                              |
| Turbo Tuesday Opener           | 00:53                    | 16    | same                                                                                                                                                                                                              |
| $100 Freeroll, 6:00 PM         | 16:29 (started 01:15:00) | 100   | the bank WAS debited (union_wallets -100 at 01:15:00.55) by the first build of the trigger, but the auto-ledger classed it `adjustment` -> `settlement_suspense`; the corrected classification landed at 01:15:56 |

So the 2.2 item 1 defect ("no row in `tournament_guarantee_overlays`, no bank
debit") is CLOSED for every event that locked after 01:15 UTC. The evidence row
is in `chip_ledger`, not in `tournament_guarantee_overlays`; anything that
still reads the latter table for "was this funded" will see zero and be wrong.

**(b) What happens when the bank cannot fund it?**

Two different answers on two paths, and they disagree:

- At lock (`fn_ca_fund_overlay_on_lock`): if `bank < shortfall` it raises a
  CRITICAL `financial_alerts` row (`kind = overlay_unfunded`, "The pool was NOT
  topped up"), returns NEW unchanged, and the event runs at contributions. That
  is exactly the standard's 3.2 MTT step 3. Zero such alerts in the last 30h,
  so it has not happened since the trigger went live.
- At late-reg close (`fn_apply_prize_guarantee`, called by the engine): no
  affordability check at all. It sets `prize_pool = greatest(pool, gtd)`,
  debits the bank by the difference, and if the bank goes NEGATIVE it files a
  critical "Bank is negative from funding advertised guarantees" alert. So a
  bank the lock trigger refused would be driven negative one level later by
  the engine's own call. Upstream, `trg_tournaments_guarantee_affordable`
  (create/edit) and `fn_guard_tournament_start_readiness` (start) refuse a
  guarantee the bank could not cover, which is why this has not fired.

This is put to Dan in "Decisions that are Dan's" below; nothing was changed.

**(c) Freerolls (buy_in 0) with a prize pool: who funds it?**

The same trigger, from the same bank, because a freeroll is created with
`guaranteed_prize = prize_pool` (e.g. Coffee Break Freeroll gtd 80, $100
Freeroll gtd 100) and contributions are 0 (FREE BUY, live since
`fn_freerolls_are_free_buy`: 0 entry, 1-chip rebuy/add-on). 12 freerolls with
a pool completed in the window; 10 show an overlay row equal to the guarantee
and balance to 0 in the shadow; the two exceptions are the 6:00 PM freeroll
above (funded, mis-ledgered into suspense) and the 12:00 AM freeroll (funded
100, then overpaid 41.71 by the migration that settled it, see Part 2).

## Part 2 - the shadow

**`fn_ca_tournament_escrow(p_tournament_id)`** returns `(prize_in, bounty_in,
fee_in, overlay_in, satellite_in, prize_out, bounty_out, fee_out, refund_out,
prize_balance, bounty_balance, fee_balance)`. Evidence map:

| number       | evidence row                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gross in     | `wallet_transactions` debit, category `tournament_buyin` / `rebuy` / `addon`, `related_entity_id` = tournament (one row per entry, written by `fn_register_for_tournament` via `log_wallet_transaction`, and by `process_tournament_rebuy_before_one_minute_addon`) |
| fee_in       | `rake_records` where `is_tournament` and `tournament_id` = t (entry fee, rebuy/add-on fee, satellite-seat fee)                                                                                                                                                      |
| bounty_in    | entries x `bounty_amount` + rebuys x `round(bounty_amount)` on bounty formats (`fn_tournament_entry_split`, rebuy head rule)                                                                                                                                        |
| prize_in     | gross in - entry fees - bounty_in                                                                                                                                                                                                                                   |
| overlay_in   | `chip_ledger` `category='overlay'`, `to_type='prize_liability'`, `to_entity_id` = t (auto-ledgered twins de-duplicated), else `tournament_guarantee_overlays.amount`                                                                                                |
| satellite_in | `rake_records` source `fn_award_satellite_seat` on the target: `pot_size - rake_amount` (= target buy-in)                                                                                                                                                           |
| prize_out    | `wallet_transactions` credit `prize` minus debit `prize` / `prize_reversal`, plus `tournament_payouts` source `satellite_seat` (a seat leaves a satellite's pool without a wallet row)                                                                              |
| bounty_out   | `wallet_transactions` credit `bounty`                                                                                                                                                                                                                               |
| fee_out      | `tournament_rake_settlements.amount` where `settled_at` is set                                                                                                                                                                                                      |
| refund_out   | `wallet_transactions` credit `refund`, apportioned across the three balances by the event's own split                                                                                                                                                               |

It never reads `prize_pool`, `bounty_pool` or `total_rake`; it returns no row
for an unknown tournament. `tournament_escrow_shadow` is the same as a view
beside the three counters, last 7 days.

**`fn_ca_escrow_vs_counter_check(p_hours, p_warning_cap)`**: for every
tournament that ended or changed in the window, records the shadow beside the
counters in `ca_escrow_shadow_results` (one row per tournament, latest run),
and for COMPLETED / CANCELLED non-spin events asserts R5: all three balances 0. Non-zero files ONE incident per tournament through
`fn_ca_raise_drift_incident` with dedupe key `escrow:<tournament_id>` at
`info` (dashboard only; `fn_ca_raise_drift_incident` never pages info), or at
`warning` only when `prize_balance < -1.00` (paid more than it held) and only
up to `p_warning_cap` (5) per run; the rest are filed as info with
`warning_capped = true` in metadata. A warning pages once at creation
(recurrences bump `occurrences`, they do not re-page), and
`fn_ca_raise_drift_incident` has its own storm gate at 10 incidents per two
minutes. The function has no RAISE EXCEPTION and writes nothing but its own
two tables. Every run appends its distribution to `ca_escrow_shadow_runs`.

Scheduled: `ca-escrow-shadow-hourly`, `35 * * * *`, window 3 hours (every
terminal event is seen by three consecutive passes, which covers a late rake
settlement or a reconciler top-up), advisory-locked, `statement_timeout 300s`.
The first 3h run took 41 s over 836 candidates.

### The distribution, 24 hours to 2026-09-02 20:13 UTC (first run, 174 s, 7,279 candidates)

| variant                     | status    | asserted            | events | balanced (all three = 0) | overpaid | underpaid | overpaid total |
| --------------------------- | --------- | ------------------- | ------ | ------------------------ | -------- | --------- | -------------- |
| sng                         | COMPLETED | yes                 | 3,773  | **3,773**                | 0        | 0         | 0.00           |
| freezeout                   | COMPLETED | yes                 | 30     | 26                       | 4        | 0         | -240.00        |
| bounty                      | COMPLETED | yes                 | 10     | 9                        | 1        | 0         | -920.00        |
| mystery_bounty              | COMPLETED | yes                 | 6      | 4                        | 2        | 0         | -1,050.00      |
| progressive_bounty          | COMPLETED | yes                 | 4      | 4                        | 0        | 0         | 0.00           |
| satellite                   | COMPLETED | yes                 | 3      | 3                        | 0        | 0         | 0.00           |
| spin                        | COMPLETED | no (reserve-funded) | 3,276  | -                        | -        | -         | -              |
| spin                        | CANCELLED | no                  | 115    | -                        | -        | -         | -              |
| open (RUNNING / COMPLETING) |           | no                  | 62     | -                        | -        | -         | -              |

**Asserted 3,826; balanced to the cent 3,819 (99.8%); overpaid 7; underpaid 0;
net shadow residual -2,210.00.**

The seven, each traced:

| event                               | ended (UTC) | held (prize_in + overlay) | paid   | residual | what the residual is                                                                                                                 |
| ----------------------------------- | ----------- | ------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DSS Tuesday $100 Freeroll, 10 AM CT | 09-01 20:39 | 0 + 100                   | 166.29 | -66.29   | real overpay; structure paid above the funded pool (standard 2.2 item 4 class)                                                       |
| Union Mystery Bounty (PLO5)         | 09-02 00:31 | 450 + 0                   | 1,150  | -700.00  | 350 aggregate-funded (not attributable per event) + 350 paid twice (standard 2.2 item 3)                                             |
| Evening Mystery Bounty (PLO5)       | 00:32       | 225 + 0                   | 575    | -350.00  | 175 aggregate + 175 paid twice                                                                                                       |
| Union Grand Championship (NLH)      | 00:32       | 2,040 + 0                 | 2,960  | -920.00  | 460 aggregate + 460 paid twice                                                                                                       |
| Turbo Tuesday Opener                | 00:53       | 234 + 0                   | 266    | -32.00   | 16 aggregate + 16 paid twice                                                                                                         |
| $100 Freeroll, 12:00 AM             | 16:29       | 254.70 + 100              | 396.41 | -41.71   | real overpay by the migration that settled the frozen event (`settle_two_tournaments_frozen_by_the_engineless_table_defect`)         |
| $100 Freeroll, 6:00 PM              | 16:29       | 0 + 0                     | 100    | -100.00  | funded (bank -100 at 01:15:00) but ledgered as `adjustment -> settlement_suspense` by the first build of the trigger; 0 real overpay |

So of the -2,210.00: 1,001.00 is the six-event aggregate funding row the
shadow cannot attribute, 100.00 is a mis-classified ledger row, and
**1,109.00 chips is real overpayment** (66.29 + 350 + 175 + 460 + 16 +
41.71), all of it in events that ended before 01:00 UTC or were settled by
migration. **Every MTT that completed through the engine after the fixes
landed (01:15 to 05:27 UTC) balances to 0.00 on all three escrows**, bounty
and fee included.

Incidents filed by the first run: 5 warnings (6:00 PM freeroll, 12:00 AM
freeroll, Turbo Tuesday Opener, Union Grand Championship, Evening Mystery
Bounty), 1 info (Union Mystery Bounty, capped), and the DSS freeroll was
returned NULL by `fn_ca_is_midway_scope` (platform policy: incidents outside
the Midway scope are not filed). Its row is in `ca_escrow_shadow_results`.

### A fresh one the shadow caught five minutes after it happened

Second run (3h window, 20:19 UTC): **Sunday Deep Stack Satellite $5**, ended
20:14:41, held 108.00, paid 200.00, residual -92.00. `tournament_payouts`
source `structure`, `wallet_transactions` description "Satellite seat fallback
(registration failed): Sunday $200 Deep Stack". The target registration
failed, so the fallback paid the seat's face value (200) in chips out of a pool
that held 108. 92 chips minted. Warning incident `escrow:91dd8dbf-...` filed.
Not this lane's to fix (satellite fallback is Lane G / the single settle
function in Lane A); reported to the orchestrator.

### Counter gaps (report only)

`counter_prize_gap_events = 3,428` in the first run: 3,276 are spins (the
`prize_pool` counter on a spin is the drawn prize, the shadow's `prize_in` is
the seats; expected, spins are not asserted) plus 115 cancelled spins, 28
running spins, and the five aggregate/suspense events above (+1,001, +100).
Zero gaps on every sng, satellite and progressive_bounty. `total_rake` agrees
with `rake_records` on every non-spin event.

### Known limits of the shadow

- The aggregate back-funding row and the suspense-classified row above are
  reported as underfunded because that is what the per-event evidence says.
- Rebuy bounty heads use `round(bounty_amount)` without the `LEAST(.., base)`
  cap the rebuy function applies; the cap only bites when the rebuy base is
  below the bounty, which no live format does.
- Refunds are apportioned; the total residual is exact, the split between the
  three balances on a cancelled event is proportional.
- `fn_ca_raise_drift_incident` drops incidents outside the Midway scope.

## Part 3 - funded guarantees: nothing built, and why

Today's migrations already do what the standard's 3.2 MTT step 3 asks on the
lock path: bank debited atomically, evidence row written, refusal with a
critical alert when the bank is short, event pays what it holds. Freerolls
ride the same trigger because they are created as guarantees. The measured
gap (Part 1a) is five events that ended before the trigger existed or during
its first minute, all since paid; there is nothing to fix forward.

The one behavioural inconsistency (Part 1b: the late-reg-close path drives
the bank negative where the lock path refuses) has not fired in production
and is guarded upstream by two affordability checks. Changing it would decide
whether a running event with a short bank pays the guarantee (bank negative)
or pays what it holds (players get less than advertised). That is Dan's call,
not a low-risk fix, so it is left exactly as it is.

## Probe transcript

No money path was touched. The only production writes are the two tables this
lane created. The 24h run and the 3h run above are the probes; both are
recorded in `ca_escrow_shadow_runs`.

## Tests

- `npx vitest run tests/law/EscrowShadowNeverRefuses.law.test.ts tests/law-registry.law.test.ts`: green (see PR body for output).
- `npx tsc --noEmit`: clean.

## Decisions that are Dan's

1. **Bank short at late-reg close.** `fn_apply_prize_guarantee` raises the
   pool to the guarantee and lets the bank go negative (critical alert);
   `fn_ca_fund_overlay_on_lock` refuses and lets the event pay what it holds
   (critical alert). Which one is the rule? The standard says refuse. Say the
   word and the late-reg-close path gets the same `bank < shortfall` gate.
2. **The 1,109.00 chips of real overpayment** in the window (and the satellite
   fallback's 92.00): standing ruling is no clawback, hosting club absorbs.
   Confirm, or the shadow's warnings stay open as reminders.
3. **The aggregate back-funding row** (1,703.00, six events, one ledger row on
   the union): leave as is (the shadow will show those six as -1,001 until
   they age out of every window), or split it into six per-event
   `chip_ledger` rows of the same total so the record reads per event. That is
   bookkeeping, not money movement, but it is still a ledger write.
4. **Should the satellite seat fallback pay cash at all?** It paid 200 from a
   pool holding 108. The standard (3.2 MTT step 9) says a seat is a ticket,
   never a wallet credit.
