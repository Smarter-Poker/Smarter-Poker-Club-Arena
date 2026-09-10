# A place is not a bounty

2026-09-10

The one defect that kept ten tournaments frozen, and the reason the elimination
drain stalled at 50 players after the engine restart.

## What it was

`fn_claim_bounty_legacy_candidate_20260907` does two jobs in one call. It
**records the elimination** - status, finishing place, prize, seat closed - and
it **settles the bounty**. Every gate in it returns `ok:false` for the whole
call.

So a bounty that could not be settled meant a player who provably busted was
never given a finishing place. An unranked player keeps the event from
finishing. The prize escrow, which has nothing to do with bounties, was paid to
nobody.

## Measured, 14:33 UTC

Across the ten stalled events, 62 knockout candidates still `pending`:

| blocker                           | candidates |
| --------------------------------- | ---------- |
| behind a PKO settlement watermark | 33         |
| no exact pot claimant             | 33         |
| neither (just not swept yet)      | 2          |

(some are both). **Zero** had a live seat. **Zero** had chips again. **Zero** of
their hands had been pruned from `hand_history`. Every one of them provably
busted, the oldest 44.7 hours earlier, with **3,600.00** of escrow behind them.

Every stalled event was a bounty event - PKO, mystery, or plain bounty.
Non-bounty events never stalled, because the plain elimination door has no
claimant requirement. That is the tell.

## Both rules were correct - for a bounty

- `fn_exact_tournament_knockout_claimants` returns NULL when it cannot name the
  exact winner of the last pot the busted player was eligible for. It is right
  to refuse to guess; paying the wrong knocker is worse than paying late.
- The PKO watermark refuses an out-of-order bounty and cannot be rewound
  without letting already-settled bounties settle again.

Neither is a statement about whether a player busted. **A finishing place
belongs to the player and is knowable from the bust order; a bounty belongs to
a knocker and needs exact evidence.** Conflating them let an unpayable 8.00 head
freeze a 600.00 event.

## The change

`20260910145833_a_place_is_not_a_bounty` - eleven asserted substitutions on the
live definition, each anchor required to appear exactly once.

The three bounty-settlement refusals (`exact_pot_claimants_not_found`,
`pko_order_already_advanced`, `exact_head_value_not_found`) stop returning. They
set `v_bounty_blocked`; the elimination is recorded and the place assigned
exactly as before; **no obligation row is written**.

### Why writing no obligation is right, verified against the live consumers

- `fn_tournament_has_unsettled_bounties` only looks at obligations that
  **exist** (`pending`, or `settled` without a complete marker) and at
  `tournament_bounty_awards`. Nothing anywhere requires one obligation per
  elimination, so the event can finish.
- The head therefore stays in `tournaments.bounty_pool` unpaid - which is
  exactly what `fn_finalize_bounty_pool` already resolves at completion as
  **residual**, with its own completion receipt. An uncollected head already had
  a designed home; this routes these there instead of freezing the event.
- `fn_complete_tournament_terminal` asserts paid <= pool and that
  `bounty_pool_paid` matches the wallet evidence. It does **not** require
  paid = pool.
- `tournament_bounty_obligations.state` is CHECKed to `('pending','settled')`.
  Inventing a third state would have meant touching that constraint and every
  consumer of it. Not writing the row touches none of them.

### What does not change

Every **evidence** gate still refuses: `atomic_knockout_evidence_required`,
`accepted_zero_settlement_not_found`, `exact_knockout_history_not_found`, the
identity conflicts, `player_has_chips`, `status_not_claimable`. Those answer
"did this bust happen", and without them a player could be placed on no proof.
The CAS on the elimination UPDATE still raises `serialization_failure`. The two
PKO predecessor gates and the caller-supplied claimant checks still apply
whenever a bounty **is** being settled - they are skipped only when there is no
payment to order. Nobody is paid a bounty they did not earn.

## The record

Each unattributed head writes one `financial_alerts` row naming the tournament,
the player, the hand, the place, the head value and the reason. Severity
`warning`, so `fn_ca_financial_alert_to_incident` - which promotes only
`critical` - does not turn it into a board item per bust. A listed fact, not an
alarm.

## Result

Live within seconds of applying, during the 14:55 freeze: the first busts were
recorded and the first heads listed before the platform had even thawed.

`tests/a-place-is-not-a-bounty.law.test.ts` pins the rule, and pins every
evidence gate by name so the next change cannot quietly relax one.
