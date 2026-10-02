# The Xid Restorer Reads Xmax, And Reading 779 Is Acknowledged (2026-10-02)

## Context

At 15:05 UTC the chip supply meter read **-100,005.30** and tripped the kill
switch (verdict UNCONFIRMED). No chip was lost or created: a certification
club's 100,000.00 retirement (club `43731738-e631-4e27-8c9c-ffb9dbedc706`,
`chain_seq` 10378746/47/49) began at 14:04:56 and committed after the 14:05:00
reading, so its legs sat in window 778 and its balance change in reading 779.
The meter itself was fixed by PR #5838 (migration 20261002164500), which also
resolved the incidents. The kill switch only escalates; no payout freeze was
opened and no play or cashier action was blocked.

## What this adds

1. **`fn_ca_xid8` restores an epoch against the snapshot's `xmax`.** It took
   the reference from `xmin`, so every xid newer than the oldest running
   transaction came back as 18446744070211823064 ("the future") in epoch 0
   (measured live). The ledger replay (`fn_ca_leg_accounts_since_snapshot`)
   asks this helper whether the previous reading saw a leg; with an older
   transaction open across two readings, a seen leg was counted twice.
2. **Reading 779 is recorded under #5838's own model**: `late_burn`
   100,000.00, `unexplained` -5.30, the original kept in
   `ca_supply_snapshot_classifications` and the breach acknowledged in
   `ca_supply_breach_ack`. Before this, `fn_ca_unacknowledged_supply_breaches()`
   listed it (a permanent critical in `fn_audit_supply_breaches`) and the
   trailing-4h supply figure the production integrity audit gates on read
   -99,99x until 19:05.

Migration `20261002171027_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged`,
installed 17:10 UTC. Pinned by `tests/the-xid-restorer-reads-xmax.law.test.ts`
and executed on PostgreSQL 17 by `scripts/dev/test-xid-restorer-reads-xmax.sh`
(the old helper fails it).
