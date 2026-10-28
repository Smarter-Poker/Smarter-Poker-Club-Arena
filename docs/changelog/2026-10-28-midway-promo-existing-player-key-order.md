# Midway promo takes the existing player keys before wallet rows

The existing Monday promo took club-member/profile locks in club order. Current
hand projection updates profiles in user order, and the current cash batch keeps
profile locks across several hands in caller order. Native PostgreSQL17 reproduced
a deadlock with each actual critical path, then passed with the core-only repair.
The actual opposing backend from the09:10/09:15 incident was not retained; this
qualification does not identify it retrospectively.

The promo now takes only its candidate eligible users' existing
`player-stats-user` advisory keys in user order before its original union bank
lock. Its fresh post-bank eligibility snapshot first checks that every eligible
user is covered by those keys. An expansion raises40001 before any
club/member/profile row lock or promo run/ledger write. It never pays a stale
subset. Shrink and an additional wallet belonging to an already covered user use
the fresh cohort. Existing business serialization handling remains the caller;
there is no new retry, job or timer.

Only clubs in that covered fresh cohort receive the existing SHARE locks first,
then member/profile rows retain their member-before-profile order and sort by
user,club. Final allocation still sorts club,user, preserving exact cent
remainders. Budget, eligibility predicates, original bank validation,
idempotency/receipt handling, disbursement door, authorization and freeze guard
are unchanged. The already completed promo returns its original receipt before
any new key/bank/row locking. No production payment is part of this migration.

The required existing native promo runner installs the exact migration and tests
rollback/replay, source/metadata/ACL drift, real money/ledger effects,2003 wallets,
cent allocation and repeated payment. A separate copy of that local financial
fixture tests fresh-cohort refusal including a new horse holding its profile
while waiting for a covered user's key, shrink/overlap, the real club disburser,
current projector/profile trigger and current multi-hand batch/process/apply
chain. Original source fails the demonstrated cycles; repaired source passes.
Disjoint users in the same clubs continue through the batch in reverse club
hand order.

The complementary lock harness controls unrelated launch/private-fact readers
and materializes typed accrual contributor receipts. It retains the actual
batch, cash-source handler, apply-stats and profile-trigger bodies and actual
projector body. The full financial promo/disburser/ledger harness remains real.
The controlled accrual boundary is not qualification of the complete cash
commission pipeline. Current producer/trigger source was audited from the
catalog-only0120 capture: commission/agent counter writes do not take bank
FOR UPDATE or member/profile locks; its compatible retired-club KEY SHARE is
retained by the controlled producer. Trigger predicates exclude balance-credit
and agreement-change paths for these counter-only updates.

0057 was not an exhaustive discovery of all member writers. Trusted raw
administrative identity changes are not asserted immutable or universally
covered. This change adds no blanket profile locks or altered retention,
source65/GEN, accounting budgets, scheduling or payer behavior.
