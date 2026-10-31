# Downline refresh fixtures own their authoritative reads

Two consecutive publisher runs failed the unchanged downline refresh tests: one expected updated fee rows and the next expected the retained-row refresh-error message. Both tests delivered a one-shot record event without proving ownership of the authority read and subsequent downline response. The member implementation and fixture bytes were unchanged from the last successful comparable publisher. The original failing case passed locally; the hosted timing failure is not claimed reproduced locally.

Settle the initial effects, hold the event's authority read, require the next read and active range, then hold and observe its downline read before resolving or rejecting it. Both cases verify the previous row remains visible while pending and retain every original success, stale-message and record-isolation assertion. The failed-refresh case also requires no error toast.

The full affected file passes all 35 cases. No product source, timeout, retry, skip, financial, engine, CSS or artwork behavior changes. This repairs demonstrated publisher qualification blockers so the already-merged roster readiness guard can reach publication and live certification.
