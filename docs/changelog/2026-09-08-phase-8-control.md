# Phase 8 of 8 (union accounting): Control, and the commission that was off the journal since March

2026-09-08. Club Arena. One migration, one law. The last phase of the union
accounting programme.

## What Phase 8 was, in the words that deferred it

Phase 6 named it and said why it was not being built then
(`docs/changelog/2026-09-07-one-source-of-truth-for-rake.md`, section 5):

> A full journal (every wallet movement as two balanced legs with a trial
> balance) touches every money writer on the platform and is the most invasive
> item in the brief with the least urgency ... It belongs in Phase 8 (Control)
> next to approve-before-execute, where a journal has a reader.

## Most of Control was already built, and this does not rebuild it

The chip-accounting lane shipped the journal and its readers while this
programme was running. Before writing anything, that was measured rather than
assumed:

| Control                | Where it already lives                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| the journal            | `chip_ledger`, append-only via `fn_ca_journal_append_only`                                                |
| a reader               | `fn_ca_trial_balance`, per account, balances vs journal net                                               |
| a second reader        | `fn_ca_ledger_replay`, per account, between two snapshots                                                 |
| conservation           | `fn_ca_conservation_sweep`, `fn_settlement_conservation_check`, `fn_union_settlement_conservation_assert` |
| approve-before-execute | `fn_ca_propose_manual_adjustment` / `_approve` / `_reject`                                                |

So Phase 8 is not "build a journal". The gap was narrower and belonged to this
lane alone.

## The gap: the union's commission payers were not on that journal

Measured on production, 2026-09-08:

```
fn_union_weekly_rakeback_close  (round 1)  writes a keyed chip_ledger leg and
                                           asserts conservation on the balances
fn_settle_round2_club_to_agents (round 2)  NO LEG
fn_agent_claim_commission       (claim)    NO LEG
```

Round 2 debits through `fn_debit_treasury`, which writes a one-sided
`chip_transactions` row, and credits by `UPDATE`-ing `club_members.chip_balance`
directly with a one-sided `wallet_transactions` row. It even carries the comment
**"Both sides of the entry: club-side debit above, agent credit here."** Those
two "sides" are rows in two unrelated one-sided tables. Nothing pairs them, and
no reader can.

The claim is the same shape: `UPDATE clubs.chip_treasury`,
`UPDATE club_members.chip_balance`, one `chip_transactions` row, no leg.

The only commission legs that existed in `chip_ledger` were **78 legs totalling
117.92, all written on 2026-03-24**. Commission had been off the journal since
March.

## Why that is drift by construction, not merely untidy

`fn_ca_trial_balance` compares, per account, the movement in the balances
against the net of the journal's legs. It already carries both accounts this
money crosses, and both read clean today:

```
club_treasuries   balance_delta 108.58      ledger_net 108.58      difference 0.00
union_banks       balance_delta 31,353.07   ledger_net 31,353.07   difference 0.00
```

A payment that moves those balances and writes no leg moves `balance_delta`
and leaves `ledger_net` behind. The difference is the entire payout. This is
the shape CLAUDE.md 11.5 already records for `atomic_table_buyin`, where writing
`club_members.chip_balance` directly made 48 chips invisible to the one check
that existed.

## Nothing had leaked yet, and that is the whole point of the timing

- `chip_transactions` holds **zero** rows of type `commission_claim`: the
  current claim has never paid anybody.
- `agent_commission_settlements` is empty: round 2 has not run since the phase 7
  model change.
- Meanwhile **1,008,323.53** of commission is owed.

So the first union close would have moved about a million chips through a path
the journal cannot see, and the trial balance would have gone red on
`club_treasuries` and `player_wallets` the same hour, with no leg to explain it.
This lands before that close, not after it.

## The change

One `INSERT INTO public.chip_ledger` in each payer, written the way round 1
already writes its own:

- **from** `club_treasury` (`clubs.chip_treasury`), **to** `player_wallet`
  (`club_members.chip_balance`, which the supply snapshot calls `member_wallets`
  and the trial balance reports as `player_wallets`). Naming any other pair
  would post a leg the reader cannot reconcile.
- **category** `commission` for both. The vocabulary also has `agent_claim`, but
  round 2 and the claim are the same economic event through two doors; a reader
  asking what an agent has been paid should not have to know both words. Which
  door paid is in the description and the key.
- **idempotency_key** `round2:<union>:<period start>:<club>:<agent>` and
  `agent_claim:<op_id>`. `ux_chip_ledger_idempotency_key` is a unique index, so
  a replayed close or a retried claim cannot double-post;
  `ON CONFLICT DO NOTHING` says so rather than raising.
- **performed_by** `COALESCE(auth.uid(), <system identity>)`, copied exactly
  from round 1 because a cron-run close has no `auth.uid()` and the column is
  `NOT NULL`.

**No new failure mode.** `zz_freeze_guard` already sits on `clubs`,
`club_members`, `chip_transactions` and `wallet_transactions` - every table both
payers already write - so the maintenance freeze refuses these payments today
exactly as it will now. Adding `chip_ledger`, also guarded, changes nothing
about when they may run.

**A transform, not a pasted body.** Round 2 is 5.2K and the claim is 12.5K of
live money code; retyping either to add one `INSERT` risks altering a payout by
accident. Each block asserts its anchor appears exactly once, splices the leg
beside it, re-executes, and aborts rather than guessing. It is a no-op on a
database that already has the legs, and it asserts afterwards that each payer
kept its settlement row, its treasury debit and its transaction record.

## Proved before it was committed

Probed on production inside a transaction rolled back by its own `RAISE`
(section 11.5), with the transform applied inside the probe:

```
round 2 paid           4,730.87 to 83 payees
journal legs written   83
sum of those legs      4,730.87     exactly what was paid
second identical run   0.00 to 0 payees
legs after second run  83           unchanged
```

## The law

`tests/a-commission-payment-is-on-the-journal.law.test.ts` pins that both payers
post to `chip_ledger`, that each leg crosses `club_treasury -> player_wallet`
under one category, that each is keyed and `ON CONFLICT DO NOTHING`, and that
the migration refuses to guess. Registered in `docs/laws.d/`.

## What Phase 8 deliberately does not do

- **It does not put every wallet movement on the journal.** Phase 6's brief
  described that, and it remains true that it "touches every money writer on the
  platform". What this phase does is close the union lane's own gap, which is
  the part this programme owns and the part with a million chips about to move
  through it. The remaining unjournalled writers are other lanes' and are named
  by `fn_ca_trial_balance` itself whenever they drift.
- **It does not add a second approve-before-execute.** One already exists
  (`ca_manual_adjustments` and its propose/approve/reject doors). Building a
  union-specific one would be the second mechanism CLAUDE.md 10.8 warns about.

The union accounting programme is complete: phases 1 to 8.
