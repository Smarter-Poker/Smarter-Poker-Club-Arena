# Zero-Drift Directive — Executive Summary (2026-08-31)

**Directive:** "Military-Grade Club Arena Chip Integrity, Ledger Hardening, and Zero-Drift" (Dan, 2026-08-31).
**Session:** Cowork cloud session, 2026-08-31. Eight production migrations applied via Supabase MCP
(`20260831142753` … `20260831145242`), verified live, probe suite 15/15 PASS (rolled back).

## What is now true that was not true this morning

1. **Every balance store auto-journals every delta into `chip_ledger`.** Before today only
   `club_members.chip_balance` had a ledger-writer trigger. Now `clubs` (treasury, pool, promo,
   insurance), `club_wallets`, `union_wallets` (all six sub-wallets), `unions`, `agents`,
   `bbj_pools` (main/backup/promo/legacy), `spin_bonus_pools`, and `club_members.promo_balance`
   all journal automatically. A movement whose caller declared nothing lands against
   `settlement_suspense` with category `adjustment` — visible and measured, never absorbed.
2. **The ledger is append-only and tamper-evident.** UPDATE/DELETE on `chip_ledger`,
   `wallet_transactions`, `chip_transactions`, `club_wallet_transactions`, and
   `union_wallet_transactions` are rejected at the database level (metadata-only annotation
   updates and GDPR anonymization excepted; authorized maintenance requires the
   `app.ledger_maintenance` GUC and is logged to `ca_ledger_mutation_log`). Every new ledger row
   carries a monotone `chain_seq`, a SHA-256 content checksum, the financial epoch, actor
   service/role, correlation/settlement ids and pre/post balances where known. A unique partial
   index on `idempotency_key` makes a financial command post at most once.
3. **Every discrepancy becomes a management incident with push notifications and the 20-minute
   workflow.** `ca_drift_incidents` + `ca_incident_events` (append-only trail) +
   `fn_ca_raise_drift_incident` (deduped, storm-controlled) push to club owners, union owners and
   platform admins through the existing notifications → push_outbox pipeline. Escalations fire at
   5/10/15/20 minutes, then controlled updates every 15 minutes; every notification is recorded.
   Wired sources: every warn/critical `ledger_reconcile_log` row, every critical
   `financial_alerts` row, the 5-minute quick-reconcile pass, ledger-write failures, the
   frozen-pool monitor, and checksum verification. **Nothing anywhere locks a table, game, club,
   union, player, or wallet** — detection and repair are strictly non-blocking.
4. **Automated reconciliation runs continuously.** A per-minute repair tick re-drives the existing
   idempotent repair functions (`fn_redrive_unbanked_rake`, `fn_bbj_repair_unbanked`), re-verifies
   each incident's source measurement, and auto-resolves incidents whose measurement is clean —
   with the action recorded in the trail. It never mints, burns, deletes, or silently adjusts.
5. **Live leaks are closed.** `promo_apply_playthrough` was callable by ANY authenticated user
   with a fabricated wager to release anyone's locked promo (now engine-only) and truncated
   fractional promo on release (fixed). `atomic_table_rebuy` could destroy chips when a seat
   vacated mid-rebuy (now aborts atomically). `fn_credit_chips` moved a truncated amount while
   journaling the full amount (fixed). `fn_bbj_promo_payout_atomic` paid real pool chips into the
   frozen `public.wallets` pool nothing reads (now pays club promo balances, idempotently).
   `log_wallet_transaction` stamped stale `balance_after` from the frozen pool (fixed).
6. **The 'adjustment' plug is being drained.** 97% of ledger rows carried category `adjustment`
   with a guessed counterparty. Buy-ins, rebuys, add-ons, table cash-outs, transfers, rake, BBJ
   contributions/payouts, promo releases and horse funding now declare real categories and
   counterparties (transaction-local GUCs read by the ledger writers).
7. **Financial epochs exist.** `ca_financial_epochs` (epoch 2 = hardened ledger) stamps every new
   ledger row. The Midway Union master reset opens epoch 3 — procedure in doc 05.
8. **A settlement state machine exists** (`ca_settlements`): Open → Locked For Calculation →
   Calculated → Validated → Ledger Posted → Post-Commit Verified → Final, single-step advance
   enforced by trigger, duplicates impossible, `final` immutable. Engine integration is the next
   phase (doc 05).
9. **Chip-supply monitoring:** hourly `ca_supply_snapshots` totals every pool and compares the
   delta against ledgered issuance/retirement; unexplained changes are visible per hour.
10. **Management dashboard:** `/financial-incidents` page (this PR) with acknowledge / assign /
    comment / resolve / reopen, the 20-minute countdown, escalation level, auto-repair status and
    the full event trail. Acknowledging never hides an incident; `unknown` incidents cannot close
    without a root cause.

## Proven working on production, same day

The self-test incident pushed to management phones and resolved cleanly. Within 20 minutes of
going live the system caught two real events — a failed tournament winner credit (repaired by the
standing payout reconciler; root-caused to the migration DDL lock window) and a rake/BBJ invariant
alert (fees verified re-driven) — both investigated, root-caused, and resolved inside their
20-minute targets, with the full trail recorded.

## Not done yet (honest gaps — see doc 05 for the plan)

- Engine `syncStacks` remains the one multi-step JS money path (crash window on hard kill).
- Remaining un-idempotent RPCs (`fn_union_send_to_member`, `transfer_chips_agent_to_player`,
  `fn_mint_club_chips`, treasury primitives) and the `fn_union_settle_player_pnl` partial-failure
  trap.
- Category GUCs on the mid-volume RPCs (cashier/agent/union sends, tournament register) — the
  suspense monitor measures exactly what remains.
- DB-permission lockdown so app credentials cannot UPDATE balance columns outside approved RPCs.
- World Hub ops API fixes ship as a separate PR (raw promo mint, parseFloat, durable idempotency).
- Full property-based game-sequence conservation testing in CI (probe suite covers the DB
  invariants today).

## Acceptance criteria status

See doc 05 §4 for the line-by-line mapping: 21 criteria met at the database layer, 6 partially
met with named follow-ups, 4 pending (engine/CI phases).
