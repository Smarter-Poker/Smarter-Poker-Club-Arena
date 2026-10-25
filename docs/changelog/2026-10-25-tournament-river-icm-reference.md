# Independent tournament river utility reference

The new pure reference settles fold and call outcomes before computing the
declared `wta_hu_icm_chip_share_v1` objective. Both alternatives return absolute
expected prize share, rather than borrowing cash EV's zero fold baseline.
Nonterminal chip share is modeled ICM utility, not a realized prize award.

The initial family is heads-up NLH winner-take-all Spin on the river, with
complete original tournament provenance, explicit finalized canonical payout
terms, whole tournament chips, a matched pot, no ante, bounty, recovery or
satellite terms, and a call smaller than the hero's remaining stack. Unsupported
or contradictory inputs return an explicit unavailable reason. The declared
weighted range is bound to the original read frame; its model error remains
unknown even when enumeration is exact.

Every result remains unsigned, unqualified and ineligible for activation. The
owning Phase 14 delivery must integrate and independently qualify its catalog,
holdout, signing, controller and effect chain before selection. Existing cash
eligibility and authority are unchanged.

Validation: 24 focused tests cover actual payout-capture output through the
reference, conserving fold/win/loss/tie stacks, weighted ranges, original input
digests, malformed capture and unsupported-family refusals. No production
strategy has been activated by this change.
