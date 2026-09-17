# Tournament terminal lifecycle probes

**UNRUN from these repository paths. Protected execution is pending.** The prior scratch probes and the accounting owner's combined candidate replay each recorded 124 assertion executions. Those are historical local results, not a current protected execution or a live release receipt.

The accounting owner supplies the single full-schema fixture and the full atomic weekly candidate. After installing that candidate into a fresh disposable database, the protected plan loads these files in order:

1. `full-lifecycle-seed.sql`
2. `full-lifecycle-normal.sql`
3. `full-lifecycle-satellite.sql`
4. `full-lifecycle-earning.sql`
5. `full-lifecycle-deferred.sql`

There is no duplicate full schema or alternate financial implementation in this folder. The seed restores explicit synthetic users, memberships, agreement inputs, prior custody and standings, plus system custody-store declarations. Financial runtime operations execute with the captured enabled trigger states. Retired disabled triggers stay disabled. The protected combined runner owns source binding, database cleanup, durable logs and the exact execution receipt.

## Scenarios

- Normal sparse prize ladder: 4.00 seeded entry custody and a real 6.01 treasury overlay pay 10.01 as 3.34/3.34/3.33. The absent second-place award remains zero. Actual terminal authorization, escrow/table closure, receipt verification, lost-response resolution, deferred constraints and a final-receipt rollback are checked.
- Real request-bound registration and satellite delivery: a cash entry costs 90+10; a source satellite transfers its funded 100 into another 90+10 target entry. The target cancellation refunds 200, reverses both 10-chip fees and records two typed refunded sources without banked fees or commissions. Replay is idempotent; a late receipt fault restores every public relation.
- Recognized fees: those real entries reach a synthetic final hand. Actual terminal code pays 180, banks 20 and uses the shared commission writer for two 2.50 entitlements owed to the same agent. Sources bind to the exact bank journal; one club-week calculation request is queued. Retry and late-failure rollback cover money, commissions, stats, source recognition and requests.
- Missing historical terms: the same producers preserve exact funding manifests with an immutable missing-history reason. Terminal closure pays 180 and banks 20 while recording `banked_accrual_deferred`, `payable:false`, no guessed commissions, no recognized payable sources and no calculated-period claim. A late receipt failure and replay remain atomic.

`full-lifecycle-terminal-receipts.json` contains historical actual native outputs for the recognized/deferred 180-prize/20-fee scenarios. The server parser has corresponding versioned receipt examples. Receipt examples do not replace an execution receipt.

## Boundaries

The full probes use the actual registration, transfer, prize, fee, shared historical contract, commission, refund, source and terminal functions. Opening data and historical agreements are synthetic. Full positive Diamond, bounty, final-deal and original Spin draw/charge admission are outside these four scenarios; the bounded source fixture separately exercises Spin contributor allocation and source refunds.

The final shared commission function tolerates an absent retired agent display-counter row. Availability and authorization of the actual payer/payee wallet remain separate settlement requirements. Private historical sources with unknown coordinator stay unclassified pending evidence; current membership and rates cannot fill historical gaps. Full ACL/activation rollback qualification, weekly integration, financial model approval, deployment order and live acceptance remain owned by the accounting coordinator.
