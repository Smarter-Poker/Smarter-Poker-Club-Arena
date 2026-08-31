# Hardened Ledger Architecture (2026-08-31)

## The authority

`public.chip_ledger` is the authoritative journal of every chip movement. Each row IS a balanced
double entry: one debit (`from_type`/`from_entity_id`) and one credit (`to_type`/`to_entity_id`)
of the same positive `amount` — sum of debits equals sum of credits by construction, per row.
Multi-leg settlements are rows sharing `correlation_id`/`settlement_id`. Issuance and retirement
must debit/credit the explicit system accounts (`issuance_reserve`/`system_mint`,
`chip_retirement`/`system_burn`) — never a one-sided wallet update.

This deliberately extends the EXISTING production ledger rather than introducing a parallel
two-table journal: every reconciliation job, baseline, and dashboard already reads `chip_ledger`,
and a second ledger nobody reads is how drift hides. The trade-off (one row per movement instead
of N-entry transactions) is documented and compensated by correlation/settlement grouping.

## The complete record (directive checklist → column)

amount → `amount` (exact 2dp, constrained + trigger-normalized) · chip type → `currency` implied
by account type (`promo_wallet` vs `player_wallet`; club chips are the unit) · source/destination
→ `from_*`/`to_*` (+ `from_label`/`to_label` for sub-wallets) · union/club → `union_id`/`club_id`
· table/tournament/hand → `table_id`/`tournament_id`/`hand_id` · actor → `performed_by` +
`actor_service` + `db_role` · type/reason → `category` + `description` · timestamp → `created_at`
· idempotency key → `idempotency_key` (unique) · correlation/causation → `correlation_id`/
`causation_id` · settlement → `settlement_id` · epoch → `epoch_id` · pre/post balances →
`pre_from_balance`/`post_from_balance`/`pre_to_balance`/`post_to_balance` · debit/credit → the
row's two sides · status → `status` (posted | correction | reversal).

## Account registry

`ca_ledger_accounts` documents every account type, its side, its backing store, and whether it
must net to zero. `settlement_suspense` is the only must-be-zero account: it exists to make
undeclared movements measurable, never to hide drift (`v_ca_suspense_balance` + the daily
suspense incident enforce that).

## Append-only + tamper evidence

- UPDATE/DELETE on all five journals rejected by `fn_ca_journal_append_only` (P0403).
  Carve-outs: metadata/notes-only annotation updates; GDPR anonymization of `performed_by`;
  authorized maintenance via `SET LOCAL app.ledger_maintenance = '<incident ref>'`, fully logged
  to `ca_ledger_mutation_log`.
- Corrections are new linked rows (`category='correction'`/`'reversal'`, `causation_id` pointing
  at the original, incident reference in metadata) — never edits.
- Every row: monotone `chain_seq` + SHA-256 content checksum (`row_hash`, versioned 'v1').
  `prev_hash` is best-effort forensics. The design intentionally does NOT chain each insert
  through the previous row's committed hash: that requires a global serialization point (and a
  deadlock surface) inside every money transaction, which the Critical Availability Policy
  forbids. Tampering with any stored row breaks its checksum; deleting rows leaves `chain_seq`
  gaps beyond the benign rollback rate. `fn_ca_verify_ledger_chain` recomputes daily (cron
  `ca-ledger-chain-verify-daily`) and raises a critical incident on any break.
- No secrets or credentials ever enter transaction metadata.

## Full coverage (no unjournaled balance change)

`fn_ca_autoledger` (generic, `TG_ARGV` = `column=account_type` pairs) is attached to: `clubs`
(chip_treasury, chip_pool, promo_balance, insurance_balance), `club_wallets` (chip_balance,
insurance_balance), `union_wallets` (six wallets), `unions` (six legacy columns), `agents`
(agent/promo wallets), `bbj_pools` (main/backup/promo/pool_amount), `spin_bonus_pools`,
`club_members.promo_balance`. `club_members.chip_balance` keeps its dedicated writer
(`fn_club_members_ledger_writer`).

The GUC contract (transaction-local, read by both writers):

| GUC | Meaning |
|-----|---------|
| `app.ledger_category` | category for rows journaled in this transaction |
| `app.ledger_counterparty` / `app.ledger_counterparty_entity` | the other side of the movement |
| `app.ledger_correlation` / `app.ledger_settlement` / `app.ledger_idempotency_key` | stamped onto rows by the enrich trigger |
| `app.ledger_autoskip_<table>` = '1' | this transaction self-journals that table (set it, do the update, set '0') |
| `app.ledger_maintenance` | authorizes+logs a journal mutation (incident ref required) |

Undeclared movements default to `category='adjustment'` against `settlement_suspense` — visible,
measured daily, incident-raised. The felt (`table_seats.stack`) is deliberately NOT per-update
journaled: pots settle per hand under a single-writer engine lease; the journaled events are the
wallet↔felt crossings (buy-in, rebuy, add-on, cash-out, rake off the pot, BBJ drop, payouts),
and felt conservation is enforced by `ca_seat_stack_exits`, per-hand StateVerifier checks, and
the session equation in reconciliation.

## Financial epochs

`ca_financial_epochs`: epoch 1 = pre-hardening history; epoch 2 = hardened ledger (current,
stamped on every new row by the enrich trigger). The Midway master reset opens epoch 3 (doc 05).

## Rounding policy

One deterministic policy: all chip amounts are exact 2-decimal `numeric`; the ledger constrains
and normalizes to `round(x, 2)`. Remainder rules already in force and retained: BBJ split uses
cumulative-rounding residual carry (remainder to promo, exact by construction); bomb-pot and
BBJ payout splits assign the cent remainder to the first recipient; rake allocation mismatches
raise `RAKE_ALLOCATION_MISMATCH` critical alerts. No fraction disappears: sub-cent inputs are
normalized at the boundary and the source RPCs are being converted to exact 2dp arithmetic
(`fn_credit_chips`, `promo_apply_playthrough` fixed; remaining ::integer casts tracked).

## Settlement state machine

`ca_settlements`: `open → locked_for_calculation → calculated → validated → ledger_posted →
post_commit_verified → final`, single-step advance trigger-enforced, `failed` reachable from any
non-final state and resumable at or before `ledger_posted`, `final` immutable, one settlement per
`(settlement_type, external_ref)` by unique constraint. `locked_for_calculation` locks only the
settlement row — never a table, club, union, wallet, or player. Engine adoption plan in doc 05.
