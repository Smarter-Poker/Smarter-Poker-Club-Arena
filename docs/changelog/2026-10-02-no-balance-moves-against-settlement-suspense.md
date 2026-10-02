# 2026-10-02 - No balance moves against settlement suspense

Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip drifts
should not be possible."

## The hole

By 05:26 UTC all fifteen chip stores refused at commit when their balance and
their `chip_ledger` legs disagreed (20261001160611 .. 20261002042417). That
check asks whether a store's delta equals the legs that name it; it never asked
where the other end of the leg went. `fn_ca_autoledger` and
`fn_club_members_ledger_writer` post a balance write's counter-leg to
`app.ledger_counterparty` and, when the writer declared nothing, default it to
`settlement_suspense` - a label with no balance column, outside the supply
count. An undeclared write to any covered balance therefore balanced by
construction, and the chips appeared from, or vanished into, suspense.

## What the rows said (chip_ledger, 30 days, read 06:50 UTC)

| class                                                                                |  legs | transactions |       amount | window                  |
| ------------------------------------------------------------------------------------ | ----: | -----------: | -----------: | ----------------------- |
| balance moved against suspense (journal trigger default counterparty)                | 7,740 |        2,827 | 1,722,820.60 | 09-02 .. 09-14 06:27:40 |
| journal-only, `fn_ca_post_correction` (incl. the 09-26 owner-authorised restatement) |    16 |            2 | 4,668,297.40 | 09-06, 09-26 07:23:52   |
| journal-only correction legs written by settlement migrations                        |    59 |            4 |    41,214.98 | 09-07 .. 09-09          |

No suspense leg of any kind since 2026-09-26 07:23:52 UTC: every live door
declares its counterparty. Writers in pg_proc: the two journal triggers'
default (the hole), `fn_union_credit_wallet_zd3core` (an unmapped `tx_type`
declares nothing and falls to the default), and the journal-only
`fn_ca_restate_settlement_suspense_20260926`. The other bodies naming
`settlement_suspense` only read it or mention it in a comment.

The open suspense balance (owner-pending restatement) is not touched.

## The fix

Migration `20261002065836_no_balance_moves_against_settlement_suspense`:

- `fn_ca_tally_ledger_leg` counts every leg with `settlement_suspense` on either
  side, before the journal-only correction exemption, under the tally key
  `settlement_suspense` (no store resolves to it).
- `fn_ca_balance_has_its_ledger_row`, after every store is checked, refuses a
  transaction that wrote a suspense leg and moved any covered balance:
  `REFUSED: balance_moved_against_settlement_suspense suspense_legs=... moved=...`
  (SQLSTATE 23514, the writer's statement in DETAIL). A journal-only correction
  moves no balance and commits.
- The judgement has its own `ca_ledger_invariant_store_mode` row,
  `settlement_suspense`, installed in `observe` (a would-be refusal records a
  finding with `account_key = 'settlement_suspense'` and commits). The flip to
  `refuse` is a separate migration once the window reads zero.
- chip_ledger's ShareRowExclusive lock is taken first, alone, under a 250 ms
  lock_timeout with retry; nothing is dropped.

## Proof

- `scripts/dev/test-ledger-invariant.sh` applies the real migration after every
  store proof and runs `tests/fixtures/ledger-invariant/suspense-regression.sql`:
  five planted regressions refused by name (undeclared wallet credit,
  undeclared union rake debit, a stand-down writing its own suspense leg,
  suspense reached through a label with no balance, a correction label beside a
  balance move), three live shapes committed (declared buy-in, journal-only
  restatement, journal-only leg to a non-store label), and the observe case.
- `tests/every-chip-store-balances-with-its-ledger-row.law.test.ts` reads the
  latest body of both functions across every migration and plants a body
  without the rule to prove it goes red.
