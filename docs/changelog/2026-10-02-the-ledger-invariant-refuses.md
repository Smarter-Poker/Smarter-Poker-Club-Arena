# 2026-10-02 - The ledger invariant refuses

Dan, 2026-10-01: "chip drifts should not be possible and should never happen
when EVERY SINGLE TRANSACTION is logged, and on the same ledger."

## For Dan

Chip drift is now impossible on every covered account rather than detected
after the fact. Since migration 20261002015339, a transaction that moves a
player wallet, a club treasury, the cash felt, a union bank or wallet, or a
jackpot pool by any amount the chip ledger does not record in that same
transaction is refused whole at commit, by name
(`REFUSED: balance_moved_without_its_ledger_row`), and nothing is written. The
check ran for three and a half hours in observe mode first: everything it
found was one class, a hand's fees moving off the felt in one transaction and
being recorded in the next, which #5760 fixed at its line at 00:04 UTC. From
00:05 to the flip it found nothing under full traffic, and the one money door
that had no traffic in that window, the Bad Beat Jackpot payout, was run
against a live table in a rolled-back probe and passed. The three drift rows
left over from before the fix are settled in
`2026-10-02-the-three-drift-rows-from-before-the-invariant.md`.

## What was checked before the flip (read from rows, 01:43 UTC)

- `ca_ledger_invariant_findings`: 13,819 rows, 22:24:25 -> 23:54:10 UTC, every
  one `table_stack`, every one the hand-commit / post-commit obligations pair.
  Zero since 00:05.
- Every chip_ledger category with traffic in the window (rake, jackpot drop,
  buy-in, cash-out, add-on, tournament buy-in and prize, Spin entry and prize,
  bounty, overlay, promo, mint, burn, commission, rakeback, horse funding,
  treasury transfer, opening allocation) committed with no finding.
- The categories with no traffic since install: `bbj_payout` (last 21:20 UTC)
  and `ticket_redeem`. `ticket_redeem` moves escrow to prize_liability, neither
  covered. `bbj_payout` was executed - `fn_bbj_mini_payout` (700.00, five
  seated recipients and one paid to the wallet) and `bbj_atomic_payout_v2`
  (1% of main, 312.28) - on cash table af2daa4a in one `DO` block with the mode
  set to `refuse` and `SET CONSTRAINTS ALL IMMEDIATE` after each payout
  returned, then rolled back. Both passed: felt 656.25 = 656.25, pool -700.00 =
  -700.00. (A first attempt set the constraints immediate BEFORE the call,
  which checks after every statement inside the function, and refused on the
  pool debit before the recipients were credited. That is not what commit
  does; the corrected probe is the one recorded.)
- The Diamond `SET CONSTRAINTS` question. `fn_poker_diamond_tournament_drain`
  and `fn_poker_diamond_spin_draw` set only
  `zzz_diamond_entry_custody_is_the_entry` (a constraint on
  `poker_diamond_custody`) IMMEDIATE and back to DEFERRED. Naming a constraint
  fires only that constraint's queued events, so neither can fire `zz_ca_*`
  mid-function. Neither has ever run (0 `poker_diamond_movements`, 0 receipts
  with money_path `fn_poker_diamond_spin_draw`), so the zero window says
  nothing about them; the reading of their bodies is the evidence. No change.
- No `pg_proc` body issues `SET CONSTRAINTS ALL`, writes
  `ca_ledger_invariant_mode`, runs `DISABLE TRIGGER`, or sets
  `session_replication_role` (the one body that mentions it,
  `fn_ca_guard_mtt_admission_contract`, only reads it to refuse replica mode).

## The flip

`supabase/migrations/20261002015339_the_ledger_invariant_refuses.sql`: one
transaction; a preimage that aborts unless the row is still `observe` and
there are zero findings since 00:05 UTC; `UPDATE ... SET mode = 'refuse'`; a
read-back. Data only, no DDL, so no PostgREST reload.

The law (`tests/a-balance-never-moves-without-its-ledger-row.law.test.ts`)
now pins the flip by name as the last write to the row and `installed mode:
refuse` in `docs/laws.d`. Planted regressions, both red: a later migration
`UPDATE ... SET mode = 'observe'`, and a later `INSERT ... VALUES ('observe')
ON CONFLICT DO UPDATE`.

`tests/law/DiamondRulesRefuseOnlyByAFlipSomeoneRead.law.test.ts` refused any
migration anywhere containing `SET mode = 'refuse'`, so it read this flip of a
different switch as a hand-written Diamond rule flip. Its pattern is now
scoped to an `UPDATE` of `ca_diamond_rule_modes`, with its negative control
kept and a scope control added for this migration's shape.

If a live path is ever refused, the answer is to fix that writer at its line
(CLAUDE.md 10.11). If the refusal is stopping play before that fix can land,
the row may go back to `observe` only through a migration applied by
`apply-merged-migration.yml` that names the refused writer in its header and
changes this law in the same commit; it stays a data change. An allow-list or
a disabled trigger is never an option.
