# Independent financial checkpoint coordination

The observer now coordinates eight ordered top-up and insurance checkpoints,
using its own expected source, instance, actor, table, club, operation and hand
identities. It applies the pending top-up database verifier, rejects financial
changes after malformed insurance refusal, and waits for the exact hand's
durable post-commit completion. The original observation deadline cannot renew.

Financial actors expose copies of their two actual WebSocket states so the
independent observer can retain the felt alongside each fixed database read.
The checkpoint result is explicitly an observation record, never a product
certificate. Insurance conservation, felt/settlement reconciliation, canonical
cleanup, complete consumed source/role closure and outer runtime wiring are
still required. The engine replay-mirror defect must be repaired independently;
the observer does not work around it.

Validation exercises actor transport, immutable state samples, checkpoint order,
source/instance substitution, refusal mutation, persistence timeouts and wrong
settlement identities. These protocol tests use synthetic input rows and do not
claim a funded Auth/engine route run.
