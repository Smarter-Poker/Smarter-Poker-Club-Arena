# Checkpoint request timers preserve their original deadline

The full local suite failed when a native inspector request timer woke before its requested wall-clock slice elapsed. The existing transport immediately reported a request timeout; its own elapsed-time assertion correctly refused that evidence. A deterministic early-wakeup fixture reproduces the defect with the real local inspector and target: original code reports 399 ms waited for a 408 ms allowance.

The request computes its allowance and start from the same observation, retains that exact absolute expiry, and checks the clock when the timer wakes. An early wake rearms only the remainder of that same slice. It never resends a checkpoint, extends a work or cleanup budget, grants restart authority, or changes unknown/nonretryable outcomes. Response, disconnect and error paths cancel the currently owned timer. The original native scenarios and deadline assertion remain, with an added deterministic early-wakeup scenario and diagnostic elapsed values.

This is a supporting correction for the historical scoped-log reader's demonstrated full-suite blocker. Local qualification, protected delivery, actual release installation and live diagnostics remain separate evidence layers. No production checkpoint is invoked by these tests.
