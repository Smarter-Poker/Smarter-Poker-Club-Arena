# 2026-10-05 - The champion's own bounty head is labelled as his own

Migration `20261005184659_the_champion_s_own_bounty_head_is_labelled_as_his_own.sql`
(NOT APPLIED by the authoring agent).

`fn_finalize_bounty_pool` paid the champion the end-of-event bounty residual under the
wallet label "Unclaimed bounty pool awarded to champion". The champion cannot be
knocked out, so that residual always contains his own head, and on an ordinary event
it is nothing else. The label is now "Tournament champion: own bounty head returned"
when the residual is no more than his head, "... with unclaimed bounty pool" when it
is more, and the old wording only when the row holds no head. Label only: amount,
obligation and ledger unchanged. Asserted substitution pinned to live md5
`96417e3cbe35661ced11437cbbb18613`. Test: `tests/unit/championOwnBountyHeadLabel.test.ts`.
