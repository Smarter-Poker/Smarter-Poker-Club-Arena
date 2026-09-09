# Funded satellite unregister cash correction

Eligible satellite unregistration currently issues a ticket despite the approved cash rule. The prepared migration routes the exact funded entitlement through the existing refund payer, returns its value to the original club wallet, reverses the original fee recipient, and records the cash component in the immutable receipt. Already-issued tickets and historical receipts retain their committed outcome; no backpay or balance repair is included.

The client compatibility change is merged in PR #4029 and was independently verified on both Club Arena URLs at build 65931a248c4f35b15e6dbd50aedd3b2f8d08a576. This database patch changes three existing owner-only helpers without adding grants or changing start eligibility. The still-unapplied actual-start migration carries the same cash correction so its later installation cannot restore ticket issuance.

Verification: eight isolated PostgreSQL 17 scenario groups passed using captured production function definitions and synthetic funded records. They cover exact provenance, ordinary wallet entries, redeemed tickets, historical replay, overlapping requests, insufficient escrow, late receipt rollback and migration compatibility. Eight affected source guard tests passed. The fixture omits unrelated triggers, foreign keys and full admission; it does not certify all Phase 3 controls.

Deployment status: production database application was rejected by automatic approval review because repository publishing/deployment authorization was not explicit authorization for this financial database mutation. No production SQL was applied and no workaround was attempted. The reviewed migration remains pending explicit production database authorization.
