# Throwable Receipt Deduplication

Repeated delivery of the same receipt could create multiple animations, including after the first completed. The playback hook now retains the latest 512 accepted UUID receipts, normalizes UUID case, and deduplicates them in a pure state update. Different receipts and legacy messages without an ID remain independent. A receipt rejected by the existing receiver capacity limit is not marked played.

Table or account changes clear throwable playback, receipt history, selector state and target selection. Six behavioral tests cover approved throws, shared identity, duplicate active/completed delivery in StrictMode, distinct and legacy messages, scope changes, and a retry after capacity becomes available.

Receipt identity is not authorization. Server-bound table/target validation and an overflow queue remain separate pending work. This change does not claim those gaps are closed.
