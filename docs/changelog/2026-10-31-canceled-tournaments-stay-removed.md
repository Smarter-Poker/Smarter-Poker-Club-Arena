# Canceled tournaments stay removed during lobby reads

A delayed nonempty lobby read could overwrite a newer realtime cancellation,
completion, deletion, or Running status. Removal callbacks did not advance the
tournament revision, and only empty responses checked that revision.

Both the narrow first-paint read and the complete list now merge newer realtime
changes before painting. Cancellations and deletions remain removed, Running
status stays current, and unrelated rows still load during continuous updates.
No quiet interval, repeat read, timer, or polling loop supplies correctness.
Confirmed empty results, scope checks, and wide-row field preservation remain.
Only the latest change per row is retained until club scope resets, so a slower
first-paint response cannot undo the complete read's newer result.

The focused regression executes the actual page callback and read-completion
block with deferred responses. Against the original production source, eight
of eleven response-race cases failed. They cover canceled/completed/deleted
rows, Running status, asynchronous enrichment, the first-paint path, ongoing
updates, new realtime rows, and ordinary/empty/scope boundaries. Additional
checks preserve read ordering and prevent a duplicate INSERT downgrading a row.

This is client delivery only, using existing database subscriptions and APIs.
It does not perform refunds, change tournament financial state, or replace the
engine. Financial closeout and live publication are verified separately.
