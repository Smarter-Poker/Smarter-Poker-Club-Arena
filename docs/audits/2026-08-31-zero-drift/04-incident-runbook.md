# Drift-Incident Operational Runbook

## What a push notification means

A push titled "🚨 Chip drift: <classification> (<amount>)" means a detector found a nonzero
discrepancy and an incident opened in `ca_drift_incidents`. The body carries: severity,
classification, discrepancy amount, layer (ledger/projection/cache/reporting/settlement),
expected vs actual, club/union names, incident age, the 20-minute reconcile target time, and the
auto-repair status. Player-identifying details are deliberately excluded from push previews —
open the dashboard for full context. The link lands on `/hub/club-arena/financial-incidents`.

You will receive AT MOST these notifications per incident: the initial raise, a 5-minute update,
a 10-minute senior escalation, a 15-minute final warning, a 20-minute past-target notice, then a
controlled update every 15 minutes (senior recipients) until resolved, and one resolution notice.
Duplicate detections of the same problem bump `occurrences` on the open incident — they never
create a second incident or a second push (dedupe key), and a burst of ≥10 new incidents in two
minutes suppresses individual pushes in favor of the budget-capped escalation tick (storm
control). Every notification and escalation is recorded in `ca_incident_events`.

## Who gets notified

Dynamically per incident: the affected club's owner(s), the affected union's owner, plus every
active row in `ca_incident_recipients` (platform admins are seeded from `profiles.role` in
('admin','god'); add financial-ops/technical recipients by inserting rows — scope 'platform',
'financial_ops', 'technical', or scoped to a union/club; `senior=true` joins the 10-minute
escalation set).

## The 20-minute workflow

1. **0 min** — incident opens; automated reconciliation begins immediately (per-minute repair
   tick). The platform stays fully available: nothing is ever locked, closed, or frozen by drift
   detection — that is enforced in code, not just policy.
2. **Acknowledge** in the dashboard (it stays visible — acknowledging never hides or closes).
3. Check `auto_repair_status`: `repaired` means the re-drive + re-verify closed it (you'll get
   the ✅ push); `running` means an idempotent re-drive was launched and it is re-checking;
   `manual_needed` means no automated repair applies — investigate.
4. Investigate from the incident's ids (table/tournament/hand/settlement/wallets) and the event
   trail. Useful queries: `fn_unaccounted_seat_exits(interval)`, `v_ca_suspense_balance`,
   `ledger_reconcile_log` for the entity, `ca_supply_snapshots` for supply-level anomalies,
   `fn_ca_verify_ledger_chain(N)` for tamper checks.
5. **Correct through the ledger, never around it**: a correction is a new balanced
   `chip_ledger` row (`category='correction'`, `causation_id` = original row, incident id in
   metadata) posted by the appropriate RPC or migration. Never edit or delete a posted row;
   never use suspense to park a permanent difference; never mint/burn to make numbers match
   (issuance/retirement are for authorized supply changes only, against the explicit system
   accounts).
6. **Resolve** with a note; `unknown`-classification incidents refuse to close without a root
   cause (enter one, or reclassify by resolving with the true classification in the note and
   root cause). Reference the correction row id in `correction_ref`.
7. Past-target incidents keep escalating on a controlled cadence until resolved — that is the
   design, not a malfunction.

## What automated reconciliation may and may not do

May: recalculate deterministically, replay idempotent re-drives (`fn_redrive_unbanked_rake`,
`fn_bbj_repair_unbanked`, the tournament payout reconciler, spin sweeps), rebuild
cached/projection values from the ledger, re-verify and auto-resolve when the source measurement
is clean. May not (and structurally cannot): silently alter balances, insert unexplained
adjustments, delete or rewrite history, hide a discrepancy, or mint/burn to balance.

## Maintenance escape hatch (rare, audited)

A migration that must mutate journal history sets
`SET LOCAL app.ledger_maintenance = 'incident:<uuid> — reason';` — the mutation is then permitted
and every row change is copied to `ca_ledger_mutation_log` with role, application, and reason.
Using it without an incident reference is a policy violation; the daily checksum verify will also
flag content changes to hashed fields as `unauthorized_adjustment`.

## Standing schedules

| Cron | Cadence | Job |
|------|---------|-----|
| ca-incident-escalation-tick | every minute | 5/10/15/20-minute escalations, storm-capped |
| ca-auto-reconcile-tick | every minute | automated repair + re-verify + auto-resolve |
| ca-quick-reconcile-5m | every 5 min | negatives, frozen pool, stuck settlements, fresh unaccounted seat exits, ledger-write failures, suspense rollup |
| ca-supply-snapshot-hourly | hourly | full supply totals vs ledgered mint/burn |
| ca-ledger-chain-verify-daily | 04:35 UTC | checksum verification (raises on breaks) |
| (pre-existing) reconcile_ledger_nightly, rake/BBJ/tournament/spin audits | nightly/hourly | now feed incidents automatically |

## Probe suite

`scripts/dev/zero-drift-probes.sql` — run any time against production; every probe executes
inside a transaction that rolls back (CLAUDE.md 11.5 compliant). 15 probes covering
immutability, idempotency, category/scale enforcement, enrichment, auto-journaling, the
settlement state machine, and the incident lifecycle. All 15 passed on 2026-08-31.

## Round-2 cadence update (2026-08-31 16:00 UTC)

Escalation is severity-aware: **critical** = full 5/10/15/20-minute schedule plus controlled
post-target repeats; **warning** = one 5-minute update and one past-target notice; **info** =
dashboard-only, no pushes. The daily unclassified-flow (suspense) rollup is info severity — read
it on the dashboard's "Unclassified Flow Today" card. New standing cron:
`ca-bbj-repair-unbanked-15m` re-banks any BBJ drop the engine failed to bank, within 15 minutes.

## Phase-2 cadence update (2026-08-31 19:00 UTC)

The suspense flow is drained: spin settlements, tournament rake banking, guarantee overlays,
BBJ repair, and bare `increment_union_wallet` calls all declare categories now, so NEW
unclassified flow is a regression, not a migration artifact. New standing cron
`ca-suspense-regression-15m`: more than 10 suspense rows or 50 chips of suspense flow in any
hour (after the 19:01 UTC cutover) raises a warning incident (deduped hourly) — it means a
money path lost, or never had, its category declaration. The daily info rollup remains the
dashboard's "Unclassified Flow Today" card.

## Phase-3/4 cadence update (2026-08-31 19:45 UTC)

New standing schedules: `ca-settlement-correctness-30m` (cross-club postings, rakeback chain
invariants, ticket conservation, insurance pair-match), `ca-daily-attestation` (06:10 UTC digest
push — green days say "all green"), `ca-ledger-day-manifest` (04:25 UTC SHA-256 manifest per
ledger day; recompute mismatch = critical tamper incident), `ca-hand-facts-prune-daily` (90-day
retention on `ca_hand_financial_facts`). A `tourney-cashout-blocked:*` warning means the engine
tried to cash a tournament play-chip stack out as real chips — the guard blocked the credit and
closed the seat; fix the engine exit path, never re-enable the credit. `fn_ca_balance_asof`
answers "what did this account hold at time T"; `fn_ca_gdpr_financial_precheck` lists why an
account cannot close financially.
