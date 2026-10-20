# Original ticket refunds retain their player ownership

The original-flow PNL reader classified 146 posted cancellation refunds
(2,920 chips, two tournaments) as unsupported. These entries came from
redeemed noncash satellite tickets. The existing return-receipt join requires
a chip-funded participant receipt, and the entitlement fallback admitted
only satellite seats and wallet charges.

Migration 20261020155211 adds one entitlement CASE arm to the original reader
and its bounded window clone. It proves the original direct satellite award,
payout, noncash escrow issue and reporting receipt, exact ticket admission
and registration, and the single full refund tranche tied to the original
transaction and refund ledger. Player, club, amounts, prize/bounty/fee splits,
source IDs and metadata must agree. Duplicate entitlements, tranches, issue
receipts, source-award wallet credits or replacement tickets fail closed.
Existing wallet, satellite-seat and cash branches remain unchanged.

The installer checks all four exact preimages and owner/ACL contracts,
limits its statement to 15 seconds and verifies all four exact postimages
before committing,
updates only the flow hash in the 40-source guard and the native advancement
function, and preserves bounded proving. The partial-window skip and final
freshness checks already bind the inventory generation; changing the original
flow and guard changes that generation. Old flow windows and full caches
cannot qualify, while unrelated earned-plan parts remain intact. No cache,
certificate, original receipt, wallet, ledger or settlement is rewritten.

The new branch supports original direct satellite-award tickets. Replacement
or other commercial ticket lineages still require their own original witness
and remain refused here; none occurs in this 146-refund population.

Native PostgreSQL 17 qualification executes the actual whole-week flow
consumer and bounded window reader against all 146 retained shaped cases:
old reader rejects all 146; candidate proves exact owners and 2,920 cashouts,
zero buyins and no extra rows. Sixteen identity, amount, source, state,
metadata and duplicate/disposition faults fail closed in both readers.
Installer rollback, exact metadata, source40 failure and replay are covered.
All fixture table digests remain unchanged. Empty unrelated cash/late/
restoration prerequisites are controls; this is not full production PNL proof.

The existing full weekly accounting parent invokes this focused qualification
unconditionally. Focused command:

```sh
ACCOUNTING_FIXTURE_PARENT=/Volumes/SmarterWork/agent-work/uf-01a15550 \
  python3 scripts/ci/test-ticket-refund-pnl-postgres.py
```

Verified: source reread, native PG17 passed, Python AST and parent shell syntax
passed, 991 source bindings passed, and application TypeScript passed.
Production installation and full refreshed PNL qualification remain separate.
