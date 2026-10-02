# Historical fee recognition refuses busy commission keys

The newly installed commission ordering in PR #5676 acquires a club key before a cash batch writes commissions. Historical fee operations already hold a strong commission-table lock. Waiting for the same club key from their insert trigger could form a cycle with a cash batch waiting for that table lock.

Within the existing admitted batch branch, acquire the exact positive commission rows' club keys in sorted order with a nonblocking try. A busy key raises the named `55000` admission refusal and rolls back the entire existing financial transaction. This deliberately avoids the payer's existing `55P03` retry branch, which retains outer locks. The ordinary recognition path, all amounts and recorded agreements, database guards, operation identity and five-second caller budget remain unchanged. No retry mechanism is added.

The maintained native PostgreSQL qualification exercises the actual upstream trigger and a concurrent key holder, checks refusal and rollback, and compares successful and ordinary-path financial results. Production installation and the remaining historical settlements require separate verification.
