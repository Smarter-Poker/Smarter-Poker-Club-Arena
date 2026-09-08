# The closing position comes first

2026-09-08. Roadmap 9.8 step 1, built — the piece the epoch reset contract
calls the one that cannot be added afterwards. Branch
`feat/the-closing-position`.

## Why this and not something else

The nine phases closed this morning. `docs/CHIP-EPOCH-RESET-CONTRACT.md` was
written a few hours earlier **on the assumption that nothing was built**.
Reading production afterwards found that it was:
`fn_ca_execute_epoch3_reset(p_confirm, p_dry_run)`, with a preflight, a
confirmation literal and a dry-run mode. So the honest next piece of work was
not to build a reset — it was to audit the one that exists against the contract
just written for it.

## What the audit found

**The reset destroys balances it never records.** It retires the horse
tournament-cashout mint by draining each user's club balances largest-first,
retires the frozen `public.wallets` pool, closes the epoch, re-baselines the
treasury, and **only then** calls `fn_ca_supply_snapshot()`. The snapshot is
taken _after_ everything is zeroed. Nothing anywhere holds what each account
had the moment before, which means:

- the closing epoch could never be audited once closed — every later question
  ("what did this player actually have?") is unanswerable;
- contract step 3, _one migration that can put every balance back_, has nothing
  to read. There is no restore.

**No freeze check and no seated check.** The contract requires the reset to run
inside the :55 break with nobody seated. Nothing checked either, so it could
run mid-hand.

**One thing the audit cleared.** The retirement's comment claims each debit is
ledgered, and it is: `trg_club_members_audit_chip_movement` fires
`fn_club_members_ledger_writer` on every `chip_balance` update. That claim was
true.

**And one contradiction the contract had to resolve.** Step 2 says run inside
the freeze — but `zz_freeze_guard` on `club_members` refuses `chip_balance`
writes exactly then. The escape is real and audited (`fn_freeze_bypass_active`,
`app.freeze_bypass`), so the contract is buildable; without checking, step 2
would have been an instruction that could not be followed.

## What was built

**`ca_epoch_closing_positions`** — one row per account per capture,
**append-only** under `fn_ca_journal_append_only`, the guard phase 8 put on the
other journals, with 9.1's two-decimal constraint and service-role-only RLS.

Deliberately **not** `ca_account_snapshots`: that table is operational and
rolling (9,098 rows, read by the replay). A record that a dispute will be
settled from six months later must not share a table with rows that churn, and
9.4 keeps this one for seven years.

**`fn_ca_capture_closing_position(p_note, p_dry_run)`** — captures every class
the **supply meter itself reads**, so the closing position and the supply
identity agree by construction rather than by coincidence: member wallets and
member promo, the cash felt, club treasury / chip pool / promo / insurance, club
wallets, all six union wallet columns _named individually_, both agent wallets,
the three BBJ banks, the spin reserve, and the frozen `wallets` pool.

Plus one the meter does **not** count: `agents.player_wallet_balance`. It is
outside the circulating identity, but the reset would still destroy it, and a
position that omits a balance somebody holds is not a position. Reconcile
against the meter by excluding that class, not by dropping it.

A real capture **refuses unless the platform is frozen** — a balance read while
play continues is stale before the statement finishes. `p_dry_run` reads the
same numbers, writes nothing, and can be rehearsed at any time.

**`fn_ca_closing_position_summary(p_capture_ref)`** — reads it back per class
and in total, so the restore migration has something to be written from and the
capture can be checked against `fn_ca_supply_snapshot()` before anyone trusts
it.

**The reset refuses without one.** Three refusals ahead of its first write: the
platform must be frozen, no seat may be occupied, and a closing position must
exist for the current epoch from the last fifteen minutes. Applied as an
**asserted text substitution** on the live definition — the function is money
code and retyping ninety lines to insert eight is how an unrelated line goes
missing. It aborts if the anchor is not found exactly once and is a no-op on a
second run.

## Measured, in a rolled-back probe

The position covers **2,860 accounts and 925,662,528.55 chips** across twelve
classes:

| class              | accounts | total          |
| ------------------ | -------- | -------------- |
| frozen_wallet_pool | 582      | 732,581,294.03 |
| player_wallet      | 1,915    | 172,023,648.59 |
| agent_wallet       | 99       | 10,066,000.00  |
| club_wallet        | 4        | 4,353,569.22   |
| club_treasury      | 4        | 3,556,754.22   |
| union_wallet       | 4        | 2,710,840.09   |
| bbj_pool           | 6        | 181,029.08     |
| table_stack        | 239      | 80,393.42      |
| spin_reserve       | 2        | 67,256.20      |
| club_promo         | 3        | 24,284.63      |
| club_pool          | 1        | 12,459.07      |
| agent_promo        | 1        | 5,000.00       |

Excluding the frozen pool — which is retired, not circulating — that is
**193,081,234.52**, against the roadmap's Mint register figure of
193,144,847.90. The two agree to within the ordinary movement of a live day,
which is the check that says the capture is reading the right world.

## Nothing here can run today, and that is correct

`fn_ca_epoch3_preflight()` currently fails four of its seven checks: 214 open
incidents, 3,556 suspense rows, 9 unregistered RPCs, 6 write failures in 24h.
The reset is refused before any of this is reached. What changed is not what
runs now — it is what is _possible_ on the day the preflight passes.

## Named, not fixed

`fn_ca_execute_epoch3_reset` does `DELETE FROM ca_treasury_baseline` before
re-inserting. That is editing history in place, which CLAUDE.md 10.9 forbids in
as many words. It is the reset's own line to correct when it next changes, and
it is left alone here rather than folded into a migration about something else
— but it is written down so the next reader sees it.

## Still open

The restore migration itself (contract step 3). It can now be written, because
there is finally something for it to read; it should be written and
rolled-back-tested **before** the reset runs, not after.
