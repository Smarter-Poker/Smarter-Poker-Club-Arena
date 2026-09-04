# Promo: the owner's door, and the one automatic payout that could never run

2026-09-03, on Dan's rulings 3 and 4.

> "PROMO FUNDS ARE PAID DIRECTLY TO CLUBS, OR PLAYERS DIRECTLY FROM THE UNION
> OWNER (OR CLUB OWNERS WITHOUT ANY UNION AFFILIATION)... FOR NOW, PROMO'S ARE
> DISBURSED MANUALLY BY OWNERS, AND LEADER BOARDS IS THE ONLY PROMO THAT GETS
> PAID OUT BY THE PROMO WALLET. MAKE SURE THATS BUILT IN AND FULLY WIRED UP AND
> WORKING."
>
> "PROMO DOESNT OWE ANYONE ANYTHING EVER... PROMO CHIPS ARE TREATED EXACTLY LIKE
> REGULAR CHIPS ALWAYS... THEY ARE RAKED OUT OF THE POTS, SO THEY ARE THE SAME
> CHIPS... THE WHOLE POINT IS TO GIVE IT BACK TO THE PLAYERS TO SPEND RIGHT BACK
> IN THE UNION OR CLUB."

## What the rulings settle

Ruling 4 closes three of the open questions from this morning's promo review:
promo is not a liability, it needs no playthrough, and it is not newly minted
money - it is rake, already inside the clubs and unions, on its way back to the
players. So `fn_promo_wallet_send` and `redeem_promo_to_chips` crediting a
cashable balance is **correct behaviour**, not the bug that review called it.
What was missing was a way for an owner to hand it out at all.

## 1. fn_promo_disburse - the owner's door

    union owner  ->  a member club              (union promo_wallet -> club treasury)
    union owner  ->  a player in a member club  (union promo_wallet -> player chips)
    club owner   ->  a player in that club      (club promo_balance -> player chips)

A club inside a union cannot disburse; its union owner does. Everything lands as
**ordinary chips** - `chip_treasury` or `chip_balance`, never a `promo_balance`,
never a playthrough lock. Each disbursement declares its counterparty, is keyed
on an op id, refuses a short float, and leaves a `chip_transactions` receipt
naming the owner who authorised it.

### Rolled-back probe against production

| step                                           | result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| union owner -> Club JAQK, 250.00               | union promo 40,140.84 -> 39,890.84, JAQK treasury +250.00 |
| union owner -> a JAQK player, 75.50            | union promo -> 39,815.34, player chips +75.50             |
| the same op id again                           | `replayed: true`, same transaction, nothing moved         |
| 999,999,999                                    | refused: Insufficient Promo Balance                       |
| Club JAQK (in a union) as source               | refused: its union owner disburses                        |
| a player calling as themselves                 | refused: only the union owner                             |
| Deep Stack owner -> a Deep Stack player, 40.25 | club promo 6,357.35 -> 6,317.10, player +40.25            |

Deltas: union promo -325.50, JAQK treasury +250.00, player +75.50, Deep Stack
promo -40.25, player +40.25. **Conservation sum 0.00.** Ledger rows, one per
disbursement, none in suspense:

    promo  union_wallet -> club_treasury  250.00
    promo  union_wallet -> player_wallet   75.50
    promo  promo_wallet -> player_wallet   40.25

The first version of this function declared its legs as a new category,
`promo_disbursement`, and `fn_ca_declare_ledger` refused it before a chip moved -
"not in the ledger vocabulary". The guard was right: the ledger already has a
word for this money, `promo`, and widening the vocabulary would have bought
nothing but an exclusive lock on `chip_ledger` during live play. The human-facing
receipt is still `transaction_type = 'promo_disbursement'`.

## 2. The leaderboard could never have paid a winner

Leaderboards are the one automatic promo payout, and the plumbing looked right:
`leaderboard-payout-waterfall-daily` runs `fn_settle_due_leaderboards` at 00:20
UTC daily, and `fn_payout_leaderboard` spends the seed, then the promo float,
then the operating wallet.

A rolled-back probe on the real August monthly round - published programme, real
qualified players, real prizes - got as far as paying the first winner and died:

    new row for relation "wallet_transactions" violates check constraint
    "wallet_transactions_category_check"

The winners are credited with the category `leaderboard_payout`. `chip_ledger`
has known that word since the leaderboard work landed; `wallet_transactions`
never learned it. So the batch row was written, the funding wallets were
debited, and the first winner's credit aborted the whole transaction. **Every**
leaderboard round with a winner would have failed this way - club-funded or
union-funded - and the daily settler would have filed it in
`leaderboard_payout_failures` and moved on. Zero leaderboard batches have ever
been paid, which is consistent with that.

Fixed by adding the missing word, `NOT VALID` so the swap is a catalogue change
rather than a scan of every wallet transaction ever written, under a 5s
`lock_timeout` so the brief exclusive lock cannot queue behind live play.

Separately, the union-funded branch of `fn_payout_leaderboard` declared no
ledger counterparty where the club-funded branch did, so a union-funded round
would have debited `promo_wallet` and `chip_balance` straight into
`settlement_suspense`, and the winners' credits after it would have followed.
Fixed before it ever carried money.

### Rolled-back probes after both fixes

Union-funded, August monthly, three winners:

    result: total_paid 175.00, promo_funded 175.00, overlay 0, winners 3
    union promo 40,140.84 -> 39,965.84
    leaderboard_payout  union_wallet      -> leaderboard_round  175.00
    leaderboard_payout  leaderboard_round -> player_wallet      100.00 / 50.00 / 25.00

Club-funded, same round:

    result: total_paid 175.00, seed_funded 175.00, winners 3
    leaderboard_payout  leaderboard_round -> player_wallet      100.00 / 50.00 / 25.00
    leaderboard_payout  leaderboard_round -> promo_wallet       325.00   (the unused seed released to the club promo float)

Both legs declared, nothing in suspense, the intermediary account nets to zero.

Deep Stack Society's own published programme is club-funded and takes effect for
the weekly round beginning 2026-09-06, so the first real leaderboard payout is
the settler's run on 2026-09-13. (Its one recorded failure, August's monthly, is
correct: that programme's `monthly_effective_from` is 2026-09-01, so no paid
programme applied to an August round.)

## Files

- `supabase/migrations/20260903224815_promo_is_disbursed_by_the_owner_and_it_lands_as_ordinary_chips.sql`
- `supabase/migrations/20260903225020_the_promo_disbursement_speaks_the_ledgers_own_word_for_promo.sql`
- `supabase/migrations/20260903225121_the_union_funded_leaderboard_names_its_counterparty_too.sql`
- `supabase/migrations/20260903225331_a_leaderboard_win_is_a_word_the_wallet_knows.sql`
- `tests/promo-is-disbursed-by-the-owner.law.test.ts`

All applied to production and mirrored byte-exact.

## Still to do on promo

`transfer_promo_club_to_agent` still credits a member's `promo_balance` with the
comment "promo is non-cashable", and `distribute_promo_chips` reads
`agents.promo_balance`, a column no sweep maintains. Neither has ever moved a
chip (zero rows, ever). Under ruling 4B they are wrong rather than merely
unused, so they belong on the Phase 3 deletion list with the rest of the legacy
promo routes rather than being rewritten now.
