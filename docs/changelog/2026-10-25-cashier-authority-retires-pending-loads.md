# A revoked Cashier role retires pending directory reads

A role-change event retired visible money controls, but a membership or roster read already in flight could later restore its older role and announce Balances Synchronized. The server still checked every transaction; the browser's authority generation was stale.

Explicit role invalidation now retires the directory generation as well as the transfer generation. The membership response checks its generation before publishing the authority snapshot or starting a roster read. Both discrete role events and membership realtime invalidation use the same retirement behavior. The page leaves loading, explains that access changed, and offers its existing Retry control to verify current server authority.

Self-funding and management claims also recheck their original account, club and authority generation after the durable recovery reservation, before submitting money. They retain the original recovery record when the scope changes and retire obsolete completion messages, using the same scope check as the existing ordinary claim path.

Four mounted regressions deliver a registered role-change callback while membership, roster or either wallet reservation is pending. All reproduce the stale continuation before its repair. Directory cases then retry against the current player role and prove synchronization can recover; wallet cases prove no money RPC is submitted and the original journal remains. Existing balance-only realtime updates and retained financial operation identities remain covered by the Cashier launch audit.
