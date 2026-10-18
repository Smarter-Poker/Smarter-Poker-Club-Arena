# Member private-channel authorization accepts the provider probe

Authenticated live verification rejected the member-record subscription while the page RPC worked. Supabase checks private-channel permissions using a temporary messages row with topic and extension, without the private delivery flag. Requiring private IS TRUE in the member policy therefore denied every join.

Keep the exact topic, authenticated role, existing member-access helper and private sender/client configuration. Remove only the delivery-column predicate from join authorization. No client write/broadcast policy is granted.

The existing native fixture now reproduces denial with a real authenticated RLS SELECT over a provider-shaped probe, then verifies authorized access after this migration, unrelated-viewer refusal and wrong-topic refusal.

Provider implementation: https://github.com/supabase/realtime/blob/main/lib/realtime/tenants/authorization.ex (read_policies_with_transaction inserts Message.changeset with topic/extension).

## Initialization spill recovery

The optimized initializer still reached its unchanged eight-minute deadline. Durable history/state confirmed a complete rollback. Provider logs identify the INSERT, with ten temporary files totaling 8,335,542,797 bytes. Production settings report 16 GiB shared buffers and 48 GiB effective cache. Increase only this transaction's work memory from 64 to 512 MB so the 7.6-million-row rake lookup hash fits the existing hash-memory multiplier of two, rather than writing and rereading the much larger hand stream. Avoid invoking the mixed-history subquery for unmatched funding keys. Keep all deadlines, memory defaults, financial data and concurrency safeguards unchanged.
