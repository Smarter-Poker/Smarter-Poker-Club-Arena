# Read-only MTT proofs keep authority

Breakfast Turbo remained registering after199hands because its played-launch proof request failed before execution. PostgREST runs STABLE POST functions in a read-only transaction, but our request guard treated every POST as mutable and tried a forbidden row lock.

The guard now reads the actual transaction access mode. It still verifies the exact current manager generation on read-only requests; mutable requests keep the takeover-blocking lock. The proof, grants, lease window and all financial behavior stay unchanged.

The PostgreSQL17 probe reproduces the original25006 failure with the captured actual hook, then passes18groups covering the corrected read-only path, mutation refusal, wrong/stale generations, takeover exclusion, heartbeat renewal and existing launch recovery/rollback. Transaction-mode selection and auth.role are explicit fixture inputs; real HTTP recovery remains a separate served verification.

Reference: [PostgREST transaction access modes](https://docs.postgrest.org/en/stable/references/transactions.html).
