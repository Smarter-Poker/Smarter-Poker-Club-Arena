# One private member invalidation per topic and source transaction

The member record publisher sent repeated `record_changed` messages for the same member/upline topic within one committed transaction. Membership removal also sent directly outside the normal publisher. The member record consumers ignore payloads and re-read committed records, so these duplicate frames repeat the same invalidation.

Both existing send sites now use one private helper that records a topic only after its successful send. The record lives in a transaction-local setting, so transaction and savepoint rollback undo both message and memo. A later transaction can send again. The existing roster dedup, recipients, permissions, horse participation, financial writes and all actual source changes remain intact. There is no timer, scheduled job or transport cutover.

The existing native PostgreSQL member-record qualification includes a real duplicate regression before installation, then checks shared uplines, separate child topics, direct membership removal, committed source changes, new transactions, transaction/savepoint rollback and private helper ACLs. Source function preimages are pinned to the observed production definitions; installation refuses drift or replay.

This reduces duplicate sends inside a transaction. It does not claim to remove the larger across-transaction message volume or replace Supabase Realtime. Production installation, message-rate measurement and billing savings remain separately verified by the owning task.
