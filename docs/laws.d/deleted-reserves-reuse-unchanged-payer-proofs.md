# tests/deleted-reserves-reuse-unchanged-payer-proofs.law.test.ts

Only unchanged output of the original certificate payer validator may be reused within its transaction. Every reserve call retains fresh pending admission, NOWAIT locks, latest identity/payout guards. All certificate/payer row changes invalidate reuse; original all-human and horse liabilities remain reserved. No persistent cache, caller-provided authority or new financial path is allowed.
