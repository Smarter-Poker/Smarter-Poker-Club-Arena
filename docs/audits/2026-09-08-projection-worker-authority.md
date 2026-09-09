# Hand projection worker owns its execution context

The process-wide worker can be woken directly by a committed tournament hand.
If its earlier drain has finished, beginDrain previously ran inside that caller's
AsyncLocalStorage authority. A regression test using the actual authority header
builder showed both the global outbox read and another hand's projection request
stamped tournament-manager, rather than service. This is a proven request-context
defect; it is not a claim that every observed production delay came from it.

Startup now captures a private zero-argument worker callback. Wakes only ask that
worker to consume its existing durable outbox; they cannot supply a mutation or
request body. Starting a worker from inside tournament authority is rejected.
The owner callback is discarded on stop, and the existing lifecycle, ordered
claims, idempotent database receipts, retry ownership and concurrency remain.
No authority header can be supplied by the wake caller and no general context
escape is exported. The direct post-commit hand function keeps its own caller
context and is unchanged.

Tests cover the real authority headers, caller restoration, refusal to create a
worker inside a manager, and a real retry timer preserving worker ownership.
The first regression failed on the unchanged implementation with both requests
carrying tournament-manager. No production financial mutations or schema changes
were used for this verification.
