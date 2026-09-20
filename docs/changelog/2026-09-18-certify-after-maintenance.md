# Live-table certification begins after maintenance resumes gameplay

The September 18 engine release sealed successfully, but its four live-table checks ran during the scheduled break and correctly refused paused games. The existing verification job now waits, before creating its isolated account, for the same healthy engine to finish maintenance and all resume waves. The wait is read-only and bounded to ten minutes; unreadable health, changed identity, invalid progress or an expired budget fails the job. Client browser verification remains independent.

The live-hand, reconnect, identity and stalled-table assertions remain unchanged. Regression coverage pins workflow ordering, complete resume-wave observation, changed identity, failed reads and timeout boundaries. This prevents premature certification attempts; it does not restart an engine, retry a release or turn a failed gameplay check into success.
