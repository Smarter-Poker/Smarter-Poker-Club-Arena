# Resume accepted native alert queues

The production receive service subscribed and committed an accepted Codex queue
receipt, but the canonical chat remained unloaded and no original was read.
Queue insertion and desktop activation are separate transitions. The consumer
now persists a one-time wake attempt after the accepted receipt and invokes the
installed desktop's native queued-thread wake route. It preserves the same
message and operation when recovering an existing accepted pre-upgrade queue.
Uncertain queue or wake outcomes never create another message or automatic retry.

Focused regressions cover concurrent hints, accepted-queue recovery, durable
unknown/interrupted wake attempts, exact canonical URI arguments and unchanged
database-acknowledgement admission. Production completion still requires actual
canonical original reads and persisted acknowledgement.
