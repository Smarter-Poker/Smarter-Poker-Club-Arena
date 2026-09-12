# Reconcile five already-installed database audit records

Preserve the exact production-recorded statements for versions 20260912044158, 20260912044609, 20260912044823, 20260912050321 and 20260912050353, alongside their original PR 4392 filenames and hashes. Generate the scoped function and pending-addons-column manifest from the current production catalog.

Validation matched all five full recorded statements, all five function bodies, their owners and complete ACLs, and the column definition through read-only queries. The SQL is archived as installation evidence, outside the forward-migration directory: no reapplication, schedule change, money movement or tournament engine edit occurs in this PR. Product and funded-route certification remain separate.
