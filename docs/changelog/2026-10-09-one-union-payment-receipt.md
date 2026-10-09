# One Union Payment Receipt And Recipient-Correct Invoice Links

A lost response from Record Payment previously allowed the same payment to be recorded twice. The canonical `fn_union_record_presettlement` now requires one operation UUID, serializes its first execution, and returns the original payment and invoice on an exact retry. It rejects changed scope, actor, amount, method, reference or note for a reused identity; finite positive whole-cent amounts are required. Anonymous or missing-identity browser requests cannot use service authority. Existing owner/admin checks and settlement application remain in force.

The successful record creates one linked, paid `transaction_receipt` in the existing invoice system. Its existing insert trigger delivers the Messenger invoice and notifications atomically with the recorded payment. The receipt explicitly records an external payment credit, without claiming a chip transfer or new payment due. Operation and issued receipt fields are immutable; the existing settlement application can still attach `applied_settlement_id`. Historical rows are not rewritten. Production contained no presettlement rows at the scoped readback, so no financial correction is required.

Ordinary invoice deliveries now stamp each recipient's own conversation before inserting the message. Message-page and search projections normalize legacy invoice metadata from the trusted physical conversation. Immutable stored messages remain untouched; current authorization, audience checks and private weekly-detail filtering are preserved.

## Rollout

Install the single qualified migration before publishing the matching Record Payment client. The seven-argument canonical RPC replaces its six-argument signature and gives the final `p_operation_id` argument a NULL default. Old clients and the old `ca_union_record_presettlement` wrapper fail visibly with `operation_id_required`, without recording a payment. There is no weak legacy payer. New clients retain their operation identity across an unknown response and require a matching receipt before clearing it.

The receipt contains `success`, `presettlement_id`, `operation_id`, `union_id`, `club_id`, `amount`, `received_at`, `invoice_id` and `duplicate`. A replay preserves the original date and invoice. A failed invoice delivery rolls back the entire payment transaction. The existing scoped PostgreSQL workflow exercises the captured production definitions and the candidate migration with native roles, concurrency, rollback and immutable history.

Source, qualification, protected merge, migration installation and publication remain separate delivery states; this source note does not claim live installation.
