# Horse journal progress and reader locks

The private journal reader held its SQLite catalog transaction while reading,
decompressing and hashing segment files. With DELETE journaling and the existing
250 ms busy timeout, a reader could prevent a concurrent writer from committing.
The publisher also counted retries over its whole lifetime: after two successful
recoveries, a later transient failure permanently disabled capture.

`readHand` now captures the bounded pending rows, selected event rows and their
segment metadata in one catalog snapshot, then commits before file I/O or
decompression. Immutable file hashes, record/index identity, legacy custody,
selected-hand pending refusal and the 32 MiB total decode limit still apply.
A concurrent commit cannot enter an already captured result. Pending custody
remains the custody observed by that snapshot even if the writer finishes it
before the reader decodes its copied bytes.

The publisher renews its two-replacement budget only after the complete current
batch receives an exact event-ID/digest/status ACK. Readiness and retired-writer
messages cannot renew it. Unacknowledged work still exhausts after two
replacements; conflicting receipts and uncertain writer termination still fail
closed. No quota, timeout, journal mode, scheduler or retry loop was added.

The existing suites reproduce both defects before the repair: a real second
SQLite connection fails at COMMIT with `database is locked`, and the third
independent transient episode cannot restart after two successful ACKs. After
the repair, the two affected suites pass all 116 cases, including captured
pending-state and concurrent-commit controls; the server typecheck passes.

These isolated results do not establish which error triggered the historical
live retry counters, recover previously missing capture, prove complete hand
reconciliation or establish deployment. Extended contention, queue pressure,
storage exhaustion and unavailable evidence remain explicit failures.
