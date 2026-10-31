# Verified player portraits follow live record updates

The member page read a fresh authorized record after `record_changed` and subscription recovery, but kept the entire old identity object. Its portrait reads `identity.avatar_url` directly, so a successful source event and fresh RPC response could leave the visible portrait stale. This also blocked the existing published private-record failover proof's cosmetic readback.

Within the existing account, club, member, range, explicit-read generation and denial fences, apply only the returned portrait URL to the permission-reconciled identity. Preserve alias, editable nickname/remark drafts, wallet reconciliation and other workspace state. An authoritative null removes the old image. Applying the portrait after permission reconciliation avoids restoring identity fields scrubbed by an access withdrawal.

Mounted regressions fail against the prior source for event delivery, subscription recovery and image removal, and pass after the repair. Controls retain a newer range's portrait and refuse another member's response. Protected merge, client publication and the real published gateway/engine cosmetic proof remain separate delivery requirements. This changes no transport flag, database, engine, timer or financial state.
