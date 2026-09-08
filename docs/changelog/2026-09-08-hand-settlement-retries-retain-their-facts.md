# Hand settlement retries retain their accepted facts

The current shared fn_ca_commit_hand_settlement caller built its retry payload from engine-owned arrays and nested objects. A mutation while awaiting a lost response changed later attempts despite the comment promising identical requests. It also accepted any syntactically valid history UUID, even when the caller had supplied a different hand UUID.

The writer now takes one deep snapshot of the complete RPC payload before its first await. Every inline attempt uses those same accepted stacks, history, award units, lease identity and post-commit facts. A receipt must match the requested hand UUID when one was supplied, with case-insensitive UUID comparison. A mismatch cannot authorize projection or dependent completion.

Both defects were reproduced before editing: two new tests failed while the preceding 38 passed. The corrected suite passes 40 cases, including a positive receipt with an explicitly requested UUID, mutation during an ambiguous-response retry, and refusal of a wrong-hand receipt. Server TypeScript passes. Existing lease tests are checked separately. No database definition, alternate writer, watcher, queue or table lock was added.

Release uses the private repository's normal checks and scheduled Hetzner engine adoption. A merged PR alone does not prove the engine is serving this change. This closes two specific caller boundaries; broader hand crash recovery and historical corrections remain subject to the global audit.
