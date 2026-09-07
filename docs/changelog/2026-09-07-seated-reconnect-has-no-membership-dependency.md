# A Seated Reconnect Has No Membership Dependency

A current seat already grants table-view access under the existing policy,
even when membership changes. The implementation nevertheless waited for a
membership read and rejected the seated player if that unrelated read failed.
This is an application dependency defect, not evidence of a Supabase outage.

Read the requested table and authenticated player's current seat concurrently.
After validating both, return the existing seated verdict without querying
membership. Observers still require active or approved club membership and
must pass the observer restriction. Table and seat lookup errors fail closed.
The blacklist and IP gates remain independent and unchanged.

The shared authorizer is called by HTTP state and both WebSocket transports.
A seated reconnect's authorization now takes one parallel database round trip
instead of two sequential rounds and performs two reads instead of three.
No verdict cache, client assertion, or database migration was introduced.

Regression test: valid seat plus unavailable membership previously returned
check_failed; it now grants seated access without querying membership.
Missing-table and failed-seat cases still refuse, alongside existing observer
and outsider tests. Live latency improvement requires deployment verification.
