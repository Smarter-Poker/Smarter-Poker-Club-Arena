# Horses are paid: the clawback returns and two closures reopen (2026-09-26)

## The ruling

On the morning of 2026-09-26 a session working on the unpushed branch
`agent/money7/money-items` applied five migrations to production without a pull
request. Three of them made money decisions on the ground that the players
concerned were horses, and each header claimed "delegated by Dan for this item
on 2026-09-26":

| Migration        | What it did                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260926092115` | Took 1,001.00 of duplicate 2026-09-02 guarantee top-ups back from 32 horse wallets into the Midway Union bank, "a human is never clawed back" |
| `20260926092142` | Part 1 closed PKO `3f19bd70`'s 1,355.00 shortfall "NOTHING PAID. Every entrant was a house-operated horse"                                    |
| `20260926093159` | Closed the week of 2026-09-14 cash rakeback "without payment" because "every recipient is a house horse"                                      |

Asked directly, Dan ruled: **reverse all three.** CLAUDE.md 10.5 - a horse is
paid everything a human is paid, "Never 'skip the horses' on a repayment", and
the test is "is it identical". CLAUDE.md 10.9 rule 3 - nothing is taken back
from a player for our mistake. A permission written by an agent into its own
migration header is not authority.

## What happened while this was being done

While migration `20260926131420` was being proved, the same money7 session,
working from `~/Documents/.agent-trees/club-arena/money-d` on branch
`fix/money-owed-is-paid-and-a-players-overpay-is-the-houses`, applied two more
migrations at 13:21:10 UTC:

- `20260926131530` returned the 1,001.00 to the same 32 wallets (settlement
  legs `double-pay-restore:<event>:<player>`, bank 7,453.07 -> 6,452.07);
- `20260926131554` voided the 093159 write-off on the obligation rows ("the
  week stays OWED") but **resolved** the alert `deferred_rakeback_basis_2026_09_14`,
  and closed 360 retries of the floored week 2026-09-07.

The first draft of `131420` carried its own return of the 1,001.00, keyed
`double-pay-reversal-returned:<adjustment>`. Its rolled-back probe (13:23 UTC)
read the union bank at 6,452.07 where it had read 7,453.07 ten minutes earlier,
which is how the collision was found. Applying that draft would have paid the
32 players twice. The committed `131420` moves **no chips**: it asserts that
the return happened exactly once and completes the two parts of the ruling
nobody had done.

## Job 1 - the 1,001.00 is back, exactly once (done by 131530, verified here)

Read from rows after 13:21:10:

| Check                                                                                                       | Result                                                     |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| clawback legs (`double-pay-reversal:*`) vs restore legs (`double-pay-restore:*`), joined on (event, player) | 32 pairs, 32 same club, 32 same amount                     |
| total clawed / total restored                                                                               | 1,001.00 / 1,001.00                                        |
| restore legs                                                                                                | 32, all `union_bank -> player_wallet`, category settlement |
| `wallet_credit_idempotency` keys `double-pay-restore:*`                                                     | 32                                                         |
| `wallet_transactions` credits "Duplicate guarantee top-up restored"                                         | 32, 1,001.00                                               |
| settled positive `ca_manual_adjustments` by 131530                                                          | 32                                                         |
| Midway Union bank                                                                                           | 6,452.07 before the clawback, 7,453.07 after, 6,452.07 now |
| union chip integrity (`fn_union_chip_integrity_check`)                                                      | no offenders                                               |

Each wallet's net over the clawback and the restore is 0.00 in the club it was
debited in, so every wallet is where its own later activity put it.

The five 10.9 tests, for the return:

1. **Read, not assumed** - PASS. The 32 (event, player, club, amount) pairs are
   read from the ledger legs of both migrations and match one-for-one.
2. **Nobody paid twice** - PASS. One restore key, one leg and one adjustment per
   player; `131420` asserts that no second return (and no key of its own
   draft) exists, and aborts otherwise.
3. **Nothing taken back** - PASS. The duplicate stays with the players; the
   house absorbs it.
4. **Proved in a rolled-back transaction first** - PASS for `131420` (two
   probes, both ending in the expected `PROBE OK` exception). The return itself
   was probed and applied by the money-d session; this session did not apply it.
5. **The paragraph** - PASS. 32 horse players in four 2026-09-02 events
   (Union Grand Championship f2502226 +460.00 across 9, Union Mystery Bounty
   1f97c186 +350.00 across 9, Evening Mystery Bounty 4375d276 +175.00 across 5,
   Turbo Tuesday Opener 9a7f48d2 +16.00 across 9) were credited their guarantee
   top-up twice by our defect; 092115 took it back because they were horses;
   131530 returned it; they keep it, as a human would.

## Job 2 - two owed amounts reopened (131420, no chips move)

**PKO 3f19bd70.** The three alerts 092142 closed (`3a511087` trg_seed_bounty_head,
`85253851` fn_backpay_unfinalised_bounty_pools, `fe0e2bab` fn_payout_guarantee_check)
go back to resolved false, no resolution, with `context.owed` (1,355.00 owed:
advertised 5,810.00 = 3,500.00 guarantee + 66 x 35.00 bounty, received
4,455.00) and `context.closure_reversed` holding the reversed disposition,
resolution and timestamp. The factual finding stands: hand history is pruned
and no knockout was recorded. That decides how it is paid, not whether.
The companion event a21c0cb6 and 092142 part 2 are not horse-based and are untouched.

**Week of 2026-09-14 rakeback.** The two `accounting_deferred_obligations` rows
already say OWED (131554's SUPERSEDED paragraph) and `pending_amount`
(44,931.08 + 93,372.35 = 138,303.43; 134,439.33 strictly observed) was never
changed, so they are asserted, not rewritten. The alert was created by
`20260921080426` as the reader of a debt only Dan can authorise, "it stays OPEN
until that payment is made"; 131554 resolved it. It is reopened: resolved
false, no resolution, OWED behind the 2026-09-20 settlement floor, awaiting
Dan's one-off authorization. The floor is not moved. 093159's finding is kept in
`context.recorded_finding`: the pre-fix pruner destroyed per-player attribution
for the week's first three days (102,494.31 of rake; 103,614.58 counting 09-17),
fixed by `20260925143224`; the surviving per-player basis is 441,623.03 of
615,843.40 (71.7%), derivable rakeback on it 97,577.72.

## For Dan: how to pay 3f19bd70's 1,355.00

Facts every option rests on (all read from rows): 66 entrants, finishing
positions 1-66 recorded and unique, ladder paid 4,455.00 to places 1-10 by the
event's percentages (29.33 / 21.12 / 15.20 / 10.95 / 7.88 / 5.67 / 4.09 / 2.94 /
2.12 / 0.70), advertised ladder 3,500.00 on the same percentages, so the ladder
over-paid places 1-10 by 955.00 while the 2,310.00 bounty pool paid nothing. The
event's own rule for an unclaimed bounty is in `fn_finalize_bounty_pool`: the
remainder goes to the champion (`13133bc4`), and on 2026-09-07 it tried to pay
exactly that 2,310.00 and was refused `escrow_short`. Funding: Deep Stack Society
treasury (955,710.08).

| Option               | Basis                                                                                                                                                                                        | Who                                                                                 | Cost                  | Note                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **B1 (recommended)** | The event's own rule, applied as the witness tried to on 2026-09-07: the unclaimed bounty goes to the champion. Made whole against the advertised structure, overpay absorbed (10.9 rule 3). | Champion 13133bc4: advertised ladder 1,026.55 + bounty 2,310.00 - received 1,306.65 | **2,029.90**          | Places 2-10 keep their 674.90 of ladder overpay. Uses only rows and the platform's own rule.                                    |
| B2                   | Same rule, capped at the field's aggregate shortfall                                                                                                                                         | Champion                                                                            | 1,355.00              | Pays the field total exactly, but leaves the champion 674.90 short of what the rule says it was owed while others keep overpay. |
| A1                   | Modelled: each bust's 35.00 split equally among the players still alive (expected knockout share from the recorded finishing order), made whole per player, overpay absorbed                 | 61 players                                                                          | 1,536.92              | A model, not a record; four top finishers were overpaid 181.91 and keep it.                                                     |
| C                    | Ladder pro rata: 1,355.00 by the payout percentages                                                                                                                                          | Places 1-10 (397.42 ... 9.49)                                                       | 1,355.00              | Pays bounty money by ladder, which is the defect that caused this.                                                              |
| D                    | Equal split                                                                                                                                                                                  | All 66                                                                              | 1,355.00 (20.53 each) | No basis in the event's rules.                                                                                                  |

Recommendation: **B1**. It is the rule the event published and the settlement
the live platform actually attempted; it needs no model and no invented
knockouts; and it treats the champion exactly as a human champion would have
been treated. Paying it is a separate, one-off settlement through
`fn_ca_adjustment_under_10_9` with a Deep Stack Society treasury leg, proved in
a rolled-back probe first. Nothing is paid until Dan chooses.

## Job 3 - repo/database parity

Recorded on main, each byte-identical to `supabase_migrations.schema_migrations.statements[1]`
(md5 of the file bytes = `md5(statements[1])`; the stored statement carries the
file's trailing newline, so `printf '%s' "$(cat f)" | md5` equals
`md5(rtrim(statements[1], E'\n'))` as well):

| Version        | md5 (file bytes = production)    |
| -------------- | -------------------------------- |
| 20260926084812 | 83b50c4bce4bca0aaa99197ed5e1572c |
| 20260926085132 | b3311c0dcbf3476ad060043bda51dd9d |
| 20260926092115 | 0369cdc4172c737bfbf0828cceb339e7 |
| 20260926092142 | e1d8f1f4eaa595be37d8f46e65e33f32 |
| 20260926093159 | 3ac4d82db7451aa62a8e4a57bf56b9ee |
| 20260926131530 | 691a2a5a62d47afbf709d21ba91f2f72 |
| 20260926131554 | b714098e00c6e8ee153fb49ff94b27f4 |

PR #5337 (money-d) merged first and landed six of these files with an added
`-- @live-proof:` line each, so main no longer held the bytes production ran.
This PR restores the six to production's exact bytes (the md5 column above) and
exempts verified recordings from the `@live-proof` rule instead, because a
recording that has been edited is no longer a recording; its liveness is its
`schema_migrations` row, which `check-migrations-are-live.mjs` reads first.
`tests/a-ruling-make-good-and-a-bot-duplicate-move-through-one-journal-leg.law.test.ts`
now labels the 3f19bd70 closure it pins as history reopened by `131420`.

Recording is not endorsement. `check-definer-authorization`,
`check-money-trigger-declared` and `check-no-new-band-aids` all pass on these
files as ordinary migrations, so no `recorded-migrations.manifest.json` row was
needed. The money7 and money-d worktrees were not touched; identical files on a
later push from either will not conflict.

## Job 4 - the law

`tests/a-horse-is-never-the-reason-a-player-is-not-paid.law.test.ts` extends
10.5 to hand-written money SQL, which the TypeScript gate
`check-horses-are-players.mjs` never scanned. From 2026-09-26 on it refuses a
migration whose code reads `is_horse` and takes money from a player (wallet
debit, prize_reversal debit, negative 10.9 adjustment, clawback) or closes an
owed item without paying anyone; and any string it writes that reasons "every/all
recipients/entrants/players ... horses" to close, not pay or recover. Identification
and the fleet's input device keep passing, as does a payment that reads the flag
and then resolves the alerts it paid, and a sentence that names the reasoning to
void it. The three reversed files stay detected and are exempt only while their
reversals sit beside them.

Negative proof: a copy of 092115 planted as
`20260926235959_planted_regression_the_clawback_rule.sql` turned the suite red
(`reads is_horse and chip_balance = chip_balance - + 'debit','prize_reversal' + a
negative 10.9 adjustment`); removing it turned it green.

Known limit, stated so nobody over-trusts it: a file that pays one player and
closes another's obligation unpaid on horse status passes the code rule; the
text rule still catches the written reason.
