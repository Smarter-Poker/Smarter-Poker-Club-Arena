# Unclaimed tournament parks reach their existing withdrawal transaction

A newly requested F06 park has revision zero and no custody ID. Both capacity and movement-proof withdrawal callers rejected that valid state before the shared withdrawal routine could claim its exact revision. A five-player source with only three destination seats could therefore remain parked indefinitely.

Remove the two premature custody-ID checks. The existing shared routine still acquires custody with revision CAS, proves the current manager and original dealer, refuses retained hand permits, and asks the existing database withdrawal transaction before stopping or readmitting anything. Database roster, hand-seal, generation, manifest, receipt and zero-credit checks are unchanged. Incomplete custody identities remain rejected by the RPC verifier.

Regression coverage uses the real manager, retirement-custody coordinator and RPC wrapper: five players versus three seats, null-custody movement refusal, and malformed custody rejection. The new valid null-custody cases failed before their respective caller corrections and pass afterward. Existing refusal and grace-period coverage remains intact. This change neither deploys an engine nor certifies recovery of a production table.
