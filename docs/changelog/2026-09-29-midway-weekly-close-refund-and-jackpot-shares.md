# Midway's weekly close: a satellite seat refund and jackpot shares on the felt

Midway (union fade0000) could not close its book for 2026-09-21..28. Its union
P&L evidence refused twice, for two separate root causes, both fixed in the
evidence functions (no money was moved to make a number fit).

## 1. A satellite seat refunded by its target (20260929093858, PR #5599)

Ledger 63700b06 paid 50.00 from the target tournament's prize liability back to
a player's wallet under a refund entitlement for a seat won in a satellite. The
target never wrote a tournament credit receipt for a satellite seat, so
`fn_union_pnl_original_flow_evidence` called the flow unsupported. The refund
entitlement the payout is keyed by now proves it as a tournament return.

## 2. Jackpot shares credited to a seat (20260929110440)

After fix 1 the report refused with
`accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries`. For 35
players the week's cash flows plus closing seats minus opening seats exceeded
their hand results by exactly their mini Bad Beat Jackpot shares: 5,025.00 from
eight payouts (Club JAQK 3,550.00, a41434bb 1,475.00).

`fn_bbj_mini_payout` and `fn_bbj_payout` credit each seated recipient's stack in
their own transaction after the hand commits. The share was in no hand's
observed delta and in no original wallet flow, yet it left through the player's
ordinary cash-out. `fn_union_pnl_week_bbj_stack_awards` reads every share
credited to the felt (no wallet-credit key) in the week, on a hand of the
Union, attributed to the recipient's earning club in that hand's certified
evidence, and `fn_union_pnl_evidence_report` adds those shares to the hand
results. The cash reconciliation, `cash_player_pnl` and the tournament residual
are each correct again; a share whose recipient is not a participant of its
hand is dropped, so the reconciliation keeps refusing rather than guessing.
