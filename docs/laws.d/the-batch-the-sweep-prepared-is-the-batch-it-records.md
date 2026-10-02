# tests/the-batch-the-sweep-prepared-is-the-batch-it-records.law.test.ts

The elimination sweep's work budget decides whether a bust pass may start
recording, and nothing else: once the reads are paid for, the prepared, ordered
batch (bounded by SWEEP_MUTATION_BATCH_SIZE) is recorded whole inside a batch
window the clock cannot close, while manager stop and the abort signal still
end it at once. The window is opened by the bust assignment pass alone, closed
with it, reset at every sweep admission, and widens no other stage; a pass that
ran past the budget reports it once with the backlog size. The movement
admission of a parked table names the door's refusal behind its label. And a
manager requests one elimination sweep when it adopts an event, on start and on
resume, after registering the scheduler.
