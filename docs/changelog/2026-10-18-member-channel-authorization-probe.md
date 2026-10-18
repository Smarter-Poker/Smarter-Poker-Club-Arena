# Member private-channel authorization accepts the provider probe

Authenticated live verification rejected the member-record subscription while the page RPC worked. Supabase checks private-channel permissions using a temporary messages row with topic and extension, without the private delivery flag. Requiring private IS TRUE in the member policy therefore denied every join.

Keep the exact topic, authenticated role, existing member-access helper and private sender/client configuration. Remove only the delivery-column predicate from join authorization. No client write/broadcast policy is granted.

The existing native fixture now reproduces denial with a real authenticated RLS SELECT over a provider-shaped probe, then verifies authorized access after this migration, unrelated-viewer refusal and wrong-topic refusal.

Provider implementation: https://github.com/supabase/realtime/blob/main/lib/realtime/tenants/authorization.ex (read_policies_with_transaction inserts Message.changeset with topic/extension).
