# 2026-08-31 — Phase-2 verification: one real 18k defect, three false alarms, and a re-baseline I had to revert

Agent: Claude (Cowork). Dan's gate before phase 3: _"MAKE SURE EVERYTHING FROM
THE PREVIOUS PAGE WAS 100% COMPLETED ... CHECK FOR ANY AND ALL BUGS, GAPS,
STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE AND FIX ANY
ISSUES BEFORE MOVING ONTO THE NEXT PHASE."_

Phase 2's own work verified clean, and then the sweep found five more things —
including one I had caused hours earlier.

## 1. I reverted my own BBJ re-baseline. It was wrong twice.

Earlier today I moved `bbj_conservation_baseline` from 2,572.59 to 74,321.90
and declared the drift explained by "sixteen deleted `bbj_payouts` rows".

**The composition was factually false.** My forensic pass reported
"bbj_contributions portions sum to amount, mismatch 0.0000". Measured directly:
**49,714 rows dated 2026-03-03..07 whose `main+backup+promo` is short of
`amount` by 41,096.65** — 55% of the drift, chips recorded as contributed and
never bucketed. And the "= 71,749.31 exactly" fingerprint compared ONE pool's
`total_paid_out` (union, 172,740.21) against the payout rows of TWO pools
(union 26,689.80 + retired club 74,301.10). Against its own rows the union
pool's difference is 146,050.41. A coincidence dressed as a proof.

**It also overrode a deliberate standing decision.**
`docs/changelog/2026-08-30-money-integrity-sweep.md` investigated the same
drift the day before and refused to rebaseline, in words that name exactly what
I did: _"Rebasing bbj_conservation_baseline to make the alarm green would be
worse still — it would erase the only number that remembers this."_
`settlement_locks` carries an **active GLOBAL_SETTLEMENT_FREEZE** on all three
clubs since 2026-08-26 13:38, reason "EMERGENCY: PROFIT DRIFT INVESTIGATION".
I had silenced the subject of a live freeze.

Baseline restored to 2,572.59, the drift alert reopened, and the corrected
forensics written into the baseline note so the next reader inherits evidence
rather than my error. **Kept:** `fn_bbj_ledger_delete_guard` and its three
BEFORE DELETE triggers — a ledger table that can be emptied without trace is a
defect on its own, and the guard neither blocks nor silences anything.

## 2. THE REAL ONE — an event that was paid, reset, and paid again (18,201.60)

`Sunday $200 Deep Stack` (dfae9288) disbursed **62,841.60 against a 44,640
prize pool**.

| when              | what                                                          | amount    |
| ----------------- | ------------------------------------------------------------- | --------- |
| 08-30 19:47–19:53 | recovery payout, places 1–9, on the pre-reset 20,880 pool     | 20,880.00 |
| 08-30 ~20:00      | outage reset re-opened the event; positions cleared; replayed | —         |
| 08-31 02:32       | reconciler paid the NEW places 1–9 on the 44,640 pool         | 41,961.60 |

Place 6 was skipped at 02:32 because that player already held 3,132 from the
first run — more than the 2,678.40 the new place pays. Eight of the nine
first-run recipients finished **62nd–109th** on the replay and keep money for
places they no longer hold; the ninth is 453.60 over. One human, eight horses;
under 10.5 HORSES ARE PLAYERS that distinction does not exist here.

**Why every check stayed green.** `TournamentSentinel.payout_conservation`
compares `SUM(tournament_players.prize)` against `prize_pool`. The reset
**overwrote `tournament_players`**, so that sum reads 44,640 — exactly the
pool. The double payment exists only in `wallet_transactions`, which a reset
cannot rewrite. A conservation check that reads a mutable snapshot is measuring
the wrong object.

**Fixed by measuring the right one.**
`fn_tournament_prize_disbursement_audit(p_hours)` compares actual wallet prize
credits against `prize_pool + acknowledged`, and `auditPrizeDisbursement()` now
runs in the engine's fee-reconciler cycle beside the satellite auditor.
Scoped before shipping: **41,512 completed events in 14 days, 33 with any
excess, 19,981.92 total — 91% of it this one event.** All 33 acknowledged in
`tournament_conservation_baseline` (recording, not forgiving) so the auditor
starts silent and speaks only for NEW drift.

**Not clawed back.** Precedent in this same database:
`mystery_bounty_double_pay_backlog`, _"decision_owner: Dan — reversing credits
players have already been shown is not an agent decision."_ A critical
`tournament_double_payment_backlog` alert carries the amount, the cause and
Dan's name. **This is Dan's call.**

## 3. Three alarms that cried wolf

- **My own satellite auditor.** It raised a critical every hour on ccb686f8
  (pool 216, ticket 200, target closed, whole 216 paid out as cash — conserved
  exactly) because it computed `awardable = GREATEST(configured 2,
floor(216/200)=1) = 2` and then demanded position 2 be paid too. Its `excess`
  allowance had the same flaw in the other direction: `GREATEST(pool,
awardable×ticket)` would have let that satellite pay 400 against a 216 pool
  in silence. Restated symmetrically — `disbursed = cash + seats×ticket`,
  `allowance = pool + acknowledged`, flag `excess` (minted) or `undisbursed`
  (kept back). Zero rows across all 19 satellites of the last 7 days.
- **`trg_spin_completed_guard`** compared drawn against credited _inside the
  COMPLETED flip transaction_. Measured over 6 hours: **744 spins, 744
  credited, zero unpaid**; median credit lands 0.85s **before** the flip, the
  slowest **86.7s after** it. The trigger cannot wait to find out, so the money
  alert is removed and the periodic check owns it. The null-position CAS is
  genuinely a flip-moment invariant and is kept, exception and all.
- **`v_spin_unpaid_settlements`** gave COMPLETED spins no grace at all, and
  alarmed on RUNNING spins via `drawn_at < now() - 30min` — but the reserve is
  drawn at the **start**, so a spin that simply takes longer than half an hour
  trips it mid-play (8b1cd0df drew 06:13, ended 06:51, alerted 06:50). Now:
  finished for 10 minutes (7× the worst measured lag), or a draw over 2h old on
  an event that is no longer live.

## 4. One open grant closed

`fn_cashout_seats_for_closing_table` — SECURITY DEFINER, moves chips off a
table's seats, no authorization gate — was EXECUTE-able by `authenticated`.
`fn_check_ungated_money_rpcs` had been saying so. Grepped both repos: zero
browser callers. Revoked from PUBLIC/anon/authenticated; the engine holds
`service_role`.

## End state

`fn_union_treasury_selftest` failing checks: `lapsed_week_unclosed`,
`rakeback_settler_lagging` (both phase 3) and the reopened
`bbj_pool_conservation_drift`. Unresolved criticals: those, plus the two
human-owned decisions — `mystery_bounty_double_pay_backlog` and the new
`tournament_double_payment_backlog`. Nothing else is red.

## 5. The 21 hand-repaired hands were a symptom — the leak is now self-healing

Phase 2 re-queued 21 outage-lost hands **by hand**. The verification pass
asked whether that was a one-off. It is not: measured over 24 hours, **17,911
raked cash hands, 20 of them (72.30 chips) with no `rake_records` row and
nothing in the queue either**, clustered exactly at engine restarts (08-30
08–10h, 08-30 17–18h, 08-31 08h). 0.11%, permanent, roughly a chip an hour.

**Why it happens.** `FeeReconciler.pendingHands` is an in-memory queue drained
on shutdown; a process death between the inline fee write failing and that
drain loses the claim, and nothing on disk remembers the hand owed a fee. The
08:07 cluster shows the split cleanly — four hands carry a
`bbj_contributions` row and no `rake_records`, three the reverse. Two halves
of one write with a restart between them.

**Why nothing healed it.** `fn_bbj_repair_unbanked` heals BBJ _from_
`rake_records`, so it covers exactly one direction. A hand with no
`rake_records` row at all is invisible to every existing healer.

`fn_requeue_unbanked_cash_rake` closes the class: any cash hand past a
10-minute grace with rake but no `rake_records` and nothing queued is filed
back into `pending_fee_distributions`, and `requeueUnbankedCashRake()` runs it
every reconciler cycle. It never banks — banking stays on the hand-gated,
idempotent `atomic_distribute_rake`, so a double sweep cannot double-bank.
Swept 30 hands over the 48-hour window on application; zero unqueued remain.

**Attribution says what it lost.** `hand_history.players` carries the dealt-in
user ids and their ENDING STACK, never per-street contribution, so the
weighted-contributed split is unreconstructable after the fact. The sweep
stamps `rake_method='DEALT_EQUAL'` — the legacy method the allocator still
implements exactly — rather than inventing weights from stack sizes and
labelling the guess as weighted truth.

## For phase 3, measured here

The rakeback settler is not lagging because it is slow — it is **halted by
design and correctly so**. `fn_rakeback_recompute_periods` times out
(measured: 28.4s for ONE club-day; PostgREST's ceiling is ~8s), 221 buckets
fail per cycle, and the settler refuses to advance its watermark past records
it could not settle. That refusal is right — advancing would leave them
permanently unsettled and `rake_generated` picks the rakeback tier. The fix is
to make the recompute fit, not to loosen the guard. Backlog 22,611 rows,
arriving ~574/hour.
