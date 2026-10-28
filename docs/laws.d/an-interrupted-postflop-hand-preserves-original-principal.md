# tests/an-interrupted-postflop-hand-preserves-original-principal.law.test.ts

An uncommitted interrupted NLH/PLO4/PLO5/PLO6 postflop tournament hand may receive an explicit `misdeal_voided` disposition only when the original principals still equal their last accepted and fully postcommitted boundary. The snapshot must conserve every original investment; exact original seat identity and join time must match the prior accepted stack request. Later chairs remain outside the old hand and unchanged. Unknown proof refuses the whole generation.

The existing preflop-only branch and all prior outcomes remain byte-identical. A void never fabricates an accepted result, winner, `never_started` state, refund, chip movement or hand history. Existing immutable per-hand receipts and late-write fences remain authoritative. The same existing native F06 runner enforces mixed-generation causality, transaction rollback, identity, actor/freeze checks and concurrent idempotency.
