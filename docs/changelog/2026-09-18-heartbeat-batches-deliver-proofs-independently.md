# Deliver independent lease proofs before sibling batches finish

A fleet larger than 500 leases required several heartbeat requests, but the
caller waited for all of them before applying any result. A fast, exact `kept`
answer could therefore remain unapplied until its owner's previous proof expired.
Retaining the entire scope also prevented the next ordinary pass from renewing
healthy claims while one sibling transport remained unresolved.

Cash and tournament renewal now deliver each fully validated batch to its exact
captured owner immediately. The existing batch worker retains individual claims
across passes, keeps the existing four-request limit per scope, and releases each
completed batch independently. Queued work is discarded when its original
deadline or server lifecycle expires; replaced claims are checked again before
dispatch. Unresolved transports retain their claim identities until they actually
settle. No new timer, retry, or proof window is introduced.

Callbacks require the captured server lifecycle and exact engine/manager and
lease generation. Busy and unknown answers extend nothing; late replies cannot
revive expired authority. Negative answers fence the current owner immediately,
with physical retirement left to the existing pass. Tournament loss classification
still runs once before fencing, so an ordinary completion during a pending request
does not become false lease distress. The diagnostic message now states loss of
proof without asserting that another instance took over.

The no-callback aggregate service API remains compatible. A completed production
renewal pass now means dispatch and local expiry checks completed, not that every
database transport completed; only validated heartbeat outcomes prove renewal.

Validation used the real heartbeat services/parser/coordinator and current
GameServer renewal method bodies with controlled transport, clock, and owner
collaborators. Both cash and tournament regressions failed before the change,
then passed through eight later ordinary passes with a retained sibling. A
separate held-response completion case failed before the ordering correction.
The focused set passed 216 checks; after diagnostic wording and fixture type
corrections, the three affected files passed all 87 checks again and the server
compiler passed. Coverage includes four never-settling requests over 100 passes,
bounded queued identities, expired/replaced queued work, shutdown handoff,
same-ID replacement, immediate negative fencing, busy/missing/malformed answers,
and throwing consumers. These existing files run in the normal server CI shards.

This proves the source-level batch-coupling defect and its repair. It does not
attribute the entire historical recovery-event volume to that defect or claim
production improvement before the engine is deployed and observed.
