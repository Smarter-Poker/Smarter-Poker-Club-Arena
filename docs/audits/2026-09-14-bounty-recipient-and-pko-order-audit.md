# Bounty recipient and PKO ordering audit

Status: open. Observations are from September 14, 2026; this is not full tournament certification.

## Recorded payments and evidence

The completed-event cohort runs from September 7 at 00:00 UTC through September 14 at 12:17:50.101640 UTC: 462 MTT/satellite/XMTT events with max_players greater than two, excluding spin/sng variants. No event in this cohort uses Diamond funding.

Cash obligations and posted prize-ledger amounts match for all 2,570 tournament/player groups, totaling 249,162.30. Bounty obligations owed, paid and posted match for all 1,469 groups, totaling 27,886.00. All 2,277 recorded knockout bounty obligations have complete canonical markers, exact hand identity and completed hand-commit evidence. These comparisons cannot establish the completeness of obligations that were never recorded.

Thirty-seven older champion recipients have 1,598.04 more bounty-ledger value than reconstructed raw markers. All lack modern completion receipts and ended September 7-8. Their financial obligations match their ledger. This is a historical completion-evidence gap, not demonstrated nonpayment.

There are 147 eliminated candidates across 25 completed bounty events without an exact bounty obligation or any collection marker for that eliminated player/event. Of these:

- 33 have an exact `exact_pot_claimants_not_found` alert and remain unattributable by the current exact-pot reader.
- 43 have an exact `pko_order_already_advanced` alert and have exact claimants available.
- 71 have no matching attribution alert. Sixty-four share the September 10 16:04:13.496542 UTC cleanup timestamp; seven need further classification. Forty-four of these 71 are currently attributable, while 27 are not.

The historical cleanup migration `20260910160413_a_finished_event_holds_no_pending_bust.sql` treated pool conservation as sufficient financial closure. Its statement that a knocker receives a share through the champion is not proof of payment to that knocker. Applied migration bytes are preserved; this audit records the unresolved recipient question. No clawback, compensation or historical payment has been performed.

## Confirmed ordering defects

The current claim and collection authorities impose a tournament-wide deal-number watermark. Across separate tables, deal order and hand completion order can differ. Observed blocked examples committed after a higher-numbered hand had already settled, including candidate `08192d3c-88dd-4c85-9bf5-aea1b11ba9f7`: hand 9623574 committed at September 11 15:24:29.118374 UTC, while a higher-numbered payout settled at 15:24:24.441601 UTC. The exact current reader identifies the knocker. A global numeric cutoff alone does not prove a dependent head transfer was missed.

R34 repairs the independent settled-replay defect: `fn_collect_bounty` previously rejected already-paid receipts before reaching marker verification. Read-only preflight found 1,129 affected complete receipts. See the September 14 settled-bounty-replay changelog for native, source and installation evidence.

The larger cross-table order repair remains open. Its acceptance must account for each eliminated player's incoming head transfers, exact rebuy generation, same-hand predecessor graph, committed but not yet claimed candidates, head snapshots and later elimination of a claimant. Removing the global cutoff without those proofs could misallocate head value. Restoring a finishing place must not require guessing its bounty recipient, and allowing play to finish must not silently certify an unknown recipient as paid.

## Industry comparison

PokerStars assigns a bounty to the winner of the pot containing the eliminated player's final chips. In hi/lo games it assigns it to the high hand, splitting among tied high winners; its odd-cent policy follows table position. [PokerStars tournament rules, section 9](https://www.pokerstars.com/poker/tournaments/rules/).

GGPoker describes PKO payments as half immediate cash to the knocker and half added to that player's head. [GGPoker tournament types](https://legal.ggpoker.com/tournaments/tournament-types/).

These sources support payment to the entitled knocker; they do not establish that assigning an unattributed bounty to the eventual champion satisfies that entitlement. The current Club Arena exact claimant reader considers every distinct recipient of the relevant pot, including both hi/lo halves, while the marker uses user-id order for remainder assignment. Those are explicit comparison gaps requiring a published, versioned policy and actual format tests; they must not be presented as universal industry parity or changed retroactively without reviewing existing contracts.
