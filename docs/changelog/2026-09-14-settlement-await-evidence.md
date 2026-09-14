# Blocked hands identify the operation they are awaiting

A cash hand had a complete canonical receipt while its engine remained behind a pending settlement barrier. The health endpoint reported its age, but the dealing-loop phase did not identify the pending settlement operation.

Blocked-hand health now includes bounded observations of the actual settlement promises: hand completion, post-hand work, named steps, the hand-history write and post-commit obligations. The hand-history observation distinguishes an outstanding RPC, a returned response, an accepted receipt and retry backoff. Every observation carries the captured hand and generation. It contains no holdings, request body, credentials or error text.

The observer returns the original promise. It cannot cancel work, release a barrier, clear a lease or acknowledge a financial result. Observations disappear only when their own operation settles. Tests cover pending and rejected operations, overlapping generations, bounded storage, immutable snapshots, the real hand-history caller and failing diagnostic callbacks.

This supplies missing causal evidence. The underlying production stall remains open until the captured operation is investigated and its fix is independently qualified.
