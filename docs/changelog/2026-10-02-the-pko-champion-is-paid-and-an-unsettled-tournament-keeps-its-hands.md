# The PKO Champion Is Paid, and an Unsettled Tournament Keeps Its Hands

2026-10-02. Dan ruled on the two owed items still open: "pay it how you feel
it's necessary or don't, it doesn't matter as long as the bug or glitch is
done." The rule applied: pay exactly what the platform's own rules compute from
surviving rows, to the recipient those rules name; never invent a recipient or
an amount.

## PKO 3f19bd70 (Migration 20261002082429)

The event's own rule for an unclaimed bounty (`fn_finalize_bounty_pool`) pays
the remainder to the champion, and on 2026-09-07 it tried to pay exactly that
2,310.00 to `13133bc4` and was refused only because the escrow was empty. No
knockout was ever recorded, so the whole pool is unclaimed under that rule.

| Term                                                      | Amount       |
| --------------------------------------------------------- | ------------ |
| Advertised ladder share (1,306.65 / 4,455.00 of 3,500.00) | 1,026.55     |
| Unclaimed bounty pool                                     | 2,310.00     |
| Received on the inflated ladder                           | 1,306.65     |
| **Paid to the champion**                                  | **2,029.90** |

Places 2 to 10 keep their 674.90 ladder overpay (CLAUDE.md 10.9 rule 3), which
is why the house pays 674.90 more than the field-level 1,355.00. Nothing is left
unattributed. Deep Stack Society's treasury pays through one
`club_treasury -> player_wallet` settlement leg; the three alerts close with the
receipt.

## Week of 2026-09-14 Rakeback

Handled by the legacy discharge lane (`20261002025516`, operation `19aa02d6`) on
Dan's 2026-09-26 decision "Pay the measured 138,303.43". Not touched here.

## The Pruner (Migration 20261002082452)

- Cash: the pruner stopped deleting `rake_attributions` in `20260925143224`, and
  no function or cron job deletes any rakeback earning source. The migration
  asserts this before it changes anything.
- Tournaments: `sp_prune_hand_history` now keeps a tournament hand until its
  event is COMPLETED or CANCELLED, its bounty pool is fully paid and its escrow
  is closed. Before, only Spins waited for settlement.
