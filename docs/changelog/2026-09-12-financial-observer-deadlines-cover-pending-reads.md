# Financial observer deadlines cover pending reads

The independent financial route observer previously checked its deadline only
after several awaited callbacks returned. An engine identity, fixed database
read or two-client table-state sample that never returned could hold the audit
open indefinitely. The first engine read also happened before the overall
120-second budget started.

The budget now starts before that first read. Every awaited observation is
bounded by the original deadline; the genuine-offer and durable-settlement
reads keep their shorter 5-second and 15-second limits. A timeout permanently
closes the observer, and a late callback result cannot reopen it. Bounding an
observation does not claim cancellation of the callback's underlying I/O.

Seven targeted regression cases cover stalled initial/final identity reads,
database reads, table-state samples, the two shorter persistence deadlines and
initial-read budget consumption. The combined financial observer, top-up,
insurance and actor suite passes 103 checks. These are source-level checks;
genuine funded Auth/engine journeys, felt reconciliation, source closure and
canonical cleanup remain necessary before product qualification.
