# Failed downline refresh fixture owns its authoritative read

The publisher failed the unchanged retained-row downline refresh test because its expected stale message did not appear. Product and fixture bytes were unchanged from the last successful comparable publisher. The original case passed locally; the hosted timing failure is not claimed reproduced locally.

Settle initial effects, hold the record event's authority read, require the next read and active range, then hold and observe the downline read before rejecting it. Verify the previous row remains visible while pending and retain every original stale-message, retained-row and record-isolation assertion. Also require no error toast.

PR #8838 independently corrected the adjacent successful-refresh case. Preserve that merged correction exactly rather than replacing it with another implementation. The affected file passes all 35 cases. No product source, timeout, retry, skip, financial, engine, CSS or artwork changes. Successful publication and live certification remain required.
