# The original hand submission survives a settlement refusal

The settlement listener completed its snapshot before the authoritative hand
transaction accepted the hand. A canonical database refusal could then kill the
engine with neither an active snapshot nor a durable copy of the final financial
request. The observed Spin hand 12468543 demonstrates that ordering; this change
does not reconstruct or dispose of that historical hand.

The existing hand owner now retains the complete original protocol-2 request
before dispatch. An immutable receipt identifies that request. The receipt-only
commit invokes the unchanged financial core, and snapshot completion commits
with the accepted atomic receipt. A response lost after acceptance can replay
the same request without another financial effect.

A replacement startup can continue a retained request only after a positive
canonical rollback receipt and proof of its current exact lease, unchanged
whole roster and before-stacks, original permit, and absence of later hands.
One private transaction capability permits only the two lease arguments to
change. The original financial payload remains immutable. A genuine semantic
refusal spends that one successor attempt; unknown transport never becomes a
fabricated failure. Lock, maintenance and exact lease admission refusals roll
back the claim. An already accepted receipt can finish idempotent postcommit
work and the original F06 permit under a later current owner without executing
the financial claim again.

Startup continuation takes the existing maintenance lane before lease and
lifecycle locks. Both new financial execution and accepted postcommit startup
defer while frozen. This does not change independent in-flight settlement APIs.
The existing cash crash-recovery and tournament admission paths invoke the new
owner before their prior cleanup or unresolved-permit gate; pending or unknown
outcomes prevent a new deal. Lifecycle, retirement custody and lease checks
remain in place before and after the awaited request.

The journal and disposition receipts are private, immutable on update, delete
and truncate, and have no hot-table foreign keys. A unique table/hand fence
serializes retention against incompatible snapshot completion or no-start
disposition, including stale transaction snapshots. No park is cleared and no
original permit generation is rewritten. Existing financial formulas and
financial-core bodies are preserved.

Validation of the final source:

- Actual PostgreSQL 17 native qualification: 50 assertions, 24 observed
  concurrency cases, three installation drift refusals, installation replay
  refusal, exact catalog/data rollback and owned-database cleanup. This includes
  actual cash and tournament public callers, immutable request replay, genuine
  canonical failure, exact and nested lease refusal, lost postcommit
  acknowledgment, third-generation completion, and maintenance in both orders.
- Existing connected server tests: 84 startup cases, 94 settlement/actual-deal
  cases and 26 original-payload cases. Server TypeScript compilation passed.
  Before-source controls failed one snapshot-order law, five original-payload
  cases and eight startup cases; restored source passes.
- Existing CI selectors: 448 cases; the required Accounting job invokes the
  native qualifier and retains its artifacts. Its joining Server Engine check
  remains unchanged. Cash's six directly reading source contracts pass after
  refreshing only the three modified workflow/selector inputs.

The fixture composes the independently captured installed no-start successor
from provider version 20260918123246 and preserves its predecessor capture.
Native input hashes bind the exact source. Cash opening rows are isolated
synthetic fixture inputs with explicit legacy funding provenance; this does not
certify current production funding or the historical Spin's recovery.

The release owner installed exact migration SHA256 `4bdbcf3f` once as provider
version `20260918124935`. Independent 12:50:04 UTC catalog readback matched all
qualified postimages, ACLs, triggers and private relations. Never replay that
migration. Required hosted checks, composed engine publication and live behavior
remain separate pending evidence; this installation alone does not deploy the
compatible engine consumer. No scheduler, repair loop, new retry
timer, timeout padding or financial reconstruction is introduced.
