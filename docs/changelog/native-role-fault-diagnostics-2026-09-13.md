# Retain bounded native role fault diagnostics

PR4531 native job103783432437 passed the repaired Vault launcher and service bootstrap, then failed the actual role fault matrix. The child emitted its failed proof, but the controller retained only the generic fixture stage. That discarded the exact case and prevented diagnosis from the uploaded receipt.

The role runner now retains the first failed operation using an enumerated step and error type, plus a five-character SQLSTATE when present. Later cleanup errors cannot overwrite that first observation. The controller validates a bounded, duplicate-free failed record and its completed case prefix, then retains only the failed case, operation, SQLSTATE, completed count, and client-closure fact. It never copies error messages, SQL, stacks, passwords, service logs, or the underlying catalog.

The success schema still requires all36 actual refusal/rollback cases; a diagnostic cannot satisfy it. No expected refusal, SQL input, rollback, deadline, cleanup obligation, or production configuration changes. Native failure diagnosis and qualification remain open until a fresh CI run executes these changes.

Validation results are recorded in the source integration receipt. A new test executes the real controller with a controlled failed child record and confirms the final receipt preserves the bounded diagnostic and cleanup. The same test fails on the old controller because the diagnostic is absent.
